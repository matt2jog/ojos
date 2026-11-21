// Where calibration observations come from.
//
// LIVE (Matt's laptop): VisionSession's onObservation(tracker, timeUs, raw) feeds calibration
// directly — WebEyeTrack (model1) in a renderer worker, ETH-XGaze (model2) via native_worker.py.
// SIMULATED (any machine without the model assets): the mouse pointer stands in for the eyes,
// producing raw rows with the same shapes ({wet: 7 numbers} / {plane: [x, y]}) so the real
// EnsembleCalibration fit, validation and profile saving all run unchanged.
import type { Tracker } from '@vision/calibration.mjs'

export type Observe = (tracker: Tracker, timeUs: number, raw: unknown) => void

export interface GazeSource {
  kind: 'live' | 'simulated'
  label: string
  start(onObservation: Observe): void
  stop(): void
}

/** Shared session clock (same origin in every window), in integer microseconds. */
export const nowUs = (): number =>
  Math.round((performance.timeOrigin + performance.now() - window.vision.epochMs()) * 1000)

/** Real eyes: raw observations relayed from the hidden vision window's VisionSession. */
export function liveGaze(): GazeSource {
  let off: (() => void) | null = null
  return {
    kind: 'live',
    label: 'Live eye tracking',
    start(observe) {
      off = window.vision.onObservation((tracker, timeUs, raw) => {
        if (tracker === 'model1' || tracker === 'model2') observe(tracker, timeUs, raw)
      })
    },
    stop() {
      off?.()
      off = null
    }
  }
}

export function simulatedGaze(opts: { autopilot?: () => [number, number] | null } = {}): GazeSource {
  let pointer: [number, number] = [0.5, 0.5]
  const timers: number[] = []
  const onMove = (e: MouseEvent): void => {
    pointer = [e.clientX / innerWidth, e.clientY / innerHeight]
  }
  const noise = (s: number): number => (Math.random() - 0.5) * 2 * s
  const where = (): [number, number] => opts.autopilot?.() ?? pointer

  return {
    kind: 'simulated',
    label: 'Simulated eyes: follow the dots with your mouse',
    start(observe) {
      addEventListener('mousemove', onMove)
      // model1 ~15 Hz: 7-feature row, roughly linear in the gaze point (like iris offsets + pose)
      timers.push(
        window.setInterval(() => {
          const [x, y] = where()
          observe('model1', nowUs() - 40_000, {
            wet: [x + noise(0.01), y + noise(0.01), 0.8 * x + noise(0.01), 0.8 * y + noise(0.01), noise(0.02), noise(0.02), noise(0.02)]
          })
        }, 1000 / 15)
      )
      // model2 ~5 Hz: camera-plane point
      timers.push(
        window.setInterval(() => {
          const [x, y] = where()
          observe('model2', nowUs() - 75_000, { plane: [2 * x - 1 + noise(0.02), 2 * y - 1 + noise(0.02)] })
        }, 1000 / 5)
      )
    },
    stop() {
      removeEventListener('mousemove', onMove)
      timers.splice(0).forEach((t) => clearInterval(t))
    }
  }
}

/** Live when the eye model is running in the vision window; simulated (mouse) otherwise. */
export function pickGazeSource(opts: { live: boolean; autopilot?: () => [number, number] | null }): GazeSource {
  return opts.live && !opts.autopilot ? liveGaze() : simulatedGaze(opts)
}
