// Hidden window: one 720p webcam (no audio) feeding Matt's VisionSession.
// Lanes: WebEyeTrack (model1) in a worker here, confusion in the native Python worker via main.
// ETH-XGaze (model2) is not run on this build; the session falls back to model1 alone.
import { createGazeProjector, loadTrackerProfile, type CalibrationGeometry } from '@vision/calibration.mjs'
import { VisionSession, type ConfusionSample, type IntervalEvent, type Packet } from '@vision/session.mjs'
import { connectWebEyeTrack } from '@vision/webeyetrack.mjs'
import type { LiveGaze, VisionStatus } from '../../../shared/vision'

const api = window.vision
const clockUs = (): number => Math.round((performance.timeOrigin + performance.now() - api.epochMs()) * 1000)

const status: VisionStatus = { camera: 'starting', confusion: 'off', model1: 'off' }
const report = (patch: Partial<VisionStatus>): void => {
  Object.assign(status, patch)
  api.reportStatus({ ...status })
}

// ---------- camera ----------
async function openCamera(): Promise<MediaStreamTrack> {
  for (;;) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false
      })
      report({ camera: 'on', detail: undefined })
      return stream.getVideoTracks()[0]
    } catch (e) {
      const denied = (e as DOMException).name === 'NotAllowedError'
      report({ camera: denied ? 'denied' : 'error', detail: String((e as Error).message ?? e) })
      await new Promise((r) => setTimeout(r, 3000)) // retried after the user grants access in setup
    }
  }
}

// ---------- confusion lane: VideoFrame -> JPEG -> native worker ----------
const jpegCanvas = new OffscreenCanvas(1280, 720)
const jpegCtx = jpegCanvas.getContext('2d')!
async function confusionLane({ frame, timeUs, frameId }: Packet): Promise<unknown> {
  if (jpegCanvas.width !== frame.displayWidth || jpegCanvas.height !== frame.displayHeight) {
    jpegCanvas.width = frame.displayWidth
    jpegCanvas.height = frame.displayHeight
  }
  jpegCtx.drawImage(frame, 0, 0)
  const blob = await jpegCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  const result = (await api.confusion(new Uint8Array(await blob.arrayBuffer()), timeUs, frameId)) as {
    sample: ConfusionSample
  } | null
  if (result?.sample) {
    lastScore = result.sample.valid ? result.sample.confidence : null
    if (status.confusion !== 'on') report({ confusion: 'on' })
    onsetTrigger(timeUs, lastScore)
  }
  return result
}

// ---------- onset trigger ----------
// Matt's interval.finalized arrives when a confusion interval ENDS (or after an 8 s cap). For a
// helper that should appear while the user is still stuck, fire as soon as the smoothed score
// has stayed high for a short confirm window. Main applies the cooldown between nudges.
let trigger = { high: 0.65, confirmMs: 1000 }
let highSince: number | null = null
let peak = 0
let fired = false
function onsetTrigger(timeUs: number, score: number | null): void {
  if (score === null || score < trigger.high) {
    // a single dip below the line (but not far below) doesn't reset the run
    if (score === null || score < trigger.high - 0.2) {
      highSince = null
      fired = false
      peak = 0
    }
    return
  }
  highSince ??= timeUs
  peak = Math.max(peak, score)
  if (!fired && timeUs - highSince >= trigger.confirmMs * 1000) {
    fired = true
    api.reportInterval(gazeOver(highSince - 1_500_000, timeUs), peak)
  }
}

// ---------- gaze bookkeeping ----------
let lastScore: number | null = null
let gazeRing: { t: number; x: number; y: number }[] = [] // normalized 0-1000
let lastGazeSent = 0

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Where the user was looking over a time window: median of valid gaze samples. */
function gazeOver(fromUs: number, toUs: number): LiveGaze | null {
  let rows = gazeRing.filter((g) => g.t >= fromUs && g.t <= toUs)
  if (rows.length < 3) rows = gazeRing.filter((g) => g.t >= toUs - 3_000_000)
  if (rows.length < 3) return null
  return { x: Math.round(median(rows.map((g) => g.x))), y: Math.round(median(rows.map((g) => g.y))) }
}

let wetValid = 0
let wetNull = 0
let wetReasons: Record<string, number> = {}

// ---------- session ----------
let stopSession: (() => void) | null = null

async function run(track: MediaStreamTrack): Promise<void> {
  stopSession?.()
  const config = await api.config()
  const settings = track.getSettings()
  const camera = {
    cameraId: settings.deviceId || 'default-camera',
    cameraWidth: Math.round(settings.width ?? 1280),
    cameraHeight: Math.round(settings.height ?? 720)
  }
  api.reportCamera(camera)
  const geometry: CalibrationGeometry = { ...camera, ...config.display }
  const { sessionId, captureEpoch } = config
  trigger = config.trigger
  highSince = null
  fired = false
  const profile = loadTrackerProfile(window.setup.store, 'model1', geometry)
  const project = createGazeProjector({ tracker: 'model1', geometry, profile, sessionId, captureEpoch })
  gazeRing = []
  lastScore = null
  report({
    confusion: config.workers.confusion ? 'starting' : 'off',
    model1: config.workers.model1 ? 'starting' : 'off',
    calibrated: Boolean(profile)
  })

  const workers: ConstructorParameters<typeof VisionSession>[0]['workers'] = {}
  if (config.workers.confusion) workers.confusion = confusionLane
  let wet: ReturnType<typeof connectWebEyeTrack> | null = null
  if (config.workers.model1) {
    const base = new URL('/wet/', location.href).href
    wet = connectWebEyeTrack(new Worker(base + 'bench-worker.js'), { geometry, sessionId, captureEpoch, assetsBaseUrl: base })
    wet.ready.then(
      () => report({ model1: 'on' }),
      (e) => report({ model1: 'error', detail: `eye model: ${String(e?.message ?? e)}` })
    )
    workers.model1 = (packet) => wet!.send(packet)
  }

  const session = new VisionSession({
    sessionId,
    captureEpoch,
    geometry,
    profiles: profile ? { model1: profile } : {},
    workers,
    clockUs,
    onObservation: (tracker, timeUs, raw) => {
      api.reportObservation(tracker, timeUs, raw) // feeds an active calibration in the setup window
      if (tracker !== 'model1') return
      const r = raw as { wet?: number[] | null; wetReason?: string | null } | null
      if (r?.wet) wetValid++
      else {
        wetNull++
        const why = r ? (r.wetReason ?? 'none') : 'late'
        wetReasons[why] = (wetReasons[why] ?? 0) + 1
      }
      const g = project(timeUs, raw)
      if (g.valid && g.x_px !== null && g.y_px !== null) {
        gazeRing.push({
          t: timeUs,
          x: (g.x_px / (geometry.viewportWidth - 1)) * 1000,
          y: (g.y_px / (geometry.viewportHeight - 1)) * 1000
        })
        while (gazeRing.length && gazeRing[0].t < timeUs - 30_000_000) gazeRing.shift()
      }
      const now = performance.now()
      if (now - lastGazeSent > 100) {
        lastGazeSent = now
        api.reportGaze(gazeOver(timeUs - 400_000, timeUs), lastScore)
      }
    },
    onInterval: (event: IntervalEvent) => {
      api.reportInterval(gazeOver(event.start_us, event.end_us), event.score)
    },
    onError: (error, lane) => {
      console.error(`lane ${lane}:`, error.message)
      if (lane === 'confusion') report({ confusion: 'error', detail: `confusion: ${error.message}` })
    }
  })

  // Frame pump: every camera frame goes to the dispatcher, which paces each lane.
  let running = true
  let frameId = 0
  let lastUs = -1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new (window as any).MediaStreamTrackProcessor({ track, maxBufferSize: 2 }).readable.getReader()
  void (async () => {
    while (running) {
      const { value: frame, done } = (await reader.read()) as { value: VideoFrame; done: boolean }
      if (done) break
      try {
        const t = Math.max(clockUs(), lastUs + 1)
        lastUs = t
        if (running) session.submit(frame, t, ++frameId)
      } catch (e) {
        console.error('submit failed:', (e as Error).message)
      } finally {
        frame.close()
      }
    }
  })()
  // With no eye model, still report the confusion score for the log.
  const tick = window.setInterval(() => {
    if (!config.workers.model1) api.reportGaze(null, lastScore)
  }, 1000)
  // Diagnostics: per-lane delivery and why the eye model had no reading.
  const diag = window.setInterval(() => {
    const st = session.stats()
    const lanes = Object.entries(st).map(([k, v]) => `${k} ok ${v.delivered} late ${v.late} drop ${v.dropped} fail ${v.failed}`).join(' | ')
    console.warn(`STATS ${lanes} | wet valid ${wetValid} null ${wetNull} reasons ${JSON.stringify(wetReasons)} | isolated ${crossOriginIsolated}`)
  }, 4000)

  stopSession = () => {
    running = false
    clearInterval(tick)
    clearInterval(diag)
    void reader.cancel().catch(() => undefined)
    session.close()
    wet?.close()
    stopSession = null
  }
}

const track = await openCamera()
await run(track)
api.onReload(() => void run(track))
