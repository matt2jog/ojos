declare module '@assistant' {
  export function analyzeBundle(options: {
    manifest: unknown; gaze: unknown; video: Uint8Array; token: string; baseUrl: string; cloud?: boolean; signal: AbortSignal
  }): Promise<{ suspected_confusion: string; possible_questions: string[]; summary: string }>
}

declare module '@recorder' {
  import type { Frame, AudioBlock } from '../shared/capture'
  type Manifest = {
    capture_epoch: number; clip_start_us: number; clip_end_us: number; event_end_us: number
    gaze_status: 'available' | 'unavailable'
  }
  type Clip = {
    manifest: Manifest
    frames: Array<{ timeUs: number; jpeg: Buffer }>
    audio: Array<{ timeUs: number; pcm: Buffer }>
    gaze: unknown
  }
  export class Recorder {
    epoch: number
    start(captureEpoch?: number): string
    stop(): void
    addFrame(frame: Frame & { sessionId: string }): { captureEpoch: number } | undefined
    addAudio(block: AudioBlock & { sessionId: string }): void
    manual(nowUs: number): Clip
    interval(event: object, nowUs: number): Clip
  }
  export function writeBundle(clip: Clip, parent: string, options: { signal: AbortSignal }): Promise<string>
}

declare module '*?url' {
  const url: string
  export default url
}
