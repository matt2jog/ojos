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

declare module '@vision/calibration.mjs' {
  export interface GazeMessage {
    time_us: number
    x_px: number | null
    y_px: number | null
    uncertainty_radius_px: number | null
    valid: boolean
  }
  export function createGazeProjector(opts: {
    tracker: Tracker
    geometry: CalibrationGeometry
    profile: unknown | null
    sessionId: string
    captureEpoch: number
  }): (timeUs: number, raw: unknown) => GazeMessage
}

declare module '@vision/session.mjs' {
  import type { CalibrationGeometry, Tracker } from '@vision/calibration.mjs'
  export interface Packet {
    frame: VideoFrame
    timeUs: number
    frameId: number
  }
  export interface ConfusionSample {
    time_us: number
    valid: boolean
    confidence: number | null
    confidence_raw: number | null
    quality?: string
  }
  export interface IntervalEvent {
    start_us: number
    end_us: number
    score: number
  }
  export class VisionSession {
    constructor(opts: {
      sessionId: string
      captureEpoch: number
      geometry: CalibrationGeometry
      profiles?: Partial<Record<Tracker, unknown>>
      workers: Partial<Record<Tracker | 'confusion', (packet: Packet) => Promise<unknown>>>
      clockUs: () => number
      onInterval?: (event: IntervalEvent, publishedUs: number) => void
      onObservation?: (tracker: Tracker, timeUs: number, raw: unknown) => void
      onError?: (error: Error, lane: string) => void
      rates?: Record<string, number>
    })
    submit(frame: VideoFrame, timeUs: number, frameId: number): void
    exportClip(clipStartUs: number, clipEndUs: number): { gaze_status: string; gaze: unknown }
    stats(): Record<string, { rate: number; offered: number; dropped: number; delivered: number; late: number; failed: number }>
    close(): void
  }
}

declare module '@vision/webeyetrack.mjs' {
  import type { CalibrationGeometry } from '@vision/calibration.mjs'
  export function connectWebEyeTrack(
    worker: Worker,
    opts: { geometry: CalibrationGeometry; sessionId: string; captureEpoch: number; assetsBaseUrl?: string }
  ): { ready: Promise<unknown>; send(packet: { frame: VideoFrame; timeUs: number }): Promise<unknown>; close(): void }
}
