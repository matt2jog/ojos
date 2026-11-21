import { useEffect, useRef, useState } from 'react'
import { EnsembleCalibration, type CalibrationGeometry, type FitResult, type Tracker } from '@vision/calibration.mjs'
import { nowUs, pickGazeSource, type GazeSource } from './gazeSource'

const FIT_COUNT = 9
const TOTAL = 14
const LATE_GRACE_US = 150_000 // allow in-flight observations after each collection window
const COLORS = ['#4285f4', '#ea4335', '#fbbc05', '#34a853']

export type CalibrationOutcome = { kind: 'done'; results: Record<Tracker, FitResult> } | { kind: 'skipped' }

interface Props {
  geometry: CalibrationGeometry
  /** true when the eye model is running, so the dots are followed with real eyes */
  live: boolean
  autopilot?: boolean
  onDone(outcome: CalibrationOutcome): void
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
const sleepUntil = async (us: number): Promise<void> => {
  while (nowUs() < us) await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, (us - nowUs()) / 1000))))
}

/** Full-screen 9 + 5 target calibration. Rendering is ours; the math is EnsembleCalibration. */
export function Calibration({ geometry, live, autopilot, onDone }: Props): React.JSX.Element {
  const [phase, setPhase] = useState<'intro' | 'running' | 'fitting'>('intro')
  const [target, setTarget] = useState<{ point: [number, number]; index: number; ms: number } | null>(null)
  const [popped, setPopped] = useState(false)
  const targetRef = useRef<[number, number] | null>(null)
  const cancelled = useRef(false)
  const sourceRef = useRef<GazeSource | null>(null)
  if (!sourceRef.current) sourceRef.current = pickGazeSource({ live, autopilot: autopilot ? () => targetRef.current : undefined })
  const source = sourceRef.current

  const run = async (): Promise<void> => {
    setPhase('running')
    const cal = new EnsembleCalibration(geometry)
    source.start((tracker, timeUs, raw) => {
      try {
        cal.observe(tracker, timeUs, raw)
      } catch (e) {
        console.warn('observe failed', e)
      }
    })
    try {
      for (let i = 0; cal.nextTarget && !cancelled.current; i++) {
        const point = cal.nextTarget.point
        targetRef.current = null
        setPopped(false)
        setTarget({ point, index: i, ms: 0 })
        await nextFrame()
        await nextFrame() // the dot is on screen now
        if (cancelled.current) return
        const shown = nowUs()
        const win = cal.showTarget(shown)
        targetRef.current = point
        setTarget({ point, index: i, ms: (win.collectUntilUs - shown) / 1000 })
        await sleepUntil(win.collectUntilUs + LATE_GRACE_US)
        if (cancelled.current) return
        cal.finishTarget(nowUs())
        setPopped(true)
        await new Promise((r) => setTimeout(r, 180))
      }
      if (cancelled.current) return
      setPhase('fitting')
      const results = cal.fit()
      onDone({ kind: 'done', results })
    } finally {
      source.stop()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        cancelled.current = true
        onDone({ kind: 'skipped' })
      } else if ((e.key === ' ' || e.key === 'Enter') && phase === 'intro') {
        void run()
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    if (autopilot && phase === 'intro') setTimeout(() => void run(), 600)
    return () => {
      cancelled.current = true
      source.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (phase === 'intro') {
    return (
      <div className="cal cal-intro" onClick={() => void run()}>
        <div className="cal-intro-card">
          <h1>Follow the dots with your eyes</h1>
          <p>Keep your head still and comfortable. 14 dots, about 15 seconds.</p>
          <p className="cal-why">This teaches Ojos where on the screen you're looking. It stays on this laptop.</p>
          {source.kind === 'simulated' && <p className="cal-sim">{source.label}</p>}
          <div className="cal-keys">
            <span>
              <kbd>Space</kbd> start
            </span>
            <span>
              <kbd>Esc</kbd> skip
            </span>
          </div>
        </div>
      </div>
    )
  }

  const checking = target && target.index >= FIT_COUNT
  return (
    <div className="cal">
      {target && (
        <div
          key={target.index}
          className={`cal-dot ${popped ? 'popped' : ''}`}
          style={
            {
              left: `${target.point[0] * 100}%`,
              top: `${target.point[1] * 100}%`,
              '--c': COLORS[target.index % COLORS.length],
              '--ms': `${target.ms}ms`
            } as React.CSSProperties
          }
        >
          <span className={`cal-ring ${target.ms ? 'go' : ''}`} />
          <span className="cal-core" />
        </div>
      )}
      <div className="cal-status">
        {phase === 'fitting'
          ? 'Checking accuracy…'
          : checking
            ? `Checking ${target!.index - FIT_COUNT + 1} of ${TOTAL - FIT_COUNT}`
            : `Calibrating ${(target?.index ?? 0) + 1} of ${FIT_COUNT}`}
        {source.kind === 'simulated' && <span className="cal-sim-tag">simulated</span>}
      </div>
    </div>
  )
}
