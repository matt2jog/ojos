import { useCallback, useEffect, useRef, useState } from 'react'
import { loadTrackerProfile, saveTrackerProfile, type CalibrationGeometry, type Tracker } from '@vision/calibration.mjs'
import type { CalibrationStage } from '../../../shared/capture'
import type { DisplayInfo, PermissionKind, PermissionState } from '../../../shared/setup'
import { Logo } from '../components/Logo'
import { Calibration, type CalibrationOutcome } from './Calibration'

type Step = 'welcome' | 'permissions' | 'display' | 'prepare' | 'calibrate' | 'fallback' | 'done'
const ORDER: Step[] = ['welcome', 'permissions', 'display', 'calibrate', 'done']
const TRACKERS: Tracker[] = ['model1', 'model2']
const PREPARATION = {
  camera: { milestone: 0, message: 'Connecting to your camera…' },
  trackers: { milestone: 1, message: 'Loading the eye tracker…' },
  secondary: { milestone: 2, message: 'Checking tracker readiness…' }
}

function Mascot(): React.JSX.Element {
  return (
    <svg className="setup-mascot" viewBox="0 0 116 60" width="174" height="90" aria-hidden>
      <defs>
        <linearGradient id="setup-nose" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4285f4" />
          <stop offset="0.35" stopColor="#34a853" />
          <stop offset="0.7" stopColor="#fbbc05" />
          <stop offset="1" stopColor="#ea4335" />
        </linearGradient>
      </defs>
      <rect width="116" height="60" rx="30" fill="#18191c" />
      <g className="setup-eye">
        <circle cx="33" cy="30" r="13" fill="#fff" />
        <circle cx="35" cy="31" r="6.5" fill="#18191c" />
        <circle cx="32.8" cy="28.6" r="2" fill="#fff" />
      </g>
      <path d="M 58 22 C 58.6 30, 59.6 36.5, 57.6 41 C 56.2 44.4, 52.4 45.4, 50.2 43.4" fill="none" stroke="url(#setup-nose)" strokeWidth="4" strokeLinecap="round" />
      <circle cx="51" cy="43.2" r="3.6" fill="#ea4335" />
      <path d="M 58 8 C 58.5 11.9 59.6 13 63.5 13.5 C 59.6 14 58.5 15.1 58 19 C 57.5 15.1 56.4 14 52.5 13.5 C 56.4 13 57.5 11.9 58 8 Z" fill="#fff" className="setup-spark" />
      <g className="setup-eye">
        <circle cx="83" cy="30" r="13" fill="#fff" />
        <circle cx="85" cy="31" r="6.5" fill="#18191c" />
        <circle cx="82.8" cy="28.6" r="2" fill="#fff" />
      </g>
    </svg>
  )
}

function Progress({ step }: { step: Step }): React.JSX.Element {
  const at = ORDER.indexOf(step === 'prepare' || step === 'fallback' ? 'calibrate' : step)
  return (
    <div className="setup-progress">
      {ORDER.map((s, i) => (
        <span key={s} className={i <= at ? 'on' : ''} />
      ))}
    </div>
  )
}

export function SetupApp(): React.JSX.Element {
  const hash = location.hash.replace('#', '')
  const initial: Step = hash === 'calibrate' ? 'display' : ORDER.includes(hash as Step) ? (hash as Step) : 'welcome'
  const [step, setStep] = useState<Step>(initial)
  const [platform, setPlatform] = useState<string>('darwin')
  const [perms, setPerms] = useState<Record<PermissionKind, PermissionState> | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [displayId, setDisplayId] = useState<string>('')
  const [geometry, setGeometry] = useState<CalibrationGeometry | null>(null)
  const [readyTrackers, setReadyTrackers] = useState<Tracker[]>([])
  const [stage, setStage] = useState<CalibrationStage>('camera')
  const [camError, setCamError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const preparation = useRef(0)
  const preparing = useRef(false)
  const mac = platform === 'darwin'
  const selected = displays.find((display) => display.id === displayId)

  useEffect(() => {
    void window.setup.platform().then(setPlatform)
  }, [])

  // ----- permissions: poll while on that step (users flip switches in System Settings) -----
  useEffect(() => {
    if (step !== 'permissions') return
    const check = (): void => void window.setup.permissions().then(setPerms)
    check()
    const t = setInterval(check, 1500)
    return () => clearInterval(t)
  }, [step])

  // Camera preview once allowed.
  useEffect(() => {
    if (step !== 'permissions' || perms?.camera !== 'granted') return
    let disposed = false
    let preview: MediaStream | undefined
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false
    })
      .then((s) => {
        if (disposed) {
          s.getTracks().forEach((track) => track.stop())
          return
        }
        preview = s
        setCamError(null)
        if (videoRef.current && videoRef.current.srcObject !== s) {
          videoRef.current.srcObject = s
          void videoRef.current.play()
        }
      })
      .catch((e) => { if (!disposed) setCamError(String(e.message ?? e)) })
    return () => {
      disposed = true
      preview?.getTracks().forEach((track) => track.stop())
    }
  }, [step, perms?.camera])

  // ----- displays -----
  useEffect(() => {
    if (step !== 'display') return
    let disposed = false
    void window.setup.displays().then(({ displays, selected }) => {
      if (disposed) return
      setDisplays(displays)
      setDisplayId((previous) => displays.some((display) => display.id === previous) ? previous : selected)
    }).catch((error: unknown) => console.warn('Unable to list displays:', error))
    return () => { disposed = true }
  }, [step])

  const startCalibration = useCallback(async (d: DisplayInfo) => {
    if (preparing.current) return
    preparing.current = true
    const attempt = ++preparation.current
    const current = (): boolean => preparation.current === attempt
    setStage('camera')
    setStep('prepare')
    const unsubscribe = window.setup.onCalibrationProgress((stage) => { if (current()) setStage(stage) })
    try {
      await window.setup.selectDisplay(d.id)
      if (!current()) return
      const { trackers, ...camera } = await window.setup.prepareCalibration()
      if (!current()) return
      setGeometry({
        ...camera, displayId: d.id, displayScale: d.scaleFactor, rotationDeg: d.rotationDeg,
        viewportWidth: d.viewportWidth, viewportHeight: d.viewportHeight
      })
      setReadyTrackers(trackers)
      await window.setup.fullscreen(d.id)
      if (current()) setStep('calibrate')
    } catch (error) {
      if (!current()) return
      console.warn('Unable to start live calibration:', error)
      window.setup.stopCalibration()
      setStep('fallback')
    } finally {
      unsubscribe()
      if (current()) preparing.current = false
    }
  }, [])

  const skipPreparation = (): void => {
    ++preparation.current
    preparing.current = false
    window.setup.stopCalibration()
    void window.setup.fullscreen(null)
    setStep('done')
  }

  const onCalibrated = async (outcome: CalibrationOutcome): Promise<void> => {
    window.setup.stopCalibration()
    await window.setup.fullscreen(null)
    if (outcome.kind === 'skipped' || !geometry) {
      setStep('done')
      return
    }
    const { results } = outcome
    const diagnostics = Object.fromEntries(TRACKERS.map((tracker) => {
      const result = results[tracker]
      if (!readyTrackers.includes(tracker)) return [tracker, { status: 'unavailable' }]
      if (result.calibration) saveTrackerProfile(window.setup.store, tracker, geometry, result.calibration)
      return [tracker, { status: result.calibration ? 'passed' : result.reason, metrics: result.metrics }]
    }))
    window.setup.store.setItem('calibration.lastResult', JSON.stringify(diagnostics))
    window.setup.store.setItem('calibration.geometry', JSON.stringify(geometry))
    const hasProfile = TRACKERS.some((tracker) => loadTrackerProfile(window.setup.store, tracker, geometry))
    setStep(hasProfile ? 'done' : 'fallback')
  }

  const permRow = (kind: PermissionKind, title: string, why: string): React.JSX.Element => {
    const state = perms?.[kind] ?? 'unknown'
    const ok = state === 'granted'
    const notNeeded = !mac && kind !== 'camera'
    return (
      <div className={`perm ${ok ? 'ok' : ''}`}>
        <div className="perm-icon">{ok ? '✓' : kind === 'camera' ? '◉' : kind === 'screen' ? '▢' : '♪'}</div>
        <div className="perm-text">
          <div className="perm-title">{title}</div>
          <div className="perm-why">{notNeeded ? 'No permission needed on Windows.' : why}</div>
        </div>
        {!ok && kind !== 'audio' && (
          <button className="btn btn-small" onClick={() => void window.setup.request(kind)}>
            {state === 'not-determined' ? 'Allow' : 'Open Settings'}
          </button>
        )}
        {!ok && kind === 'audio' && <span className="perm-note">Comes with Screen Recording</span>}
      </div>
    )
  }

  return (
    <div className={`setup ${step === 'calibrate' ? 'setup-full' : ''}`}>
      {step !== 'calibrate' && (
        <header className="setup-head">
          <Logo />
          <Progress step={step} />
        </header>
      )}

      {step === 'welcome' && (
        <main className="setup-body center">
          <Mascot />
          <h1 className="hero">Answers to questions you haven&apos;t had time to ask.</h1>
          <p className="sub">
            Ojos notices when you look stuck, sees what you were looking at, and offers help. You stay in control:
            nothing appears unless you pick it.
          </p>
          <ul className="facts">
            <li>Your camera feed and calibration stay on this laptop.</li>
            <li>A short screen clip is sent for analysis only when you ask for help.</li>
          </ul>
          <button className="btn" onClick={() => setStep('permissions')}>
            Get started
          </button>
        </main>
      )}

      {step === 'permissions' && (
        <main className="setup-body">
          <h2>Let Ojos see and hear what you&apos;re working on</h2>
          <div className="perm-layout">
            <div className="perms">
              {permRow('camera', 'Camera', 'To notice when you look confused and where you’re looking.')}
              {permRow('screen', 'Screen Recording', 'To understand what’s on screen when you ask for help.')}
              {permRow('audio', 'System audio', 'To hear videos or lectures you’re watching.')}
              {mac && (
                <p className="hint">
                  Just turned on Screen Recording? macOS needs Ojos to restart.{' '}
                  <button className="link" onClick={() => void window.setup.relaunch()}>
                    Restart Ojos
                  </button>
                </p>
              )}
            </div>
            <div className="cam">
              {perms?.camera === 'granted' && !camError ? (
                <>
                  <video ref={videoRef} muted playsInline />
                  <span className="cam-label">Looking good 👀</span>
                </>
              ) : (
                <span className="cam-empty">{camError ? `Camera error: ${camError}` : 'Camera preview'}</span>
              )}
            </div>
          </div>
          <footer className="setup-foot">
            <button className="link" onClick={() => setStep('display')}>
              Skip for now
            </button>
            <button className="btn" disabled={perms?.camera !== 'granted'} onClick={() => setStep('display')}>
              Continue
            </button>
          </footer>
        </main>
      )}

      {step === 'display' && (
        <main className="setup-body">
          <h2>{displays.length === 1 ? 'Calibrate on your display' : 'Which screen do you work on?'}</h2>
          <p className="sub">{displays.length === 1
            ? 'Ojos will use this display to calibrate eye tracking.'
            : 'Choose the display you want Ojos to record and calibrate on.'}</p>
          <div className="displays">
            {displays.map((display) => {
              const details = (
                <>
                  <span className="display-icon" aria-hidden="true" />
                  <span>
                    <span className="display-name">{display.label}</span>
                    <span className="display-size">
                      {Math.round(display.width * display.scaleFactor)} × {Math.round(display.height * display.scaleFactor)}
                      {displays.length > 1 && display.primary ? ' · Main display' : ''}
                    </span>
                  </span>
                </>
              )
              if (displays.length === 1) return (
                <div key={display.id} className="display single">
                  {details}
                  <span className="display-selected">Selected</span>
                </div>
              )
              return (
                <button key={display.id} type="button" className={`display ${display.id === displayId ? 'sel' : ''}`}
                  aria-pressed={display.id === displayId} onClick={() => setDisplayId(display.id)}>
                  {details}
                </button>
              )
            })}
          </div>
          <footer className="setup-foot">
            <span />
            <button className="btn" disabled={!selected} onClick={() => { if (selected) void startCalibration(selected) }}>
              Calibrate on this screen
            </button>
          </footer>
        </main>
      )}

      {step === 'prepare' && (
        <main className="setup-body prepare-body">
          <section className="cal-preparation" aria-labelledby="cal-preparation-title">
            <h2 id="cal-preparation-title">Preparing calibration</h2>
            <p className="sub" role="status">{PREPARATION[stage].message}</p>
            <progress className="cal-preparation-progress" aria-label="Calibration preparation"
              aria-valuetext={PREPARATION[stage].message} max={4} value={PREPARATION[stage].milestone + 1} />
          </section>
          <footer className="setup-foot">
            <button className="link" onClick={skipPreparation}>Skip calibration</button>
          </footer>
        </main>
      )}

      {step === 'calibrate' && geometry && <Calibration geometry={geometry} onDone={(o) => void onCalibrated(o)} />}

      {step === 'fallback' && (
        <main className="setup-body">
          <h2>Eye tracking isn’t ready yet</h2>
          <p className="sub">Try again with your face in view and the camera available, or continue using screen context.</p>
          <footer className="setup-foot">
            <button className="link" onClick={() => setStep('display')}>Try again</button>
            <button className="btn" onClick={() => setStep('done')}>Continue without eye tracking</button>
          </footer>
        </main>
      )}

      {step === 'done' && (
        <main className="setup-body center">
          <Mascot />
          <h1 className="hero">You&apos;re all set.</h1>
          <ol className="how">
            <li>
              <b>Keep working.</b> Ojos runs quietly in your {mac ? 'menu bar' : 'system tray'}.
            </li>
            <li>
              <b>Look stuck?</b> The eyes peek in with a few questions you might have.
            </li>
            <li>
              <b>Pick one</b> (click or {mac ? '⌥1–3' : 'Alt+1–3'}) and the answer appears. Ignore it and it goes away.
            </li>
          </ol>
          <button className="btn" onClick={() => void window.setup.finish()}>
            Start Ojos
          </button>
        </main>
      )}
    </div>
  )
}
