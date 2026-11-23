import type { Observation } from '../../../shared/capture'

export const nowUs = (): number => Math.round(performance.now() * 1000)

export async function observeGaze(observe: (point: Observation) => void): Promise<() => void> {
  let offset = 0
  let shortest = Infinity
  for (let i = 0; i < 5; i++) {
    const before = nowUs()
    const remote = await window.setup.calibrationClock()
    const after = nowUs()
    if (after - before < shortest) {
      shortest = after - before
      offset = Math.round((before + after) / 2 - remote)
    }
  }
  return window.setup.onCalibrationObservation((point) => observe({ ...point, timeUs: point.timeUs + offset }))
}
