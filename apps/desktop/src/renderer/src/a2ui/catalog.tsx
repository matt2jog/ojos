// The Ojos A2UI catalog: schemas (Zod) plus React implementations, rendered by @a2ui/react.
// The agent composes these freely; nothing here is a fixed response template. Keep the names and
// props in step with CATALOG in agentic_system/assistant/genui.py.
import { useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Catalog, CommonSchemas } from '@a2ui/web_core/v0_9'
import { createComponentImplementation } from '@a2ui/react/v0_9'

export const OJOS_CATALOG_ID = 'https://github.com/matt2jog/ojos/catalogs/assist/v1.json'

const S = CommonSchemas
type Fn = (() => void) | undefined
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

function Code({ children }: { children: ReactNode }): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const value = text(children)
  if (!value.trim()) return null
  return (
    <div className="a2-code">
      <pre>
        <code>{value}</code>
      </pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ---------- layout and small pieces ----------
const Stack = createComponentImplementation(
  { name: 'Stack', schema: z.object({ children: S.ChildList }) },
  ({ props, buildChild }) => (
    <div className="a2-stack">{(Array.isArray(props.children) ? props.children : []).map((id) => buildChild(String(id)))}</div>
  )
)

const Note = createComponentImplementation(
  { name: 'Note', schema: z.object({ text: S.DynamicString, tone: z.enum(['info', 'success', 'warning']).optional() }) },
  ({ props }) => <p className={`a2-note ${props.tone ?? 'info'}`}>{text(props.text)}</p>
)

const ActionButton = createComponentImplementation(
  { name: 'ActionButton', schema: z.object({ label: S.DynamicString, action: S.Action }) },
  ({ props }) => {
    const [sent, setSent] = useState(false)
    return (
      <button
        type="button"
        className="a2-btn ghost"
        disabled={sent}
        onClick={() => {
          setSent(true)
          ;(props.action as Fn)?.()
        }}
      >
        {text(props.label)}
      </button>
    )
  }
)

// ---------- BugInsight ----------
const BugInsight = createComponentImplementation(
  {
    name: 'BugInsight',
    schema: z.object({
      title: S.DynamicString,
      explanation: S.DynamicString,
      location: S.DynamicString.optional(),
      severity: z.enum(['error', 'warning', 'info']).optional(),
      code: S.DynamicString.optional(),
      fixes: z
        .array(z.object({ label: z.string(), detail: z.string().optional(), code: z.string().optional(), action: S.Action.optional() }))
        .optional(),
      children: S.ChildList.optional()
    })
  },
  ({ props, buildChild }) => {
    const [open, setOpen] = useState<number | null>(0)
    const [chosen, setChosen] = useState<number | null>(null)
    const fixes = (props.fixes ?? []) as Array<{ label: string; detail?: string; code?: string; action?: Fn }>
    const severity = props.severity ?? 'error'
    return (
      <section className={`a2-card a2-bug ${severity}`}>
        <header>
          <span className="a2-badge">{severity === 'error' ? 'Bug' : severity === 'warning' ? 'Warning' : 'Note'}</span>
          {props.location && <span className="a2-loc">{text(props.location)}</span>}
        </header>
        <h4>{text(props.title)}</h4>
        <p>{text(props.explanation)}</p>
        <Code>{text(props.code)}</Code>
        {fixes.length > 0 && <div className="a2-sub">{fixes.length === 1 ? 'Fix' : 'Ways to fix it'}</div>}
        {fixes.map((fix, i) => (
          <div key={i} className={`a2-fix ${open === i ? 'open' : ''} ${chosen === i ? 'chosen' : ''}`}>
            <button type="button" className="a2-fix-head" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <span>{fix.label}</span>
              <span className="a2-chev">{open === i ? '−' : '+'}</span>
            </button>
            {open === i && (
              <div className="a2-fix-body">
                {fix.detail && <p>{fix.detail}</p>}
                <Code>{fix.code}</Code>
                {fix.action && (
                  <button
                    type="button"
                    className="a2-btn"
                    disabled={chosen !== null}
                    onClick={() => {
                      setChosen(i)
                      fix.action?.()
                    }}
                  >
                    {chosen === i ? 'Asked Ojos…' : 'Walk me through this fix'}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {(Array.isArray(props.children) ? props.children : []).map((id) => buildChild(String(id)))}
      </section>
    )
  }
)

// ---------- StepByStepGuide ----------
const StepByStepGuide = createComponentImplementation(
  {
    name: 'StepByStepGuide',
    schema: z.object({
      title: S.DynamicString,
      steps: z.array(z.object({ title: z.string(), detail: z.string(), code: z.string().optional() })),
      onDone: S.Action.optional(),
      children: S.ChildList.optional()
    })
  },
  ({ props, buildChild }) => {
    const steps = props.steps ?? []
    const [at, setAt] = useState(0)
    const [finished, setFinished] = useState(false)
    const step = steps[Math.min(at, steps.length - 1)]
    const last = at >= steps.length - 1
    return (
      <section className="a2-card a2-steps">
        <header>
          <span className="a2-badge blue">Step by step</span>
          <span className="a2-loc">
            {Math.min(at + 1, steps.length)} of {steps.length}
          </span>
        </header>
        <h4>{text(props.title)}</h4>
        <div className="a2-progress" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={at + 1}>
          {steps.map((_, i) => (
            <button key={i} type="button" className={i <= at ? 'on' : ''} onClick={() => setAt(i)} aria-label={`Go to step ${i + 1}`} />
          ))}
        </div>
        {step && (
          <div className="a2-step" key={at}>
            <div className="a2-step-title">
              <span className="a2-num">{at + 1}</span>
              {step.title}
            </div>
            <p>{step.detail}</p>
            <Code>{step.code}</Code>
          </div>
        )}
        <div className="a2-row">
          <button type="button" className="a2-btn ghost" disabled={at === 0} onClick={() => setAt(at - 1)}>
            Back
          </button>
          {!last && (
            <button type="button" className="a2-btn" onClick={() => setAt(at + 1)}>
              Next
            </button>
          )}
          {last && (
            <button
              type="button"
              className="a2-btn"
              disabled={finished}
              onClick={() => {
                setFinished(true)
                ;(props.onDone as Fn)?.()
              }}
            >
              {finished ? 'Done ✓' : 'Done'}
            </button>
          )}
        </div>
        {(Array.isArray(props.children) ? props.children : []).map((id) => buildChild(String(id)))}
      </section>
    )
  }
)

// ---------- ActionChecklist ----------
const ActionChecklist = createComponentImplementation(
  {
    name: 'ActionChecklist',
    schema: z.object({
      title: S.DynamicString,
      items: z.array(z.object({ label: z.string(), detail: z.string().optional() })),
      // Two-way bound: the labels checked so far, joined with "; ". The agent can read it in an action's context.
      progress: S.DynamicString.optional(),
      onSubmit: S.Action.optional()
    })
  },
  ({ props }) => {
    const items = props.items ?? []
    const [done, setDone] = useState<Set<number>>(new Set())
    const [sent, setSent] = useState(false)
    const toggle = (i: number): void => {
      const next = new Set(done)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      setDone(next)
      setSent(false)
      // Write progress into the A2UI data model so the agent sees it with the next action.
      const setter = (props as { setProgress?: (v: string) => void }).setProgress
      setter?.(items.filter((_, j) => next.has(j)).map((it) => it.label).join('; '))
    }
    const all = items.length > 0 && done.size === items.length
    return (
      <section className="a2-card a2-check">
        <header>
          <span className="a2-badge green">Checklist</span>
          <span className="a2-loc">
            {done.size} of {items.length} done
          </span>
        </header>
        <h4>{text(props.title)}</h4>
        <ul>
          {items.map((item, i) => (
            <li key={i} className={done.has(i) ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={done.has(i)} onChange={() => toggle(i)} />
                <span>
                  <span className="a2-item">{item.label}</span>
                  {item.detail && <span className="a2-detail">{item.detail}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {props.onSubmit && (
          <button
            type="button"
            className="a2-btn"
            disabled={sent}
            onClick={() => {
              setSent(true)
              ;(props.onSubmit as Fn)?.()
            }}
          >
            {sent ? 'Asked Ojos…' : all ? 'All done, what next?' : 'Help with what’s left'}
          </button>
        )}
      </section>
    )
  }
)

// ---------- ComparisonCard ----------
const ComparisonCard = createComponentImplementation(
  {
    name: 'ComparisonCard',
    schema: z.object({
      title: S.DynamicString,
      options: z.array(
        z.object({
          name: z.string(),
          summary: z.string().optional(),
          pros: z.array(z.string()).optional(),
          cons: z.array(z.string()).optional(),
          recommended: z.boolean().optional(),
          action: S.Action.optional()
        })
      )
    })
  },
  ({ props }) => {
    const options = (props.options ?? []) as Array<{
      name: string
      summary?: string
      pros?: string[]
      cons?: string[]
      recommended?: boolean
      action?: Fn
    }>
    const [picked, setPicked] = useState<number | null>(null)
    return (
      <section className="a2-card a2-compare">
        <header>
          <span className="a2-badge yellow">Compare</span>
        </header>
        <h4>{text(props.title)}</h4>
        <div className="a2-options">
          {options.map((o, i) => (
            <div key={i} className={`a2-option ${o.recommended ? 'rec' : ''} ${picked === i ? 'picked' : ''}`}>
              <div className="a2-option-name">
                {o.name}
                {o.recommended && <span className="a2-rec">Suggested</span>}
              </div>
              {o.summary && <p>{o.summary}</p>}
              {(o.pros?.length ?? 0) > 0 && <ul className="pros">{o.pros!.map((p, j) => <li key={j}>{p}</li>)}</ul>}
              {(o.cons?.length ?? 0) > 0 && <ul className="cons">{o.cons!.map((c, j) => <li key={j}>{c}</li>)}</ul>}
              {o.action && (
                <button
                  type="button"
                  className="a2-btn ghost"
                  disabled={picked !== null}
                  onClick={() => {
                    setPicked(i)
                    o.action?.()
                  }}
                >
                  {picked === i ? 'Chosen ✓' : 'Go with this'}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    )
  }
)

// ---------- Diagram ----------
type DNode = { id: string; label: string; detail?: string; tone?: string }
type DEdge = { from: string; to: string; label?: string }

/** Top-to-bottom layered layout: a node sits one row below its deepest predecessor. */
function layoutDiagram(nodes: DNode[], edges: DEdge[], width: number): { pos: Map<string, { x: number; y: number; w: number }>; height: number; rowH: number } {
  // 1. Find loop-back edges with a depth-first walk in the order the agent listed the nodes: an
  //    edge into a node that is still on the walk's stack closes a cycle and must not affect rows.
  const out = new Map<string, DEdge[]>(nodes.map((n) => [n.id, []]))
  for (const e of edges) out.get(e.from)?.push(e)
  const state = new Map<string, 'open' | 'done'>()
  const back = new Set<DEdge>()
  const walk = (id: string): void => {
    state.set(id, 'open')
    for (const e of out.get(id) ?? []) {
      if (e.to === id || state.get(e.to) === 'open') back.add(e)
      else if (!state.has(e.to)) walk(e.to)
    }
    state.set(id, 'done')
  }
  for (const n of nodes) if (!state.has(n.id)) walk(n.id)
  // 2. Longest path over the remaining (acyclic) edges gives each node its row.
  const forward = edges.filter((e) => !back.has(e))
  const level = new Map(nodes.map((n) => [n.id, 0]))
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false
    for (const e of forward) {
      const from = level.get(e.from)!
      if ((level.get(e.to) ?? 0) <= from) {
        level.set(e.to, from + 1)
        moved = true
      }
    }
    if (!moved) break
  }
  const rows = new Map<number, DNode[]>()
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0
    rows.set(l, [...(rows.get(l) ?? []), n])
  }
  const rowH = 78
  const boxH = 42
  const pos = new Map<string, { x: number; y: number; w: number }>()
  const ordered = [...rows.keys()].sort((a, b) => a - b)
  ordered.forEach((l, r) => {
    const row = rows.get(l)!
    const gap = 8
    const w = Math.min(150, (width - gap * (row.length - 1)) / row.length)
    const total = w * row.length + gap * (row.length - 1)
    row.forEach((n, i) => pos.set(n.id, { x: (width - total) / 2 + i * (w + gap), y: r * rowH, w }))
  })
  return { pos, height: (ordered.length - 1) * rowH + boxH, rowH }
}

const Diagram = createComponentImplementation(
  {
    name: 'Diagram',
    schema: z.object({
      title: S.DynamicString,
      nodes: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional(), tone: z.string().optional() })),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).optional(),
      caption: S.DynamicString.optional(),
      onNode: S.Action.optional()
    })
  },
  ({ props }) => {
    const nodes = (props.nodes ?? []) as DNode[]
    const edges = ((props.edges ?? []) as DEdge[]).filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
    const [active, setActive] = useState<string | null>(null)
    const W = 312
    const boxH = 42
    const { pos, height } = layoutDiagram(nodes, edges, W)
    const selected = nodes.find((n) => n.id === active)
    return (
      <section className="a2-card a2-diagram">
        <header>
          <span className="a2-badge blue">Diagram</span>
          <span className="a2-loc">click a box</span>
        </header>
        <h4>{text(props.title)}</h4>
        <div className="a2-canvas" style={{ height: height + 6, width: W }}>
          <svg width={W} height={height + 6} aria-hidden>
            <defs>
              <marker id="a2-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#8ab4f8" />
              </marker>
            </defs>
            {edges.map((e, i) => {
              const a = pos.get(e.from)!
              const b = pos.get(e.to)!
              const down = b.y > a.y
              const x1 = a.x + a.w / 2
              const x2 = b.x + b.w / 2
              const y1 = down ? a.y + boxH : a.y + boxH / 2
              const y2 = down ? b.y - 2 : b.y + boxH / 2
              // forward edges curve gently; back or same-row edges swing out to the side
              const d = down
                ? `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`
                : `M ${a.x + a.w} ${y1} C ${W + 14} ${y1}, ${W + 14} ${y2}, ${b.x + b.w + 2} ${y2}`
              return (
                <g key={i}>
                  <path d={d} fill="none" stroke="#8ab4f8" strokeWidth="1.6" strokeOpacity="0.85" markerEnd="url(#a2-arrow)" />
                  {e.label && down && (
                    <text x={(x1 + x2) / 2 + 6} y={(y1 + y2) / 2 + 3} className="a2-edge-label">
                      {e.label.slice(0, 26)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {nodes.map((n) => {
            const p = pos.get(n.id)!
            return (
              <button
                key={n.id}
                type="button"
                className={`a2-node ${n.tone ?? 'default'} ${active === n.id ? 'active' : ''}`}
                style={{ left: p.x, top: p.y, width: p.w, height: boxH }}
                onClick={() => setActive(active === n.id ? null : n.id)}
                aria-pressed={active === n.id}
              >
                {n.label}
              </button>
            )
          })}
        </div>
        {selected && (
          <div className="a2-node-detail" key={selected.id}>
            <strong>{selected.label}</strong>
            {selected.detail ? <p>{selected.detail}</p> : null}
          </div>
        )}
        {props.caption && <p className="a2-caption">{text(props.caption)}</p>}
      </section>
    )
  }
)

export const ojosCatalog = new Catalog(OJOS_CATALOG_ID, 'v0.9', [Stack, Note, ActionButton, BugInsight, StepByStepGuide, ActionChecklist, ComparisonCard, Diagram], [])

const KNOWN = new Set(['Stack', 'Note', 'ActionButton', 'BugInsight', 'StepByStepGuide', 'ActionChecklist', 'ComparisonCard', 'Diagram'])

/**
 * Checks agent messages before they reach the processor. The processor validates the envelope and
 * the catalog id, but renders nothing for a component it doesn't know, so reject those here.
 */
export function assertRenderable(messages: unknown): void {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('No A2UI messages.')
  let sawRoot = false
  for (const m of messages as Array<Record<string, unknown>>) {
    const update = m?.updateComponents as { components?: unknown } | undefined
    if (!update) continue
    if (!Array.isArray(update.components)) throw new Error('updateComponents.components must be a list.')
    const ids = new Set<string>()
    for (const c of update.components as Array<Record<string, unknown>>) {
      if (typeof c?.id !== 'string' || typeof c.component !== 'string') throw new Error('Each component needs an id and a component name.')
      if (!KNOWN.has(c.component)) throw new Error(`Unknown component "${c.component}".`)
      ids.add(c.id)
    }
    for (const c of update.components as Array<Record<string, unknown>>) {
      for (const child of Array.isArray(c.children) ? c.children : []) {
        if (!ids.has(String(child))) throw new Error(`Component "${c.id}" references a missing child "${child}".`)
      }
    }
    sawRoot ||= ids.has('root')
  }
  if (!sawRoot) throw new Error('The interface has no root component.')
}
