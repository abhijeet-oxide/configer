// Critically damped spring. Response is seconds, in Apple's sense: how quickly
// the value reaches the target, not a fixed duration. Damping ratio is 1, so
// the motion does not bounce. The closed form is exact from the current value
// and velocity, which is what lets a second input reverse it mid-flight.

export const SPRING_RESPONSE = 0.35

export function stepCritical(
  value: number,
  velocity: number,
  target: number,
  dt: number,
  response = SPRING_RESPONSE,
): { value: number; velocity: number } {
  if (!(dt > 0)) return { value, velocity }
  const omega = (2 * Math.PI) / response
  const x0 = value - target
  const decay = Math.exp(-omega * dt)
  const b = velocity + omega * x0
  const next = x0 + b * dt
  return {
    value: target + next * decay,
    velocity: (b - omega * next) * decay,
  }
}
