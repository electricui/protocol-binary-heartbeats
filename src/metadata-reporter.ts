import { ConnectionMetadataReporter, Message } from '@electricui/core'
import { MESSAGEIDS } from '@electricui/protocol-binary-constants'

import { average, standardDeviation } from './utils'

const dHeartbeats = require('debug')('electricui-protocol-binary:heartbeats')

interface HeartbeatConnectionMetadataReporterOptions {
  interval?: number
  timeout?: number
  maxHeartbeats?: number
  measurePipeline?: boolean
  heartbeatMessageID?: string
}

class HeartbeatMeasurement {
  sentTime: number | null = null
  ackTime: number | null = null
  failed: boolean = false
  cancelWaitForReply: () => void

  constructor(cancelWaitForReply: () => void) {
    this.cancelWaitForReply = cancelWaitForReply
  }
}

export class HeartbeatConnectionMetadataReporter extends ConnectionMetadataReporter {
  metadataKeys = ['latency', 'packet-loss', 'jitter']
  intervalDelay: number
  timeout: number
  maxHeartbeats: number
  counter: number = 0
  heartbeatMessageID: string
  interval: NodeJS.Timer | null = null
  heartbeats: Array<HeartbeatMeasurement> = []
  measurePipeline: boolean

  constructor(options: HeartbeatConnectionMetadataReporterOptions) {
    super()
    this.intervalDelay = options.interval || 500
    this.timeout = options.timeout || 2000
    this.maxHeartbeats = options.maxHeartbeats || 20
    this.heartbeatMessageID = options.heartbeatMessageID || MESSAGEIDS.HEARTBEAT

    this.measurePipeline = options.measurePipeline || false

    this.tick = this.tick.bind(this)
    this.report = this.report.bind(this)
    this.ping = this.ping.bind(this)
    this.getTime = this.getTime.bind(this)
  }

  /**
   * Returns high accuracy time in milliseconds
   */
  getTime() {
    const hr = process.hrtime()
    return hr[0] * 1000 + hr[1] / 1000000
  }

  async onConnect() {
    // setup what we have to, do at least one ping to figure out
    this.interval = setInterval(this.tick, this.intervalDelay)

    dHeartbeats('Starting heartbeats')

    // Send a single heartbeat and wait for it to return.
    await this.ping()

    dHeartbeats('First heartbeat complete')

    // Process the metadata, send the first latency reading
    this.report()
  }

  async onDisconnect() {
    // cleanup intervals
    if (this.interval) {
      clearInterval(this.interval)
    }

    // Clear the array
    this.heartbeats = []
  }

  ping() {
    const connection = this.connectionInterface!.connection!

    // Iterate the counter
    this.counter += 1

    // Don't let it go
    if (this.counter > 255) {
      this.counter = 1
    }

    // Grab our payload, hold the primative in this stack frame so when
    // we check it later it doesn't change underneath us.
    const payload = this.counter

    // Produce a wait for reply handler
    const {
      promise: waitForReply,
      cancel: cancelWaitForReply,
    } = connection.waitForReply((replyMessage: Message) => {
      // wait for a reply with the same messageID and payload
      return (
        replyMessage.messageID === this.heartbeatMessageID &&
        replyMessage.metadata.internal === true &&
        replyMessage.payload === payload
      )
    }, this.timeout)

    const message = new Message(this.heartbeatMessageID, payload)
    message.metadata.internal = true
    message.metadata.query = true

    const cancelHandler = () => {
      cancelWaitForReply()
    }

    const heartbeat = new HeartbeatMeasurement(cancelHandler)

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
      .write(message)
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
      })
      .catch(err => {
        // On failure, mark this as failed
        heartbeat.failed = true

        dHeartbeats(`Timing out heartbeat #${payload}`)
      })
  }

  tick() {
    // Send new heartbeats
    this.ping()

    // Update the reporting
    this.report()
  }

  report() {
    const heartbeatsSent = this.heartbeats.filter(
      heartbeat => heartbeat.sentTime !== null,
    )
    const heartbeatsSucceeded = heartbeatsSent.filter(
      heartbeat => heartbeat.ackTime !== null && !heartbeat.failed,
    )
    const heartbeatsFailed = heartbeatsSent.filter(
      heartbeat => heartbeat.failed,
    )

    if (heartbeatsSucceeded.length === 0) {
      // No heartbeats have succeeded yet, so nothing to report on yet.

      dHeartbeats(
        'No heartbeats have succeeded yet. Bailing out of calculations',
      )
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

    const latency = average(latencies)
    const packetLoss = heartbeatsFailed.length / heartbeatsSent.length
    const jitter = standardDeviation(latencies)

    dHeartbeats(`Heartbeats sent: ${heartbeatsSent.length}`)
    dHeartbeats(`Heartbeat latency: ${latency}`)
    dHeartbeats(`Heartbeat packet-loss: ${packetLoss}`)
    dHeartbeats(`Heartbeat jitter: ${jitter}`)

    connection.reportConnectionMetadata('latency', latency)
    connection.reportConnectionMetadata('packet-loss', packetLoss)
    connection.reportConnectionMetadata('jitter', jitter)
  }
}
