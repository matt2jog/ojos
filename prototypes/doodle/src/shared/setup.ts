// Types shared by the setup window (renderer) and the main process.
import type { CalibrationReady, CalibrationStage, Observation } from './capture'

export type PermissionKind = 'camera' | 'screen' | 'audio'
export type PermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface DisplayInfo {
  id: string
  label: string
  width: number // logical points
  height: number
  scaleFactor: number
  rotationDeg: 0 | 90 | 180 | 270
  /** Recorded (encoded) viewport in pixels; gaze and calibration use these units. */
  viewportWidth: number
  viewportHeight: number
  primary: boolean
}

export interface SetupApi {
  platform(): Promise<NodeJS.Platform>
  permissions(): Promise<Record<PermissionKind, PermissionState>>
  request(kind: PermissionKind): Promise<boolean>
  relaunch(): Promise<void>
  displays(): Promise<{ displays: DisplayInfo[]; selected: string }>
  selectDisplay(id: string): Promise<void>
  /** Full-screen the setup window on a display (for calibration), or restore it with null. */
  fullscreen(displayId: string | null): Promise<void>
  finish(): Promise<void>
  prepareCalibration(): Promise<CalibrationReady>
  onCalibrationProgress(fn: (stage: CalibrationStage) => void): () => void
  calibrationClock(): Promise<number>
  onCalibrationObservation(fn: (point: Observation) => void): () => void
  stopCalibration(): void
  /** Synchronous local storage (settings, calibration profiles), backed by a file in userData. */
  store: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
}
