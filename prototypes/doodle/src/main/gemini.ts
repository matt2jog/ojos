import { GoogleGenAI } from '@google/genai'
import type { Cmd } from '../shared/commands'

const PROMPT = (gx: number, gy: number): string => `You are Ojos, a silent tutor. The user has been visibly confused for ~3 seconds while looking at their screen (screenshot attached). Their gaze is at normalized point [${gx}, ${gy}] (x, y on a 0-1000 scale, origin top-left). Work out what they are most likely stuck on, near where they are looking, and explain it by DRAWING on their screen while talking.

Output ONLY newline-delimited JSON, one object per line, no markdown, no code fences. Allowed lines:
{"title": "<the question they probably have, max 8 words>"}   (always first)
{"say": "<one short sentence of explanation>"}
{"draw": "circle", "box": [x1, y1, x2, y2], "color": "red|blue|green|yellow"}
{"draw": "underline", "from": [x, y], "to": [x, y], "color": "..."}
{"draw": "arrow", "from": [x, y], "to": [x, y], "color": "..."}
{"draw": "highlight", "box": [x1, y1, x2, y2], "color": "yellow"}
{"draw": "label", "at": [x, y], "text": "<2-4 words>", "color": "..."}

Rules: all coordinates are normalized 0-1000 over the screenshot and must point at the real on-screen element. Interleave: a draw line, then the say line that talks about it. At most 5 draws and 5 says. Plain language, no jargon. Labels go in empty space near the thing they describe, not on top of text.`

/** Streams parsed commands from Gemini. Stops early when isCurrent() turns false. */
export async function streamGemini(opts: {
  apiKey: string
  model: string
  pngBase64: string
  gaze: { x: number; y: number }
  isCurrent: () => boolean
  onCmd: (cmd: Cmd) => void
}): Promise<void> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  const stream = await ai.models.generateContentStream({
    model: opts.model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: opts.pngBase64 } },
          { text: PROMPT(opts.gaze.x, opts.gaze.y) }
        ]
      }
    ]
  })

  const emit = (raw: string): void => {
    const line = raw.trim().replace(/^```(json)?|```$/g, '').trim()
    if (!line) return
    try {
      opts.onCmd(JSON.parse(line) as Cmd)
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
