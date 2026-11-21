import type { Cmd } from '../shared/commands'

/** Scripted doodles around the gaze point, for testing visuals without an API key. */
export async function streamMock(opts: {
  gaze: { x: number; y: number }
  isCurrent: () => boolean
  onCmd: (cmd: Cmd) => void
}): Promise<void> {
  const { x, y } = opts.gaze
  const c = (v: number): number => Math.max(10, Math.min(990, Math.round(v)))
  const script: Cmd[] = [
    { title: 'Why is this value undefined?' },
    { draw: 'circle', box: [c(x - 110), c(y - 25), c(x + 110), c(y + 25)], color: 'red' },
    { say: "You're looking at this line. It's trying to read a value that doesn't exist yet." },
    { draw: 'arrow', from: [c(x - 60), c(y - 35)], to: [c(x - 160), c(y - 180)], color: 'blue' },
    { say: 'It comes from up here, where the function returned nothing.' },
    { draw: 'label', at: [c(x - 150), c(y - 220)], text: 'returns None!', color: 'blue' },
    { draw: 'underline', from: [c(x - 100), c(y + 40)], to: [c(x + 100), c(y + 40)], color: 'green' },
    { say: 'Check for an empty result before using it, and the error goes away.' }
  ]
  for (const cmd of script) {
    await new Promise((r) => setTimeout(r, 'draw' in cmd ? 700 : 400))
    if (!opts.isCurrent()) return
    opts.onCmd(cmd)
  }
}
