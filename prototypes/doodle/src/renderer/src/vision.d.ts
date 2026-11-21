// Types for Matt's headless vision modules in models/vision (plain .mjs).
declare module '@vision/calibration.mjs' {
  export type Tracker = 'model1' | 'model2'

  export interface CalibrationGeometry {
    cameraId: string
    cameraWidth: number
    cameraHeight: number
    displayId: string
    displayScale: number
    rotationDeg: 0 | 90 | 180 | 270
    viewportWidth: number
    viewportHeight: number
  }

  export interface Target {
    id: string
    point: [number, number] // normalized 0-1 over the selected display
  }

  export interface FitMetrics {
    frames: number
    validFrames: number
    coverage: number
    effectiveHz: number
    validHz: number
    usable?: number
    total?: number
    medianErrorPx?: number | null
    uncertaintyRadiusPx?: number | null
    thresholdPx?: number
    passed?: boolean
  }

  export interface FitResult {
    calibration: unknown | null
    metrics: FitMetrics
    reason?: 'missing_fit_target' | 'validation_failed'
  }

  export interface Storage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }

  export class EnsembleCalibration {
    constructor(geometry: CalibrationGeometry)
    readonly nextTarget: Target | null
    showTarget(shownUs: number): Target & { collectFromUs: number; collectUntilUs: number }
    observe(tracker: Tracker, timeUs: number, raw: unknown): void
    finishTarget(nowUs: number): Record<Tracker, { id: string; frames: number; validFrames: number }>
    fit(): Record<Tracker, FitResult>
  }

  export function saveTrackerProfile(storage: Storage, tracker: Tracker, geometry: CalibrationGeometry, profile: unknown): void
  export function loadTrackerProfile(storage: Storage, tracker: Tracker, geometry: CalibrationGeometry): unknown | null
}

declare module '@vision/index.mjs' {
  import type { CalibrationGeometry, Tracker } from '@vision/calibration.mjs'
  import type { Interval, VisionExport } from '../../shared/capture'
  type Packet = { frame: VideoFrame; timeUs: number; frameId: number }
  type WorkerConfig = { geometry: CalibrationGeometry; sessionId: string; captureEpoch: number; assetsBaseUrl: string }
  export function connectWebEyeTrack(worker: Worker, config: WorkerConfig): {
    ready: Promise<unknown>
    send(packet: Packet): Promise<unknown>
    close(): void
  }
  export class VisionSession {
    constructor(config: Omit<WorkerConfig, 'assetsBaseUrl'> & {
      profiles: Record<string, unknown>
      workers: Record<string, (packet: Packet) => Promise<unknown>>
      clockUs(): number
      onInterval(event: Interval): void
      onObservation(tracker: Tracker, timeUs: number, raw: unknown): void
      onError(error: Error, lane: string): void
    })
    submit(frame: VideoFrame, timeUs: number, frameId: number): void
    exportClip(startUs: number, endUs: number): VisionExport
  }
}

declare module '@vision/series.mjs' {
  import type { VisionExport } from '../../shared/capture'
  export function exportVisionSeries(config: {
    sessionId: string; captureEpoch: number; clipStartUs: number; clipEndUs: number; width: number; height: number
  }): VisionExport
}
