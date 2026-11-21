// Types shared by the hidden vision window, the setup window and the main process.

/** Gaze on the selected display, 0-1000 on each axis, origin top-left. */
export type LiveGaze = { x: number; y: number }

export type LaneState = 'off' | 'starting' | 'on' | 'error'

export interface VisionStatus {
  camera: 'starting' | 'on' | 'denied' | 'error'
  confusion: LaneState
  model1: LaneState
  /** true once model1 has a saved calibration profile for the current geometry */
  calibrated?: boolean
  detail?: string
}

export interface VisionGeometry {
  cameraId: string
  cameraWidth: number
  cameraHeight: number
  displayId: string
  displayScale: number
  rotationDeg: 0 | 90 | 180 | 270
  viewportWidth: number
  viewportHeight: number
}

export interface VisionConfig {
  sessionId: string
  captureEpoch: number
  /** Wall-clock origin of the shared session clock */
  epochMs: number
  display: Pick<VisionGeometry, 'displayId' | 'displayScale' | 'rotationDeg' | 'viewportWidth' | 'viewportHeight'>
  workers: { confusion: boolean; model1: boolean }
  /** Onset trigger: smoothed confusion score at or above `high` for `confirmMs`. */
  trigger: { high: number; confirmMs: number }
}

export interface VisionApi {
  /** Shared session clock origin (ms since Unix epoch), same in every window. */
  epochMs(): number
  config(): Promise<VisionConfig>
  confusion(jpeg: Uint8Array, timeUs: number, frameId: number): Promise<unknown>
  reportCamera(g: Pick<VisionGeometry, 'cameraId' | 'cameraWidth' | 'cameraHeight'>): void
  reportStatus(s: VisionStatus): void
  reportObservation(tracker: string, timeUs: number, raw: unknown): void
  reportGaze(gaze: LiveGaze | null, confusionScore: number | null): void
  reportInterval(gaze: LiveGaze | null, score: number): void
  /** Full geometry for calibration (camera from the vision window + selected display), or null if vision is off. */
  geometry(): Promise<VisionGeometry | null>
  status(): Promise<VisionStatus | null>
  reload(): Promise<void>
  onReload(fn: () => void): () => void
  onStatus(fn: (s: VisionStatus) => void): () => void
  onObservation(fn: (tracker: string, timeUs: number, raw: unknown) => void): () => void
}
