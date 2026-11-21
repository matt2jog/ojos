import { useEffect, useState } from 'react'
import { TRIGGER_RANGE, type AppSettings } from '../../../shared/setup'

const CONFUSION_STATUS = {
  running: 'Running',
  starting: 'Starting…',
  unavailable: 'Unavailable',
  stopped: 'Stopped'
}

export function Settings(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sensitivity = draft ?? settings?.sensitivity ?? TRIGGER_RANGE.default

  useEffect(() => {
    let disposed = false
    const read = (): void => {
      void window.setup.settings().then((value) => {
        if (!disposed) setSettings(value)
      }).catch(() => {
        if (!disposed) setError('Couldn’t load Ojos Settings.')
      })
    }
    read()
    const timer = setInterval(read, 1800)
    return () => { disposed = true; clearInterval(timer) }
  }, [])

  const saveSensitivity = (value: number): void => {
    if (!settings || value === settings.sensitivity) return
    setError(null)
    void window.setup.setSensitivity(value).then(() => {
      setSettings((previous) => previous && { ...previous, sensitivity: value })
      setDraft((previous) => previous === value ? null : previous)
    }).catch(() => setError('Couldn’t save the sensitivity setting.'))
  }

  const go = (view: 'calibrate' | 'welcome'): void => {
    void window.setup.settingsSetup(view).catch(() => setError('Couldn’t open setup.'))
  }

  const gazeLabel = settings?.calibration === true ? 'Calibrated for the current camera and display.' :
    settings?.calibration === false ? 'Calibration is available for this camera and display.' :
    'Calibration is checked when the camera is active.'
  const description = sensitivity < 0.75 ? 'Offers help more readily.' : sensitivity > 0.85 ?
    'Waits for stronger evidence before offering help.' : 'Balanced.'

  return (
    <main className="setup-body settings">
      <h2>Settings</h2>
      <section className="settings-card settings-row" aria-labelledby="eye-settings">
        <div>
          <h3 id="eye-settings">Eye tracking</h3>
          <p className="perm-why">{gazeLabel}</p>
        </div>
        <button className="btn btn-small" onClick={() => go('calibrate')}>Recalibrate</button>
      </section>

      <section className="settings-card" aria-labelledby="sensitivity-title">
        <h3 id="sensitivity-title">How easily Ojos offers help</h3>
        <div className="settings-slider">
          <span>Eager</span>
          <input type="range" aria-labelledby="sensitivity-title" aria-describedby="sensitivity-description"
            min={TRIGGER_RANGE.min} max={TRIGGER_RANGE.max} step={0.01} value={sensitivity} disabled={!settings}
            onChange={(event) => setDraft(event.currentTarget.valueAsNumber)}
            onPointerUp={(event) => saveSensitivity(event.currentTarget.valueAsNumber)}
            onKeyUp={(event) => saveSensitivity(event.currentTarget.valueAsNumber)}
            onBlur={(event) => saveSensitivity(event.currentTarget.valueAsNumber)}
          />
          <span>Reserved</span>
        </div>
        <p id="sensitivity-description" className="perm-why">{description}</p>
      </section>

      <section className="settings-card" aria-labelledby="status-title">
        <h3 id="status-title">Status</h3>
        <dl className="settings-status">
          <dt>Recording</dt>
          <dd>{settings ? (settings.recording ? 'Buffering on this laptop' : 'Stopped') : 'Checking…'}</dd>
          <dt>Camera</dt>
          <dd>{settings ? (settings.camera ? 'On' : 'Off') : 'Checking…'}</dd>
          <dt>Confusion model</dt>
          <dd>{settings ? CONFUSION_STATUS[settings.confusion] : 'Checking…'}</dd>
          <dt>Screen Recording</dt>
          <dd>
            {settings ? (settings.screenPermission === 'granted' ? 'Allowed' : 'Permission required') : 'Checking…'}
            {settings && settings.screenPermission !== 'granted' && (
              <button className="link" onClick={() => void window.setup.request('screen')}>Open system settings</button>
            )}
          </dd>
          <dt>Clip analysis</dt>
          <dd>{settings ? { local: 'Local assistant configured', remote: 'Remote endpoint configured',
            unconfigured: 'Needs configuration' }[settings.clipAssistant] : 'Checking…'}</dd>
          <dt>Gemini chat</dt>
          <dd>{settings ? (settings.chatConfigured ? 'Configured' : 'Needs a Gemini key') : 'Checking…'}</dd>
        </dl>
      </section>

      {error && <p className="perm-why settings-error" role="alert">{error}</p>}
      <footer className="setup-foot">
        <button className="link" onClick={() => go('welcome')}>Run setup again</button>
        <button className="btn" onClick={() => void window.setup.closeSettings()}>Done</button>
      </footer>
    </main>
  )
}
