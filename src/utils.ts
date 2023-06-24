/**
 * Returns the average of a list of numbers
 */
export function mean(values: Array<number>) {
  if (values.length === 0) {
    return 0
  }

  let sum = 0

  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    sum += value
  }

  return sum / values.length
}

/**
 * Returns the standard deviation of a list of numbers
 */
export function averageAbsoluteDeviation(values: Array<number>) {
  if (values.length === 0) {
    return 0
  }

  const avg = mean(values)

  let sum = 0

  for (let index = 0; index < values.length; index++) {
    sum += Math.abs(avg - values[index])
  }

  return sum / values.length
}