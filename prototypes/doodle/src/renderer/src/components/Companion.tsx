import { useCallback, useEffect, useRef, useState } from 'react'
import { GenWidget } from './GenWidget'

export interface TurnView {
  /** What the user picked or typed. Empty for a generic "explain this". */
  question?: string
  title: string
  says: string[]
}

interface Props {
  /** nudge: mascot with a thought bubble. chat: mascot with the conversation. */
  mode: 'hidden' | 'nudge' | 'chat'
  /** Suggested questions not asked yet. null while the fast model is still guessing. */
  questions: string[] | null
  thread: TurnView[]
  status: { kind: 'idle' | 'thinking' | 'error'; text?: string }
  busy: boolean
  mac: boolean
  /** Changes when the chat box should take the keyboard. */
  focusSignal: number
  onPick(question?: string): void
  onAsk(text: string): void
  onOpenChat(): void
  onDismiss(): void
  onHover(over: boolean): void
}

const MAX_LOOK = 5.5 // px the pupils can travel inside each eye
const BODY = { w: 116, h: 98 } // mascot pill plus the button row under it
const EDGE = 8
const POS_KEY = 'ojos-mascot-pos'

type Pos = { x: number; y: number }
const clamp = (p: Pos): Pos => ({
  x: Math.max(EDGE, Math.min(innerWidth - BODY.w - EDGE, p.x)),
  y: Math.max(EDGE, Math.min(innerHeight - BODY.h - EDGE, p.y))
})
const startPos = (): Pos => {
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null')
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') return clamp(saved)
  } catch {
    /* fall through to the default spot */
  }
  return clamp({ x: innerWidth - BODY.w - 24, y: innerHeight * 0.82 - BODY.h })
}

interface ThoughtItem {
  text: string
  kbd?: string
  onPick(): void
}

/** One suggestion at a time. It moves on by itself, and the dots jump to a specific one. */
function Thought({ items, compact }: { items: ThoughtItem[]; compact?: boolean }): React.JSX.Element | null {
  const [i, setI] = useState(0)
  const [hold, setHold] = useState(false)
  const n = items.length
  const signature = items.map((it) => it.text).join('\n')

  useEffect(() => setI(0), [signature])
  useEffect(() => {
    if (n < 2 || hold) return
    const t = setTimeout(() => setI((v) => v + 1), 3400)
    return () => clearTimeout(t)
  }, [i, n, hold])

  if (!n) return null
  const at = i % n
  const item = items[at]
  return (
    <div
      className={`thought ${compact ? 'compact' : ''}`}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
    >
      <button key={item.text} className="thought-text" onClick={item.onPick}>
        <span>{item.text}</span>
        {item.kbd && <kbd>{item.kbd}</kbd>}
      </button>
      {n > 1 && (
        <div className="thought-nav">
          {items.map((it, d) => (
            <button
              key={it.text}
              className={`thought-dot ${d === at ? 'on' : ''}`}
              onClick={() => setI(d)}
              aria-label={`Suggestion ${d + 1} of ${n}`}
            />
          ))}
          <button className="thought-next" onClick={() => setI(at + 1)} aria-label="Next suggestion">
            ›
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The Ojos mascot and everything it says. It appears when the user might be stuck, thinks of
 * one suggested question at a time, and keeps the answer and any follow-ups in its own bubble.
 * Drag it by the face to move it. Pupils follow the pointer (gaze later).
 */
export function Companion(props: Props): React.JSX.Element {
  const { mode, questions, thread, status, busy, mac, focusSignal, onPick, onAsk, onOpenChat, onDismiss, onHover } =
    props
  const pillRef = useRef<HTMLButtonElement>(null)
  const pupilRefs = useRef<(SVGGElement | null)[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number; x0: number; y0: number; moved: boolean } | null>(null)
  const justDragged = useRef(false)
  const [pos, setPos] = useState<Pos>(startPos)
  const [dragging, setDragging] = useState(false)
  const [blink, setBlink] = useState(false)
  const [hover, setHover] = useState(false)
  const [happy, setHappy] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const visible = mode !== 'hidden'

  // Pupils ease toward the pointer.
  useEffect(() => {
    const target = { x: 0, y: 0 }
    const cur = { x: 0, y: 0 }
    let raf = 0
    const onMove = (e: MouseEvent): void => {
      const r = pillRef.current?.getBoundingClientRect()
      if (!r) return
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      const d = Math.hypot(dx, dy) || 1
      const k = Math.min(1, d / 220) * MAX_LOOK
      target.x = (dx / d) * k
      target.y = (dy / d) * k * 0.8
    }
    const tick = (): void => {
      cur.x += (target.x - cur.x) * 0.18
      cur.y += (target.y - cur.y) * 0.18
      for (const p of pupilRefs.current) p?.setAttribute('transform', `translate(${cur.x} ${cur.y})`)
      raf = requestAnimationFrame(tick)
    }
    addEventListener('mousemove', onMove)
    raf = requestAnimationFrame(tick)
    return () => {
      removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  // Natural blinking: every 2.5–5.5 s, sometimes a double blink.
  useEffect(() => {
    if (!visible) return
    let t: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      t = setTimeout(
        () => {
          setBlink(true)
          setTimeout(() => setBlink(false), 130)
          if (Math.random() < 0.25) {
            setTimeout(() => setBlink(true), 260)
            setTimeout(() => setBlink(false), 390)
          }
          schedule()
        },
        2500 + Math.random() * 3000
      )
    }
    schedule()
    return () => clearTimeout(t)
  }, [visible])

  useEffect(() => {
    if (!visible) {
      setHappy(false)
      setHover(false)
      setCollapsed(false)
      setDraft('')
      onHover(false) // mouseleave won't fire if we hide while hovered
    }
  }, [visible, onHover])

  useEffect(() => {
    const onResize = (): void => setPos((p) => clamp(p))
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])

  const focusInput = useCallback(() => {
    window.ojos.setFocus(true)
    setCollapsed(false)
    setTimeout(() => inputRef.current?.focus(), 60)
  }, [])
  useEffect(() => {
    if (focusSignal) focusInput()
  }, [focusSignal, focusInput])

  // A new turn reopens a collapsed bubble; new text keeps the latest line in view.
  useEffect(() => setCollapsed(false), [thread.length])
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread, status])

  const pick = (q?: string): void => {
    setHappy(true)
    setTimeout(() => onPick(q), 280)
    setTimeout(() => setHappy(false), 1500)
  }

  const send = (e: React.FormEvent): void => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onAsk(text)
  }

  // Drag by the face. A press that barely moves is still a click.
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, x0: e.clientX, y0: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return
    d.moved = true
    setDragging(true)
    setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }))
  }
  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    if (!d?.moved) return
    setDragging(false)
    justDragged.current = true
    setTimeout(() => (justDragged.current = false), 0)
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos))
    } catch {
      /* position just won't be remembered */
    }
  }
  const onFaceClick = (): void => {
    if (justDragged.current) return
    if (mode === 'nudge') pick()
    else setCollapsed((c) => !c)
  }

  // The bubble opens toward whichever side of the mascot has more room.
  const up = pos.y > innerHeight - pos.y - BODY.h
  const toLeft = pos.x + BODY.w / 2 > innerWidth / 2
  const room = Math.max(160, (up ? pos.y : innerHeight - pos.y - BODY.h) - 30)

  const key = (i: number): string => (mac ? `⌥${i + 1}` : `Alt+${i + 1}`)
  const slides: ThoughtItem[] = [
    ...(questions ?? []).map((q, i) => ({ text: q, kbd: key(i), onPick: () => pick(q) })),
    { text: questions?.length ? 'Something else? Just explain' : 'Explain what I’m looking at', onPick: () => pick() }
  ]
  const chips: ThoughtItem[] = (questions ?? []).map((q) => ({ text: q, onPick: () => pick(q) }))
  const thinking = (mode === 'nudge' && questions === null) || status.kind === 'thinking'

  const eye = (cx: number, i: number): React.JSX.Element =>
    happy ? (
      <path key={i} d={`M ${cx - 9} 33 Q ${cx} 22 ${cx + 9} 33`} className="ojo-happy" />
    ) : (
      <g key={i} className="ojo-eye" style={{ transformOrigin: `${cx}px 30px` }}>
        <circle cx={cx} cy={30} r={13} className="ojo-sclera" />
        <g ref={(el) => void (pupilRefs.current[i] = el)}>
          <circle cx={cx} cy={30} r={6.5} className="ojo-pupil" />
          <circle cx={cx - 2.2} cy={27.6} r={2} className="ojo-glint" />
        </g>
      </g>
    )

  return (
    <div
      className={`ojo ${visible ? 'in' : ''} ${hover ? 'hover' : ''} ${blink ? 'blink' : ''} ${thinking ? 'thinking' : ''} ${happy ? 'happy' : ''} ${dragging ? 'dragging' : ''} ${up ? 'up' : 'down'} ${toLeft ? 'to-left' : 'to-right'}`}
      style={{ left: pos.x, top: pos.y }}
      onMouseEnter={() => {
        setHover(true)
        onHover(true)
      }}
      onMouseLeave={() => {
        if (drag.current) return
        setHover(false)
        onHover(false)
      }}
    >
      <div className="ojo-bubble">
        {mode === 'nudge' &&
          (questions === null ? (
            <div className="thought">
              <div className="thought-text thought-loading">
                <span className="q-shimmer">Thinking of what you might ask…</span>
              </div>
            </div>
          ) : (
            <Thought items={slides} />
          ))}
        {mode === 'nudge' && (
          <>
            <span className="thought-tail" />
            <span className="thought-tail mid" />
            <span className="thought-tail small" />
          </>
        )}
        {mode === 'chat' && !collapsed && (
          <div className="talk" style={{ maxHeight: room }}>
            <div className="talk-thread" ref={threadRef}>
              {thread.length === 0 && <p className="talk-empty">Ask me anything about what’s on your screen.</p>}
              {thread.map((t, i) => (
                <div className="talk-turn" key={i}>
                  <div className="talk-q">{t.question ?? (t.title || 'Explain what I’m looking at')}</div>
                  {t.says.map((s, j) => (
                    <p key={j}>{s}</p>
                  ))}
                </div>
              ))}
              <GenWidget />
              {status.kind === 'thinking' && (
                <div className="talk-status">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              )}
              {status.kind === 'error' && <div className="talk-status err">Error: {status.text}</div>}
            </div>
            {!busy && <Thought items={chips} compact />}
            <form className="talk-ask" onSubmit={send}>
              <input
                ref={inputRef}
                value={draft}
                placeholder={thread.length ? 'Ask a follow-up…' : 'Ask Ojos…'}
                onChange={(e) => setDraft(e.target.value)}
                onPointerDown={() => window.ojos.setFocus(true)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.currentTarget.blur()
                  window.ojos.setFocus(false)
                }}
              />
              <button type="submit" disabled={!draft.trim()} aria-label="Send">
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                </svg>
              </button>
            </form>
          </div>
        )}
      </div>
      <button
        ref={pillRef}
        className="ojo-pill"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onFaceClick}
        aria-label={mode === 'nudge' ? "Ojos: explain what you're looking at" : 'Ojos: show or hide the answer'}
      >
        <svg viewBox="0 0 116 60" width="116" height="60">
          <defs>
            <linearGradient id="ojos-nose" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4285f4" />
              <stop offset="0.35" stopColor="#34a853" />
              <stop offset="0.7" stopColor="#fbbc05" />
              <stop offset="1" stopColor="#ea4335" />
            </linearGradient>
          </defs>
          {eye(33, 0)}
          {/* the "j" of ojos is the nose: Google-colored stem, Gemini spark for its dot */}
          <path
            d="M 58 22 C 58.6 30, 59.6 36.5, 57.6 41 C 56.2 44.4, 52.4 45.4, 50.2 43.4"
            className="ojo-nose"
            stroke="url(#ojos-nose)"
          />
          <circle cx={51} cy={43.2} r={3.6} className="ojo-nose-tip" />
          <path
            d="M 58 8 C 58.5 11.9 59.6 13 63.5 13.5 C 59.6 14 58.5 15.1 58 19 C 57.5 15.1 56.4 14 52.5 13.5 C 56.4 13 57.5 11.9 58 8 Z"
            className="ojo-spark"
          />
          {eye(83, 1)}
        </svg>
      </button>
      <div className="ojo-bar">
        <button onClick={mode === 'chat' ? focusInput : onOpenChat} aria-label="Chat with Ojos" title="Chat with Ojos">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
          </svg>
        </button>
        {/* Voice (mic + spoken replies) is parked: re-add <VoiceButtons /> here to turn it back on. */}
        <button
          onClick={() => window.ojos.openSettings()}
          aria-label="Settings and eye recalibration"
          title="Settings · recalibrate eyes"
        >
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M2.5 5h3.2M9.3 5h4.2M2.5 11h6.2M12.3 11h1.2" />
            <path d="M5.7 5a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0M8.7 11a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0" />
          </svg>
        </button>
        <button onClick={onDismiss} aria-label="Close" title="Close">
          <svg viewBox="0 0 16 16" width="15" height="15">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  )
}
