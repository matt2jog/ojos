import type { Cmd, Gaze } from '../shared/commands'

export const MOCK_QUESTIONS = [
  'Why is this value undefined?',
  'What does this error mean?',
  'How do I fix this line?'
]

/** Scripted answer around the gaze point, for testing the UI without an API key. */
export async function streamMock(opts: {
  gaze: Gaze
  question?: string
  doodles: boolean
  isCurrent: () => boolean
  onCmd: (cmd: Cmd) => void
}): Promise<void> {
  const { x, y } = opts.gaze
  const c = (v: number): number => Math.max(10, Math.min(990, Math.round(v)))
  const script: Cmd[] = [
    { title: opts.question ?? 'What is going on here?' },
    { draw: 'circle', box: [c(x - 110), c(y - 25), c(x + 110), c(y + 25)], color: 'red' },
    { say: "You're looking at this line. It's trying to read a value that doesn't exist yet." },
    { draw: 'arrow', from: [c(x - 60), c(y - 35)], to: [c(x - 160), c(y - 180)], color: 'blue' },
    { say: 'It comes from up here, where the function returned nothing.' },
    { draw: 'label', at: [c(x - 150), c(y - 220)], text: 'returns None!', color: 'blue' },
    { draw: 'underline', from: [c(x - 100), c(y + 40)], to: [c(x + 100), c(y + 40)], color: 'green' },
    { say: 'Check for an empty result before using it, and the error goes away.' }
  ]
  for (const cmd of script) {
    const isDraw = 'draw' in cmd
    if (isDraw && !opts.doodles) continue
    await new Promise((r) => setTimeout(r, isDraw ? 700 : 400))
    if (!opts.isCurrent()) return
    opts.onCmd(cmd)
  }
}
