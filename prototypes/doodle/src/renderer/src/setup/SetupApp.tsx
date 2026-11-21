import { useCallback, useEffect, useRef, useState } from 'react'
import { saveTrackerProfile, type CalibrationGeometry, type FitResult, type Tracker } from '@vision/calibration.mjs'
import type { DisplayInfo, PermissionKind, PermissionState } from '../../../shared/setup'
import type { VisionStatus } from '../../../shared/vision'
import { Logo } from '../components/Logo'
import { Calibration, type CalibrationOutcome } from './Calibration'

type Step = 'welcome' | 'permissions' | 'display' | 'calibrate' | 'result' | 'done'
const ORDER: Step[] = ['welcome', 'permissions', 'display', 'calibrate', 'done']
const TRACKER_NAMES: Record<Tracker, string> = { model1: 'Eye model 1 · WebEyeTrack', model2: 'Eye model 2 · ETH-XGaze' }
const AUTOPILOT = location.search.includes('autopilot')

// Camera is opened once (720p, no audio) and reused for the preview and calibration geometry.
let camera: MediaStream | null = null
async function openCamera(): Promise<MediaStream> {
  if (camera?.active) return camera
  camera = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false
  })
  return camera
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
  const at = ORDER.indexOf(step === 'result' ? 'calibrate' : step)
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
  const [results, setResults] = useState<Record<Tracker, FitResult> | null>(null)
  const [skipped, setSkipped] = useState(false)
  const [camError, setCamError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [vision, setVision] = useState<VisionStatus | null>(null)
  const liveEyes = vision?.model1 === 'on' && !AUTOPILOT

  // Live vision status (eye model + confusion model running in the hidden vision window).
  useEffect(() => {
    void window.vision.status().then(setVision)
    return window.vision.onStatus(setVision)
  }, [])
  const mac = platform === 'darwin'

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
    openCamera()
      .then((s) => {
        setCamError(null)
        if (videoRef.current && videoRef.current.srcObject !== s) {
          videoRef.current.srcObject = s
          void videoRef.current.play()
        }
      })
      .catch((e) => setCamError(String(e.message ?? e)))
  }, [step, perms?.camera])

  // ----- displays -----
  useEffect(() => {
    if (step !== 'display') return
    void window.setup.displays().then(({ displays, selected }) => {
      setDisplays(displays)
      setDisplayId(selected)
      if (displays.length === 1) void startCalibration(displays[0])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const startCalibration = useCallback(async (d: DisplayInfo) => {
    await window.setup.selectDisplay(d.id)
    let cameraId = 'simulated'
    let cameraWidth = 1280
    let cameraHeight = 720
    // With live vision, calibrate against the exact geometry the vision session uses.
    const liveGeometry = AUTOPILOT ? null : await window.vision.geometry()
    try {
      if (AUTOPILOT || liveGeometry) throw new Error('camera owned elsewhere')
      const track = (await openCamera()).getVideoTracks()[0]
      const s = track.getSettings()
      cameraId = s.deviceId || 'default-camera'
      cameraWidth = Math.round(s.width ?? 1280)
      cameraHeight = Math.round(s.height ?? 720)
    } catch {
      /* no camera: simulated geometry keeps the flow usable */
    }
    setGeometry(liveGeometry ?? {
      cameraId,
      cameraWidth,
      cameraHeight,
      displayId: d.id,
      displayScale: d.scaleFactor,
      rotationDeg: d.rotationDeg,
      viewportWidth: d.viewportWidth,
      viewportHeight: d.viewportHeight
    })
    if (!AUTOPILOT) await window.setup.fullscreen(d.id)
    setStep('calibrate')
  }, [])

  const onCalibrated = async (outcome: CalibrationOutcome): Promise<void> => {
    if (!AUTOPILOT) await window.setup.fullscreen(null)
    if (outcome.kind === 'skipped') {
      setSkipped(true)
      setResults(null)
    } else {
      setSkipped(false)
      setResults(outcome.results)
      for (const tracker of Object.keys(outcome.results) as Tracker[]) {
        const r = outcome.results[tracker]
        if (r.calibration && geometry) saveTrackerProfile(window.setup.store, tracker, geometry, r.calibration)
      }
      if (geometry) window.setup.store.setItem('calibration.geometry', JSON.stringify(geometry))
    }
    void window.vision.reload() // fresh capture epoch that loads the new profile
    setStep('result')
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
          <h2>Which screen do you work on?</h2>
          <p className="sub">Ojos records and calibrates on one display.</p>
          <div className="displays">
            {displays.map((d) => (
              <button
                key={d.id}
                className={`display ${displayId === d.id ? 'sel' : ''}`}
                onClick={() => setDisplayId(d.id)}
              >
                <div className="display-shape" style={{ aspectRatio: `${d.width} / ${d.height}` }} />
                <div className="display-name">
                  {d.label}
                  {d.primary ? ' · main' : ''}
                </div>
                <div className="display-size">
                  {d.width} × {d.height}
                </div>
              </button>
            ))}
          </div>
          <footer className="setup-foot">
            <span />
            <button
              className="btn"
              disabled={!displayId}
              onClick={() => {
                const d = displays.find((x) => x.id === displayId)
                if (d) void startCalibration(d)
              }}
            >
              Calibrate on this screen
            </button>
          </footer>
        </main>
      )}

      {step === 'calibrate' && geometry && (
        <Calibration geometry={geometry} live={liveEyes} autopilot={AUTOPILOT} onDone={(o) => void onCalibrated(o)} />
      )}

      {step === 'result' && (
        <main className="setup-body">
          <h2>{skipped ? 'Calibration skipped' : 'Calibration results'}</h2>
          {skipped ? (
            <p className="sub">
              Ojos will still notice when you look stuck. It just won&apos;t know exactly where you were looking, so
              its questions may be less specific. You can recalibrate any time from the menu bar.
            </p>
          ) : (
            <div className="results">
              {results &&
                (Object.keys(results) as Tracker[]).filter((t) => !liveEyes || t === 'model1').map((t) => {
                  const r = results[t]
                  const m = r.metrics
                  return (
                    <div key={t} className={`result ${r.calibration ? 'ok' : 'bad'}`}>
                      <div className="result-mark">{r.calibration ? '✓' : '✕'}</div>
                      <div>
                        <div className="perm-title">{TRACKER_NAMES[t]}</div>
                        <div className="perm-why">
                          {r.calibration
                            ? `Typical error ${Math.round(m.medianErrorPx ?? 0)} px (limit ${Math.round(m.thresholdPx ?? 0)} px)`
                            : r.reason === 'missing_fit_target'
                              ? 'Couldn’t see your eyes on some dots. Check lighting and that your face is in view.'
                              : `Not accurate enough (${Math.round(m.medianErrorPx ?? 0)} px vs ${Math.round(m.thresholdPx ?? 0)} px limit).`}
                        </div>
                      </div>
                    </div>
                  )
                })}
              {results && !results.model1.calibration && (liveEyes || !results.model2.calibration) && (
                <p className="hint">Ojos still works without eye tracking; questions will just be less specific.</p>
              )}
            </div>
          )}
          <footer className="setup-foot">
            <button
              className="link"
              onClick={() => {
                const d = displays.find((x) => x.id === displayId)
                if (d) void startCalibration(d)
                else setStep('display')
              }}
            >
              {skipped ? 'Calibrate now' : 'Try again'}
            </button>
            <button className="btn" onClick={() => setStep('done')}>
              Continue
            </button>
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
