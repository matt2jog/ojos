// Contract between the explainer (Gemini / backend) and the desktop overlay.
// Coordinates are normalized 0-1000 over the captured screen, origin top-left.

export type Gaze = { x: number; y: number }
export type Point = [number, number]
export type Box = [number, number, number, number] // x1, y1, x2, y2
export type Color = 'red' | 'blue' | 'green' | 'yellow'

/** Step 1, fast model: shown as the mascot's speech bubble + question pills. */
export interface Suggestions {
  /** What they seem stuck on, as a short noun phrase, e.g. "the TypeError on line 14" */
  stuck_on: string
  /** 2-3 likely questions, each at most ~8 words */
  questions: string[]
  /** Optional 1-2 sentence gist (from the AI-system pipeline); not shown yet */
  summary?: string
}

/** Step 2, explainer: streamed as newline-delimited JSON, one command per line. */
export type DrawCmd =
  | { draw: 'circle'; box: Box; color?: Color }
  | { draw: 'underline'; from: Point; to: Point; color?: Color }
  | { draw: 'arrow'; from: Point; to: Point; color?: Color }
  | { draw: 'highlight'; box: Box; color?: Color }
  | { draw: 'label'; at: Point; text: string; color?: Color }

/** MVP answers use only title + say. Draw commands are the secondary doodle feature. */
export type Cmd = { title: string } | { say: string } | DrawCmd

export interface ResetPayload {
  gaze: Gaze
  model: string
}

export interface OjosApi {
  on(channel: 'reset', fn: (p: ResetPayload) => void): () => void
  on(channel: 'nudge', fn: (gaze: Gaze) => void): () => void
  on(channel: 'suggest', fn: (s: Suggestions) => void): () => void
  on(channel: 'cmd', fn: (c: Cmd) => void): () => void
  on(channel: 'error' | 'ready', fn: (msg: string) => void): () => void
  on(channel: 'done' | 'dismiss', fn: () => void): () => void
  dismiss(): void
  /** User wants help: a picked suggestion, or no question for "explain this". */
  accept(question?: string): void
  /** Mascot was ignored and timed out. */
  nudgeHidden(): void
  setOverPanel(over: boolean): void
}
