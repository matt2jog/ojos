import { useEffect, useState } from 'react'
import type { VisionDebugSnapshot } from '../../../shared/capture'
import './vision-debug.css'

const CHART_WIDTH = 640
const CHART_HEIGHT = 110

function ConfidenceTimeline({ snapshot, threshold }: {
  snapshot: VisionDebugSnapshot
  threshold: number
}): React.JSX.Element {
  const duration = Math.max(snapshot.endUs - snapshot.startUs, 1)
  const x = (time: number): number => CHART_WIDTH * Math.max(0, Math.min(1, time / duration))
  const y = (score: number): number => (1 - score) * CHART_HEIGHT
  let penDown = false
  const trace = snapshot.gaze.samples.map((point) => {
    if (point.confidence === null) {
      penDown = false
      return ''
    }
    const command = penDown ? 'L' : 'M'
    penDown = true
    return `${command}${x(point.time_us).toFixed(2)},${y(point.confidence).toFixed(2)}`
  }).join(' ')
  return (
    <figure className="vision-timeline">
      <figcaption>Confusion confidence</figcaption>
      <div className="vision-chart">
        <div className="vision-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
        <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none"
          role="img" aria-label="Smoothed confusion confidence. Shaded regions mark detected confusion intervals.">
          <line x1="0" x2={CHART_WIDTH} y1={y(0.5)} y2={y(0.5)} className="vision-gridline" />
          {snapshot.intervals.map((interval) => {
            const left = x(interval.start_us - snapshot.startUs)
            const right = x(interval.end_us - snapshot.startUs)
            return <rect key={interval.event_id} x={left} y="0" width={right - left} height={CHART_HEIGHT}
              className="vision-interval" />
          })}
          <line x1="0" x2={CHART_WIDTH} y1={y(threshold)} y2={y(threshold)} className="vision-threshold" />
          <path d={trace} className="vision-trace" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="vision-axis-time"><span>{Math.round(duration / 1e6)} s ago</span><span>Now</span></div>
      <p className="vision-legend"><span className="vision-legend-threshold">Threshold {Math.round(threshold * 100)}%</span>
        <span className="vision-legend-interval">{snapshot.intervals.length} detected</span></p>
    </figure>
  )
}

function CameraAndGaze({ snapshot }: { snapshot: VisionDebugSnapshot }): React.JSX.Element {
  const { gaze, camera } = snapshot
  const cursorUs = camera ? camera.timeUs - snapshot.startUs : snapshot.endUs - snapshot.startUs
  const latest = gaze.samples.findLast((point) => point.time_us <= cursorUs && cursorUs - point.time_us <= 400_000)
  const dots = latest ? [
    { name: 'WebEyeTrack', x: latest.x_model1, y: latest.y_model1, style: 'vision-model-one' },
    { name: 'ETH-XGaze', x: latest.x_model2, y: latest.y_model2, style: 'vision-model-two' },
    { name: 'Mean', x: latest.average_x, y: latest.average_y, style: 'vision-mean' },
  ] : []
  const radius = Math.max(3, gaze.viewport_width_px / 145)
  return (
    <div className="vision-feeds">
      <figure>
        <figcaption>Webcam</figcaption>
        <div className="vision-camera">
          {camera ? <img src={`data:image/jpeg;base64,${camera.jpeg}`} alt="Live webcam frame" /> :
            <span>Waiting for the camera…</span>}
        </div>
      </figure>
      <figure>
        <figcaption>Gaze on the selected display</figcaption>
        <div className="vision-viewport">
          <svg viewBox={`0 0 ${gaze.viewport_width_px} ${gaze.viewport_height_px}`}
            role="img" aria-label="Eye tracker estimates in display coordinates">
            {latest?.maxbox && <rect x={latest.maxbox.x} y={latest.maxbox.y} width={latest.maxbox.w}
              height={latest.maxbox.h} className="vision-box" vectorEffect="non-scaling-stroke" />}
            {dots.map(({ name, x, y, style }) => x !== null && y !== null ?
              <circle key={name} cx={x} cy={y} r={radius} className={style}><title>{name}</title></circle> : null)}
          </svg>
          {!latest?.maxbox && <span>Waiting for calibrated gaze…</span>}
        </div>
      </figure>
      <p className="vision-legend vision-gaze-legend"><span className="vision-model-one">WebEyeTrack</span>
        <span className="vision-model-two">ETH-XGaze</span><span className="vision-mean">Mean</span>
        <span className="vision-legend-box">Max box</span></p>
    </div>
  )
}

export default function VisionDebug({ threshold }: { threshold: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<VisionDebugSnapshot | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!open) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const value = await window.setup.visionDebug?.()
        if (disposed) return
        setSnapshot(value ?? null)
        setError(false)
      } catch {
        if (disposed) return
        setSnapshot(null)
        setError(true)
      }
      timer = setTimeout(poll, 400)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [open])

  return (
    <section className="settings-card vision-debug" aria-labelledby="vision-debug-title">
      <div className="settings-row">
        <div>
          <h3 id="vision-debug-title">Vision debugging</h3>
          <p className="perm-why">Live camera, gaze, and the last 60 seconds of confidence. Preview stays on this device.</p>
        </div>
        <button className="btn btn-small" aria-expanded={open} aria-controls="vision-debug-panel"
          onClick={() => { setSnapshot(null); setError(false); setOpen(!open) }}>{open ? 'Close preview' : 'Open preview'}</button>
      </div>
      {open && <div id="vision-debug-panel" className="vision-debug-panel">
        {snapshot ? <>
          <CameraAndGaze snapshot={snapshot} />
          <ConfidenceTimeline snapshot={snapshot} threshold={threshold} />
        </> : <p className="perm-why" role="status">{error ? 'Vision preview is unavailable.' : 'Waiting for the active vision session…'}</p>}
      </div>}
    </section>
  )
}
