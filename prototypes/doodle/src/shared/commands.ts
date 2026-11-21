// The drawing contract: what the backend (Gemini) streams to the desktop overlay.
// One JSON object per line. Coordinates are normalized 0-1000 over the captured screen, origin top-left.

export type Point = [number, number]
export type Box = [number, number, number, number] // x1, y1, x2, y2
export type Color = 'red' | 'blue' | 'green' | 'yellow'

export type DrawCmd =
  | { draw: 'circle'; box: Box; color?: Color }
  | { draw: 'underline'; from: Point; to: Point; color?: Color }
  | { draw: 'arrow'; from: Point; to: Point; color?: Color }
  | { draw: 'highlight'; box: Box; color?: Color }
  | { draw: 'label'; at: Point; text: string; color?: Color }

export type Cmd = { title: string } | { say: string } | DrawCmd

export interface ResetPayload {
  gaze: { x: number; y: number }
  model: string
}

export interface OjosApi {
  on(channel: 'reset', fn: (p: ResetPayload) => void): () => void
  on(channel: 'cmd', fn: (c: Cmd) => void): () => void
  on(channel: 'error' | 'ready', fn: (msg: string) => void): () => void
  on(channel: 'done' | 'dismiss', fn: () => void): () => void
  dismiss(): void
  setOverPanel(over: boolean): void
}
