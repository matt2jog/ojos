import type { CalibrationGeometry, Tracker } from '@vision/calibration.mjs'

export function encodedSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1920 / width, 1080 / height)
  const even = (value: number): number => Math.max(2, 2 * Math.floor(value * scale / 2))
  return { width: even(width), height: even(height) }
}

export type Viewport = Omit<CalibrationGeometry, 'cameraId' | 'cameraWidth' | 'cameraHeight'>
export type CaptureSpec = Viewport & {
  sessionId: string
  epoch: number
  startUs: number
  mode: 'record' | 'calibrate'
  loopback: boolean
}
export type CameraGeometry = Pick<CalibrationGeometry, 'cameraId' | 'cameraWidth' | 'cameraHeight'>
export type CalibrationReady = CameraGeometry & { trackers: Tracker[] }
export type CalibrationStage = 'camera' | 'trackers' | 'secondary'
export type Frame = {
  timeUs: number
  sourceWidth: number
  sourceHeight: number
  width: number
  height: number
  jpeg: Uint8Array
}
export type AudioBlock = { timeUs: number; pcm: ArrayBuffer }
export type Interval = {
  type: 'interval.finalized'
  schema_version: 1
  session_id: string
  capture_epoch: number
  event_id: string
  source: 'live'
  start_us: number
  end_us: number
}
export type VisionExport = {
  gaze_status: 'available' | 'unavailable'
  gaze: { samples: Array<{ average_x: number | null; average_y: number | null }> }
}
export type Observation = { tracker: Tracker; timeUs: number; raw: unknown }
export type NativeLane = 'confusion' | 'model2'

export interface CaptureBridge {
  clock(): Promise<number>
  screen(frame: Frame): Promise<void>
  audio(block: AudioBlock): Promise<void>
  audioUnavailable(reason: string): void
  profiles(geometry: CalibrationGeometry): Promise<Record<string, unknown>>
  nativeReady(lane: NativeLane): Promise<void>
  nativeFrame(lane: NativeLane, packet: { timeUs: number; frameId: number; jpeg: Uint8Array }): Promise<unknown>
  calibrationProgress(stage: CalibrationStage): void
  observation(observation: Observation): void
  interval(event: Interval): void
  ended(reason: string): void
  workerError(lane: string, reason: string): void
}
