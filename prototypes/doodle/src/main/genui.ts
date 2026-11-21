// Generative UI, gated by Gemini's decision model.
// 1. gemini-decision-1 (Decisions API) looks at the screenshot and the question and chooses from
//    a fixed list: none, diagram, steps, comparison, interactive.
// 2. For anything but none, that choice is passed to the explainer model as context, with
//    type-specific rules (static types get no script or inputs), and it writes a small
//    self-contained HTML visual shown in a sandboxed frame under the written answer.
import { GoogleGenAI } from '@google/genai'

export const DECISION_MODEL = process.env.GEMINI_DECISION_MODEL || 'gemini-decision-1'

/** The enumerable the decision model chooses from. `none` means no generated UI. */
export const UI_KINDS = {
  none: 'No visual. A short written explanation is enough, or the question is simple, conversational or factual.',
  diagram:
    'A static labelled diagram: boxes and arrows, a flow, a structure, or an annotated picture of how the parts relate. Nothing to click.',
  steps: 'A step-by-step walkthrough the user clicks through one step at a time, for a process, an algorithm or a sequence of events.',
  comparison: 'A side-by-side or before/after comparison, or a small table contrasting two or more options, values or versions.',
  interactive:
    'A dynamic widget with a control such as a slider, toggle or input, for a relationship the user should explore by changing a value.'
} as const
export type UiKind = keyof typeof UI_KINDS

export interface UiDecision {
  kind: UiKind
  confidence: number
  probabilities: Record<string, number>
  ms: number
}

export async function decideUi(opts: { apiKey: string; pngBase64: string; question: string }): Promise<UiDecision> {
  const started = Date.now()
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
    method: 'POST',
    headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DECISION_MODEL,
      input: [
        { type: 'image', data: opts.pngBase64, mime_type: 'image/png', resolution: 'low' },
        { type: 'text', text: `The user is looking at this screen, looked confused, and asked: "${opts.question}"` }
      ],
      questions: {
        ui: {
          type: 'choice',
          instructions: 'Which kind of generated visual, if any, should accompany the written answer to this question?',
          criteria: UI_KINDS
        }
      }
    })
  })
  if (!res.ok) throw new Error(`Decisions API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const answer = (await res.json()).answers?.ui as
    | { choice?: string; confidence?: number; probabilities?: Record<string, number> }
    | undefined
  const kind = (answer?.choice && answer.choice in UI_KINDS ? answer.choice : 'none') as UiKind
  return { kind, confidence: answer?.confidence ?? 0, probabilities: answer?.probabilities ?? {}, ms: Date.now() - started }
}

// What the generator is allowed to build for each choice. The decision is passed in as context.
const KIND_RULES: Record<Exclude<UiKind, 'none'>, string> = {
  diagram:
    'Build a STATIC labelled diagram with inline SVG or HTML/CSS. No <script>, no inputs, no buttons, no animation that needs interaction.',
  steps:
    'Build a step-by-step walkthrough: 3 to 5 steps, one visible at a time, with Back and Next buttons and a step indicator. A short script may switch steps. No other inputs.',
  comparison:
    'Build a STATIC side-by-side or before/after comparison (two columns or a small table) with the differences highlighted. No <script>, no inputs.',
  interactive:
    'Build a small interactive widget with exactly one or two controls (slider, toggle or number input) that update a visual live. Keep the script short.'
}

const WIDGET_PROMPT = (kind: Exclude<UiKind, 'none'>, question: string, answer: string): string => `You are Ojos, a tutor. The user is looking at the attached screen and asked: "${question}".
You already answered in words:
${answer}

A decision model chose the presentation type "${kind}". ${KIND_RULES[kind]}
Use the actual names, values and text from their screen.

Output ONLY a complete HTML document, no markdown and no code fences. Hard rules:
- Fully self-contained: inline <style> (and inline <script> only if the type above allows it). No external scripts, stylesheets, fonts, images or network requests.
- It renders in a 340px-wide dark panel. html and body: margin 0, background transparent, color #ececec, font 13px system-ui. Content at most 340px wide and about 260px tall, no horizontal scrolling.
- Accent colors: #4285f4, #34a853, #fbbc05, #ea4335. Rounded corners, clean and minimal.
- A one-line caption under the visual. No heading that repeats the question.`

export async function generateWidget(opts: {
  apiKey: string
  model: string
  kind: Exclude<UiKind, 'none'>
  pngBase64: string
  question: string
  answer: string
}): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  const res = await ai.models.generateContent({
    model: opts.model,
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: opts.pngBase64 } }, { text: WIDGET_PROMPT(opts.kind, opts.question, opts.answer) }]
      }
    ]
  })
  const html = (res.text ?? '').trim().replace(/^```(html)?\s*/i, '').replace(/```\s*$/, '').trim()
  if (!/<(html|body|div|svg|style)/i.test(html)) throw new Error('The model did not return HTML')
  return html
}
