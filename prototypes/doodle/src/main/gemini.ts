import { GoogleGenAI } from '@google/genai'
import type { Cmd, Gaze, Suggestions } from '../shared/commands'

const CONTEXT = (g: Gaze): string =>
  `The user looked visibly confused for a few seconds while looking at their screen (screenshot attached). Their approximate gaze is [${g.x}, ${g.y}] on a 0-1000 scale (x, y, origin top-left). Gaze is noisy: treat it as "somewhere within ~150 units of this point" and use the screenshot to find the specific thing (paragraph, line of code, error, formula, UI element) they are most likely stuck on.`

const SUGGEST_PROMPT = (g: Gaze): string => `${CONTEXT(g)}

Return JSON with:
- "stuck_on": what they seem stuck on, as a short noun phrase naming the actual thing on screen (at most 7 words), e.g. "the TypeError on line 14" or "the second paragraph on entropy". It completes the sentence "Looks like you're stuck on ...".
- "questions": the 3 questions they most likely want to ask about it, most likely first, specific to what is on screen, at most 8 words each, phrased as the user would ask them.
- "summary": one or two plain sentences giving the gist of the answer.

{"stuck_on": "...", "questions": ["...", "...", "..."], "summary": "..."}`

const EXPLAIN_PROMPT = (g: Gaze, question: string | undefined, doodles: boolean): string => `You are Ojos, a calm tutor. ${CONTEXT(g)}

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

/** Step 1 (fast model): what they're stuck on + likely questions, for the mascot's bubble and pills. */
export async function suggest(opts: {
  apiKey: string
  model: string
  pngBase64: string
  gaze: Gaze
}): Promise<Suggestions> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  const res = await ai.models.generateContent({
    model: opts.model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: opts.pngBase64 } },
          { text: SUGGEST_PROMPT(opts.gaze) }
        ]
      }
    ],
    config: { responseMimeType: 'application/json' }
  })
  const parsed = JSON.parse((res.text ?? '{}').replace(/^```(json)?|```$/g, '').trim())
  const qs: unknown = parsed.questions
  return {
    stuck_on: typeof parsed.stuck_on === 'string' ? parsed.stuck_on.trim() : '',
    questions: Array.isArray(qs) ? qs.filter((q): q is string => typeof q === 'string' && q.trim() !== '').slice(0, 3) : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : undefined
  }
}

/** Step 2 (explainer): streams parsed commands. Stops early when isCurrent() turns false. */
export async function streamGemini(opts: {
  apiKey: string
  model: string
  pngBase64: string
  gaze: Gaze
  question?: string
  doodles: boolean
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
