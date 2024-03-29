import { ConnectionMetadataReporter, Message } from '@electricui/core'
import { CancellationToken } from '@electricui/async-utilities'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { mean, averageAbsoluteDeviation } from './utils'
import { mark, measure } from './perf'

import { timing } from '@electricui/timing'

const dHeartbeats = require('debug')('electricui-protocol-binary:heartbeats')

interface HeartbeatConnectionMetadataReporterOptions {
  /**
   * What interval should the device be polled at for a heartbeat response, by default 500ms.
   */
  interval?: number
  /**
   * How long to wait before the heartbeat is considered lost, by default 2000ms
   */
  timeout?: number
  /**
   * How many heartbeats to keep in memory at a time for metadata statistics, by default 20
   */
  maxHeartbeats?: number
  /**
   * If true, the heartbeat time is measured from being sent to the OS buffer.
   * If false, the heartbeat time is measured from the flush event provided by the OS.
   *
   * By default it is measured from the flush
   */
  measurePipeline?: boolean
  /**
   * What messageID is the heartbeat on. By default the binary protocol messageID.
   */
  heartbeatMessageID?: string
  /**
   * The exponential backoff startup request sequence. By default a packet is sent at each of these intervals.
   *
   * [0, 10, 100, 1000]
   *
   * Any success during this period releases the connection into a 'CONNECTED' state.
   * Failures are ignored until the last packet times out.
   */
  startupSequence?: number[]
}

class HeartbeatMeasurement {
  sentTime: number | null = null
  ackTime: number | null = null
  failed: boolean = false
  cancellationToken: CancellationToken

  constructor(cancellationToken: CancellationToken) {
    this.cancellationToken = cancellationToken
  }
}

export const AUDIT_LOG_HEARTBEAT_CONNECTION_METADATA_REPORTER = 'heartbeat-metadata-reporter'

export enum HEARTBEAT_CONNECTION_AUDIT_EVENTS {
  STARTUP_MODE = 'startup-mode',
  STARTUP_ATTEMPT = 'startup-attempt',
  CONSECUTIVE_RUN = 'consecutive-run',
}

export class HeartbeatConnectionMetadataReporter extends ConnectionMetadataReporter {
  getIdentifier() {
    return 'heartbeat-metadata-reporter' as const
  }

  metadataKeys = ['latency', 'packetLoss', 'jitter', 'consecutiveHeartbeats']
  intervalDelay: number
  timeout: number
  maxHeartbeats: number
  counter: number = 0
  heartbeatMessageID: string
  interval: NodeJS.Timer | null = null
  heartbeats: Array<HeartbeatMeasurement> = []
  measurePipeline: boolean
  startupSequence: number[]
  inStartup = true
  startupAttemptIndex = 0
  startupProcedureTimeoutPromise: Promise<void> | null = null
  startupProcedureTimeoutResolution: (() => void) | null = null
  startupProcedureTimeoutHandler: NodeJS.Timeout | null = null

  // For marking the audit log
  private consecutiveHeartbeatBeginningTime: number | null = null

  constructor(options: HeartbeatConnectionMetadataReporterOptions) {
    super()
    this.intervalDelay = options.interval || 500
    this.timeout = options.timeout || 2000
    this.maxHeartbeats = options.maxHeartbeats || Math.max((this.timeout * 5) / this.intervalDelay, 20)
    this.heartbeatMessageID = options.heartbeatMessageID || MESSAGEIDS.HEARTBEAT

    this.measurePipeline = options.measurePipeline || false

    this.tick = this.tick.bind(this)
    this.report = this.report.bind(this)
    this.ping = this.ping.bind(this)
    this.getTime = this.getTime.bind(this)

    // If intervalDelay < timeout / maxHeartbeats, we need to error

    // maxHeartbeats = timeout / interval * 2

    if (this.maxHeartbeats < this.timeout / this.intervalDelay) {
      throw new Error(
        "HeartbeatConnectionMetadataReporter maxHeartbeats isn't large enough to hold heartbeats long enough for them to fail",
      )
    }

    if (this.intervalDelay < 5) {
      throw new Error(
        "HeartbeatConnectionMetadataReporter intervalDelay can't be below 5ms. (To avoid link saturation, that's not to say that 6ms is fine)",
      )
    }

    // Build our exponential backoff profile
    this.startupSequence = options.startupSequence ?? [0, 1000]
  }

  /**
   * Returns high accuracy time in milliseconds
   */
  getTime() {
    return timing.now()
  }

  generateCancellableStartupTimeout = () => {
    this.startupProcedureTimeoutPromise = new Promise((resolve, reject) => {
      this.startupProcedureTimeoutResolution = resolve
      this.startupProcedureTimeoutHandler = setTimeout(() => {
        this.leaveStartupMode(false)
      }, this.timeout)
    })

    return this.startupProcedureTimeoutPromise
  }

  leaveStartupMode = (success: boolean) => {
    dHeartbeats(
      `${success ? 'successfully' : 'unsuccessfully'} leaving startup mode before the ${
        this.startupAttemptIndex
      }th attempt.`,
    )

    // leave startup
    this.inStartup = false
    // if we have a timeout handler, cancel it
    if (this.startupProcedureTimeoutHandler) {
      clearTimeout(this.startupProcedureTimeoutHandler)
    }
    // if the promise is active, resolve it
    if (this.startupProcedureTimeoutResolution) {
      this.startupProcedureTimeoutResolution()
    }

    // clear all heartbeat records except for the last one.
    this.heartbeats = this.heartbeats.slice(-1)
  }

  startupAttemptToHeartbeatNumber = (startupAttemptIndex: number) => {
    return startupAttemptIndex + 1
  }

  raceStartupProcedureAgainstTimeout = (amount: number) => {
    let timeout: NodeJS.Timeout | null = null

    const timeoutPromise = new Promise((res, rej) => {
      timeout = setTimeout(res, amount)
    })

    if (!this.startupProcedureTimeoutPromise) {
      console.warn()
      return timeoutPromise
    }

    return Promise.race([
      this.startupProcedureTimeoutPromise.then(() => {
        dHeartbeats(`Bailing out of wait loop early`)
        if (timeout) {
          clearTimeout(timeout)
        }
      }),
      timeoutPromise,
    ])
  }

  async onConnect() {
    // Reset all information
    this.inStartup = true
    this.startupAttemptIndex = 0

    // Clear any heartbeats in the buffer
    this.heartbeats = []

    // Stop interval based reporting
    if (this.interval) {
      clearInterval(this.interval)
    }

    dHeartbeats('Starting heartbeats')

    // Generate it now so that it can be cancelled later
    const cancellableStartupTimeout = this.generateCancellableStartupTimeout()

    // If we're iterating through the startup procedure
    // While LESS THAN the COUNT => while the ID will be valid
    while (this.startupAttemptIndex < this.startupSequence.length && this.inStartup) {
      mark(`heartbeat-attempt-${this.startupAttemptIndex}`)

      const waitTime = this.startupSequence[this.startupAttemptIndex]

      dHeartbeats(
        `Waiting ${waitTime}ms for heartbeat ping #${this.startupAttemptToHeartbeatNumber(this.startupAttemptIndex)}`,
      )

      // block for the requisite time, unless we're resolved quicker
      await this.raceStartupProcedureAgainstTimeout(this.startupSequence[this.startupAttemptIndex])

      // If we've left startup mode by now, just break
      if (!this.inStartup) {
        measure(`heartbeat-attempt-${this.startupAttemptIndex}`)
        break
      }

      dHeartbeats(
        `Sending startup heartbeat ping #${this.startupAttemptToHeartbeatNumber(this.startupAttemptIndex)} of ${
          this.startupSequence.length
        }`,
      )

      // send off a ping
      this.ping()

      measure(`heartbeat-attempt-${this.startupAttemptIndex}`)

      // Iterate the index
      this.startupAttemptIndex++
    }

    // If we've exhausted them
    if (this.inStartup) {
      dHeartbeats(
        `Exhausted startup window after ${this.startupAttemptIndex} attempts, waiting for the last heartbeat to timeout`,
      )

      // Wait for us to leave startup, either by timeout failure or by success
      mark(`heartbeat-waiting-on-timeout`)
      await cancellableStartupTimeout
      mark(`heartbeat-waiting-on-timeout`)
    } else {
      dHeartbeats(`Left startup window while loop`)
    }

    // We have left startup

    // Setup our regular interval
    this.interval = setInterval(this.tick, this.intervalDelay)

    dHeartbeats(`Sending first heartbeat report`)

    // Process the metadata, send the first latency reading
    this.report()

    dHeartbeats(`Connection is probably in CONNECTED state`)
  }

  async onDisconnect() {
    dHeartbeats('Stopping heartbeats')

    // cleanup intervals
    if (this.interval) {
      clearInterval(this.interval)
    }

    // Clear the array
    this.heartbeats = []
  }

  tick() {
    // Send new heartbeats
    this.ping()

    // Update the reporting
    this.report()
  }

  ping() {
    const connection = this.connectionInterface!.connection!

    // Iterate the counter
    this.counter += 1

    // Don't let it go
    if (this.counter > 255) {
      this.counter = 1
    }

    // Grab our payload, hold the primitive in this stack frame so when
    // we check it later it doesn't change underneath us.
    const payload = this.counter

    // Our cancellation token
    const cancellationToken = new CancellationToken()
    cancellationToken.deadline(this.timeout)

    // Produce a wait for reply handler
    const waitForReply = connection.waitForReply((replyMessage: Message) => {
      // wait for a reply with the same messageID and payload
      return (
        replyMessage.messageID === this.heartbeatMessageID &&
        replyMessage.metadata.internal === true &&
        replyMessage.payload === payload
      )
    }, cancellationToken)

    const message = new Message(this.heartbeatMessageID, payload)
    message.metadata.internal = true
    message.metadata.type = TYPES.UINT8
    message.metadata.query = true
    message.metadata.ack = false

    const heartbeat = new HeartbeatMeasurement(cancellationToken)

    // Add this heartbeat to the list
    this.heartbeats.push(heartbeat)

    // If there are more than this.maxHeartbeats heartbeats, remove the earliest one
    if (this.heartbeats.length > this.maxHeartbeats) {
      this.heartbeats.shift() // remove the first heartbeat
    }

    dHeartbeats(`Writing heartbeat #${payload}`)

    // if we're not measuring from the exit, record the time now
    if (this.measurePipeline) {
      const sentTime = this.getTime()

      dHeartbeats(`Written heartbeat #${payload}`)

      // Add the sent time to the measurement
      heartbeat.sentTime = sentTime
    }

    // Write to the device, and record exactly when the packet goes out
    connection
      .write(message, cancellationToken)
      .then(res => {
        // If we're measuring from the exit, measure from now
        if (!this.measurePipeline) {
          // When this is called, the write has been flushed.
          const sentTime = this.getTime()

          dHeartbeats(`Written heartbeat #${payload}`)

          // Add the sent time to the measurement
          heartbeat.sentTime = sentTime
        }
      })
      .catch(err => {
        // On failure, mark this as failed
        heartbeat.failed = true

        dHeartbeats(`Failed to write heartbeat #${payload}`)
      })

    // Wait for the reply then annotate the measurement with the new time
    // Return this promise in case the developer needs to know when the first heartbeat has been completed
    return waitForReply
      .then(res => {
        const ackTime = this.getTime()

        dHeartbeats(`Received heartbeat #${payload}`)

        // Add the received time to the measurement
        heartbeat.ackTime = ackTime

        // We're no longer in startup if we received a packet back
        if (this.inStartup) {
          this.leaveStartupMode(true)
        }

        // If we don't have a beginning of a good run, it's now
        if (!this.consecutiveHeartbeatBeginningTime) {
          this.consecutiveHeartbeatBeginningTime = heartbeat.sentTime
        }
      })
      .catch(err => {
        // Heartbeat failure
        heartbeat.failed = true
        if (cancellationToken.caused(err)) {
          dHeartbeats(`Timing out heartbeat #${payload}`)

          // If this is the first failure, establish
          if (this.consecutiveHeartbeatBeginningTime) {
            const start = this.consecutiveHeartbeatBeginningTime
            const end = this.getTime()

            // Insert the duration of good heart beats

            this.consecutiveHeartbeatBeginningTime = null
          }
        }
      })
  }

  report() {
    const heartbeatsSent = this.heartbeats.filter(heartbeat => heartbeat.sentTime !== null)
    const heartbeatsSucceeded = heartbeatsSent.filter(heartbeat => heartbeat.ackTime !== null && !heartbeat.failed)
    const heartbeatsFailed = heartbeatsSent.filter(heartbeat => heartbeat.failed)

    /**
     * Consecutive heartbeat count
     * Below are a series of examples and the intended result
     *
     * [+ + + +] = 4
     * [+ + + -] = 0
     * [- - - -] = 0
     * [- + + +] = 3
     * [- - + +] = 2
     * [+ + - +] = 0 // one heartbeat is not a consecutive heartbeat
     *
     */
    let consecutiveSucessess = heartbeatsSent.reduce((accumulator, heartbeat) => {
      // if this heartbeat succeeded, then we add 1 to the accumulator
      if (heartbeat.ackTime !== null && !heartbeat.failed) {
        return accumulator + 1
      }

      // in any other case, we reset the counter to 0
      return 0
    }, 0)

    // If there is only one heartbeat that succeeded, there have been 0 _consecutive_ heartbeats
    if (consecutiveSucessess === 1) {
      consecutiveSucessess = 0
    }

    if (heartbeatsSucceeded.length === 0) {
      // No heartbeats have succeeded yet, so nothing to report on yet.

      dHeartbeats('No heartbeats have succeeded yet. Bailing out of calculations')
      return
    }

    // const now = this.getTime()

    // If the heartbeat has been sent but not received, the latency is the
    // current amount of time passed since the packet was set
    const latencies = heartbeatsSucceeded.map(heartbeat => {
      /*
      if (!heartbeat.ackTime) {
        dHeartbeats(
          "The heartbeat hasn't arrived back yet, so calculate how long it's been",
        )

        return Math.max(now - heartbeat.sentTime!, 0)
      }
      */
      return Math.max(heartbeat.ackTime! - heartbeat.sentTime!, 0)
    })

    const connection = this.connectionInterface!.connection!

    const latency = mean(latencies)
    const packetLoss = heartbeatsFailed.length / heartbeatsSent.length
    const jitter = averageAbsoluteDeviation(latencies)

    dHeartbeats(`Heartbeats sent: ${heartbeatsSent.length}`)
    dHeartbeats(`Heartbeat latency: ${latency}`)
    dHeartbeats(`Heartbeat packetLoss: ${packetLoss}`)
    dHeartbeats(`Heartbeat jitter (AAD): ${jitter}`)
    dHeartbeats(`Consecutive heartbeats: ${consecutiveSucessess}`)

    connection.reportConnectionMetadata('latency', latency)
    connection.reportConnectionMetadata('packetLoss', packetLoss)
    connection.reportConnectionMetadata('jitter', jitter)
    connection.reportConnectionMetadata('consecutiveHeartbeats', consecutiveSucessess) // prettier-ignore
  }
}
