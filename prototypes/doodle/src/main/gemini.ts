import { GoogleGenAI } from '@google/genai'
import type { Cmd, Gaze } from '../shared/commands'

const CONTEXT = (g: Gaze | undefined): string =>
  g ? `A frame from the user's help clip is attached. Their approximate gaze is [${g.x}, ${g.y}] on a 0-1000 scale (x, y, origin top-left). Treat gaze as a rough area and use the visible screen as evidence.`
    : 'A frame from the user’s help clip is attached. Gaze is unavailable. Use the visible screen as evidence.'

const EXPLAIN_PROMPT = (g: Gaze | undefined, question: string | undefined, doodles: boolean): string => `You are Ojos, a calm tutor. ${CONTEXT(g)}

${question ? `They asked: "${question}". Answer exactly that.` : 'Work out what they are most likely stuck on and explain it.'}

Output ONLY newline-delimited JSON, one object per line, no markdown, no code fences. Allowed lines:
{"title": "<the question being answered, max 8 words>"}   (always first)
{"say": "<one short sentence>"}
${
  doodles
    ? `{"draw": "circle", "box": [x1, y1, x2, y2], "color": "red|blue|green|yellow"}
{"draw": "underline", "from": [x, y], "to": [x, y], "color": "..."}
{"draw": "arrow", "from": [x, y], "to": [x, y], "color": "..."}
{"draw": "highlight", "box": [x1, y1, x2, y2], "color": "yellow"}
{"draw": "label", "at": [x, y], "text": "<2-4 words>", "color": "..."}

Draw on the screen while explaining: a draw line, then the say line about it. All coordinates are 0-1000 over the screenshot and must point at the real on-screen element. At most 5 draws. Labels go in empty space, not on top of text.`
    : ''
}
Rules: 2-5 say lines. Plain language, no jargon, refer to what is visible on their screen. Be concrete and brief.`

/** Streams parsed commands into the existing explanation panel. */
export async function streamGemini(opts: {
  apiKey: string
  model: string
  jpegBase64: string
  gaze?: Gaze
  question?: string
  doodles: boolean
  isCurrent: () => boolean
  onCmd: (cmd: Cmd) => void
  signal: AbortSignal
}): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  const stream = await ai.models.generateContentStream({
    model: opts.model,
    config: { abortSignal: opts.signal },
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: opts.jpegBase64 } },
          { text: EXPLAIN_PROMPT(opts.gaze, opts.question, opts.doodles) }
        ]
      }
    ]
  })

  const emit = (raw: string): void => {
    const line = raw.trim().replace(/^```(json)?|```$/g, '').trim()
    if (!line) return
    try {
      const cmd = JSON.parse(line) as Cmd
      if ('draw' in cmd && !opts.doodles) return
      opts.onCmd(cmd)
    } catch {
      console.warn('skipped non-JSON line:', line)
    }
  }

  let buf = ''
  for await (const chunk of stream) {
    if (!opts.isCurrent()) return
    buf += chunk.text ?? ''
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      emit(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  emit(buf)
}
