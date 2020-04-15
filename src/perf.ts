// Here we do our perf marks.
import {} from '@electricui/build-rollup-config'

// We only use these in the browser so make them noop in testing
const perf =
  typeof window === 'undefined'
    ? {
        mark: () => {},
        measure: () => {},
      }
    : performance

export function mark(name: string) {
  if (__DEV__) perf.mark(name)
}

export function measure(start: string) {
  if (__DEV__) perf.measure(start, start)
}

export function measurePair(name: string, start: string, end: string) {
  if (__DEV__) perf.measure(name, start, end)
}
