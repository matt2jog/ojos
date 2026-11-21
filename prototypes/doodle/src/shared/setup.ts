// Types shared by the setup window (renderer) and the main process.
import type { CalibrationReady, CalibrationStage, Observation } from './capture'

export type PermissionKind = 'camera' | 'screen' | 'audio'
export type PermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export const TRIGGER_RANGE = { min: 0.65, max: 0.95, default: 0.8 } as const

export function clampTriggerHigh(value: number): number {
  return Math.min(TRIGGER_RANGE.max, Math.max(TRIGGER_RANGE.min, value))
}

export interface CaptureStatus {
  recording: boolean
  camera: boolean
  calibration: boolean | null
  confusion: 'running' | 'starting' | 'unavailable' | 'stopped'
}

export interface AppSettings extends CaptureStatus {
  sensitivity: number
  screenPermission: PermissionState
  clipAssistant: 'local' | 'remote' | 'unconfigured'
  chatConfigured: boolean
}

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
  settings(): Promise<AppSettings>
  setSensitivity(high: number): Promise<void>
  closeSettings(): Promise<void>
  settingsSetup(view: 'calibrate' | 'welcome'): Promise<void>
  prepareCalibration(): Promise<CalibrationReady>
  onCalibrationProgress(fn: (stage: CalibrationStage) => void): () => void
  calibrationClock(): Promise<number>
  onCalibrationObservation(fn: (point: Observation) => void): () => void
  stopCalibration(): void
  /** Synchronous local storage (settings, calibration profiles), backed by a file in userData. */
  store: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
}
