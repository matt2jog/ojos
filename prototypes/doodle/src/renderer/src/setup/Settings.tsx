import { useEffect, useState } from 'react'
import { loadTrackerProfile } from '@vision/calibration.mjs'
import type { AppSettings } from '../../../shared/setup'
import type { VisionStatus } from '../../../shared/vision'

interface Props {
  vision: VisionStatus | null
  onRecalibrate(): void
  onRunSetup(): void
}

const LANE: Record<string, string> = { on: 'Running', starting: 'Starting…', off: 'Not installed', error: 'Error' }

export function Settings({ vision, onRecalibrate, onRunSetup }: Props): React.JSX.Element {
  const [s, setS] = useState<AppSettings | null>(null)
  const [sens, setSens] = useState(0.65)
  const [errorPx, setErrorPx] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    void window.setup.settings().then((v) => {
      setS(v)
      setSens(v.sensitivity)
    })
    // Current calibration, read from the same local profile the vision session loads.
    void window.vision.geometry().then((g) => {
      if (!g) return setErrorPx(null)
      const profile = loadTrackerProfile(window.setup.store, 'model1', g) as { metrics?: { medianErrorPx?: number } } | null
      setErrorPx(profile?.metrics?.medianErrorPx ?? null)
    })
  }, [])

  const eager = sens <= 0.5 ? 'Eager: offers help often' : sens >= 0.8 ? 'Reserved: only when you look very stuck' : 'Balanced'

  return (
    <main className="setup-body settings">
      <h2>Settings</h2>

      <section className="card">
        <div className="card-row">
          <div>
            <div className="perm-title">Eye tracking</div>
            <div className="perm-why">
              {vision?.model1 !== 'on'
                ? `Eye model: ${LANE[vision?.model1 ?? 'off']}`
                : errorPx === undefined
                  ? 'Checking calibration…'
                  : errorPx === null
                    ? 'Not calibrated for this camera and screen. Ojos is using a rough guess.'
                    : `Calibrated. Typical error ${Math.round(errorPx)} px.`}
            </div>
          </div>
          <button className="btn btn-small" onClick={onRecalibrate}>
            {errorPx ? 'Recalibrate' : 'Calibrate'}
          </button>
        </div>
        <div className="perm-why tip">Recalibrate after moving your laptop, changing lighting, or switching screens.</div>
      </section>

      <section className="card">
        <div className="perm-title">How easily Ojos offers help</div>
        <div className="slider-row">
          <span>Eager</span>
          <input
            type="range"
            min={0.35}
            max={0.9}
            step={0.05}
            value={sens}
            onChange={(e) => setSens(Number(e.target.value))}
            onPointerUp={() => void window.setup.setSensitivity(sens)}
            onKeyUp={() => void window.setup.setSensitivity(sens)}
          />
          <span>Reserved</span>
        </div>
        <div className="perm-why">
          {eager}. Ojos appears when your confusion score stays above {sens.toFixed(2)} for a second.
        </div>
      </section>

      <section className="card">
        <div className="perm-title">Status</div>
        <dl className="status">
          <dt>Camera</dt>
          <dd>{vision ? (vision.camera === 'on' ? 'On' : vision.camera) : 'Vision is off'}</dd>
          <dt>Confusion model</dt>
          <dd>{LANE[vision?.confusion ?? 'off']}</dd>
          <dt>Screen Recording</dt>
          <dd className={s?.screenPermission === 'granted' ? '' : 'warn'}>
            {s?.screenPermission === 'granted' ? 'Allowed' : 'Not allowed'}
            {s && s.screenPermission !== 'granted' && (
              <button className="link" onClick={() => void window.setup.request('screen')}>
                Open Settings
              </button>
            )}
          </dd>
          <dt>Gemini</dt>
          <dd>{s ? (s.mock ? 'Demo answers (no API key found)' : `${s.suggestModel} suggests, ${s.explainModel} answers`) : '…'}</dd>
        </dl>
      </section>

      <footer className="setup-foot">
        <div className="foot-links">
          <button className="link" onClick={onRunSetup}>
            Run setup again
          </button>
          <button className="link danger" onClick={() => void window.setup.quit()}>
            Quit Ojos
          </button>
        </div>
        <button className="btn" onClick={() => void window.setup.close()}>
          Done
        </button>
      </footer>
    </main>
  )
}
