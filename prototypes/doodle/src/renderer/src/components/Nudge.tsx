import { useEffect, useRef, useState } from 'react'
import type { Suggestions } from '../../../shared/commands'

interface Props {
  visible: boolean
  /** null while the fast model is still guessing */
  suggestion: Suggestions | null
  mac: boolean
  onPick(question?: string): void
  onHover(over: boolean): void
}

const MAX_LOOK = 5.5 // px the pupils can travel inside each eye

/**
 * The Ojos mascot: a dark pill with two expressive eyes that peeks in when the user might
 * be stuck, with suggested questions popping out beside it (Notion-style pills).
 * Pupils follow the pointer (gaze later), it blinks, widens on hover, squints when picked.
 */
export function Nudge({ visible, suggestion, mac, onPick, onHover }: Props): React.JSX.Element {
  const pillRef = useRef<HTMLButtonElement>(null)
  const pupilRefs = useRef<(SVGGElement | null)[]>([])
  const [blink, setBlink] = useState(false)
  const [hover, setHover] = useState(false)
  const [happy, setHappy] = useState(false)

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
      onHover(false) // mouseleave won't fire if we hide while hovered
    }
  }, [visible, onHover])

  const pick = (q?: string): void => {
    setHappy(true)
    setTimeout(() => onPick(q), 280)
  }

  const key = (i: number): string => (mac ? `⌥${i + 1}` : `Alt+${i + 1}`)

  const eye = (cx: number, i: number): React.JSX.Element =>
    happy ? (
      <path key={i} d={`M ${cx - 9} 33 Q ${cx} 22 ${cx + 9} 33`} className="nudge-happy" />
    ) : (
      <g key={i} className="nudge-eye" style={{ transformOrigin: `${cx}px 30px` }}>
        <circle cx={cx} cy={30} r={13} className="nudge-sclera" />
        <g ref={(el) => void (pupilRefs.current[i] = el)}>
          <circle cx={cx} cy={30} r={6.5} className="nudge-pupil" />
          <circle cx={cx - 2.2} cy={27.6} r={2} className="nudge-glint" />
        </g>
      </g>
    )

  return (
    <div
      className={`nudge ${visible ? 'in' : ''} ${hover ? 'hover' : ''} ${blink ? 'blink' : ''} ${suggestion === null ? 'thinking' : ''} ${happy ? 'happy' : ''}`}
      onMouseEnter={() => {
        setHover(true)
        onHover(true)
      }}
      onMouseLeave={() => {
        setHover(false)
        onHover(false)
      }}
    >
      <div className="nudge-questions">
        {suggestion === null ? (
          <div className="q-pill q-loading" style={{ animationDelay: '0.45s' }}>
            <span className="q-shimmer">Thinking of what you might ask…</span>
          </div>
        ) : (
          <>
            {suggestion.questions.map((q, i) => (
              <button
                key={q}
                className="q-pill"
                style={{ animationDelay: `${0.12 + i * 0.07}s` }}
                onClick={() => pick(q)}
              >
                <span className="q-text">{q}</span>
                <kbd>{key(i)}</kbd>
              </button>
            ))}
            <button
              className="q-pill q-secondary"
              style={{ animationDelay: `${0.12 + suggestion.questions.length * 0.07}s` }}
              onClick={() => pick()}
            >
              <span className="q-text">
                {suggestion.questions.length ? 'Something else? Just explain' : 'Explain what I’m looking at'}
              </span>
            </button>
          </>
        )}
      </div>
      <button
        ref={pillRef}
        className="nudge-pill"
        onClick={() => pick()}
        aria-label="Ojos: explain what you're looking at"
      >
        <svg viewBox="0 0 116 60" width="116" height="60">
          <defs>
            <linearGradient id="ojos-nudge-nose" x1="0" y1="0" x2="0" y2="1">
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
            className="nudge-nose"
            stroke="url(#ojos-nudge-nose)"
          />
          <circle cx={51} cy={43.2} r={3.6} className="nudge-nose-tip" />
          <path
            d="M 58 8 C 58.5 11.9 59.6 13 63.5 13.5 C 59.6 14 58.5 15.1 58 19 C 57.5 15.1 56.4 14 52.5 13.5 C 56.4 13 57.5 11.9 58 8 Z"
            className="nudge-spark"
          />
          {eye(83, 1)}
        </svg>
      </button>
    </div>
  )
}
