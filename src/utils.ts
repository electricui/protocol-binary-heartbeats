export function average(values: Array<number>) {
  const sum = values.reduce((sum, value) => sum + value, 0)

  return sum / values.length
}

export function standardDeviation(values: Array<number>) {
  const avg = average(values)

  const squareDiffs = values.map(value => (value - avg) ** 2)

  return Math.sqrt(average(squareDiffs))
}
