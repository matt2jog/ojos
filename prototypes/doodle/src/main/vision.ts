// Live vision: a hidden window owns the webcam and Matt's VisionSession (models/vision).
// This file is the main-process side: it runs the native confusion worker (NDJSON over
// stdio), relays observations to the setup window for calibration, and keeps the latest gaze.
import { app, BrowserWindow, ipcMain, type Display } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { join, resolve } from 'path'
import { encodedViewport, selectedDisplay, storeGet } from './setup'
import type { LiveGaze, VisionConfig, VisionStatus } from '../shared/vision'

const mac = process.platform === 'darwin'
const ROOT =
  process.env.OJOS_HOME ||
  (mac
    ? join(app.getPath('home'), 'Library', 'Application Support', 'Ojos')
    : join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Ojos'))
const REPO = resolve(app.getAppPath(), '../..')
const CONFUSION_DIR = join(ROOT, 'model-assets', 'confusion-devemo-plus-gru-8hz-1')
const PYTHON = process.env.OJOS_PYTHON || join(ROOT, 'venv', mac ? 'bin/python' : 'Scripts/python.exe')
const WORKER = join(REPO, 'models/vision/native_worker.py')
export const WET_DIST = join(REPO, 'models/eye-tracking/experiments/webeyetrack/dist')

const EPOCH_MS = Date.now() // shared session clock origin for every window
const sessionId = randomUUID()
let captureEpoch = 0

export const visionAvailable = (): { confusion: boolean; model1: boolean } => ({
  confusion: existsSync(join(CONFUSION_DIR, 'confusion.onnx')) && existsSync(PYTHON) && existsSync(WORKER),
  model1: existsSync(join(WET_DIST, 'bench-worker.js'))
})

/** Confusion score that must hold before a nudge: Settings value, then env, then 0.65. */
export const SENSITIVITY_RANGE = [0.65, 0.95] as const
export const clampSensitivity = (v: number): number => Math.min(SENSITIVITY_RANGE[1], Math.max(SENSITIVITY_RANGE[0], v))
export const sensitivity = (): number => {
  const stored = Number(storeGet('trigger.high'))
  if (stored) return clampSensitivity(stored) // user setting: always inside the stable band
  return Number(process.env.OJOS_TRIGGER_HIGH) || SENSITIVITY_RANGE[0] // dev override may go outside it
}

/** Apply changed settings or a new calibration: fresh capture epoch in the vision window. */
export function reloadVision(): void {
  captureEpoch++
  latestGaze = null
  visionWin?.webContents.send('vision:reload')
}

// ---------- native confusion worker ----------
let py: ChildProcessWithoutNullStreams | null = null
let pyReady: Promise<void> | null = null
let nextId = 0
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()

function stopConfusion(): void {
  const p = py
  py = null
  pyReady = null
  for (const w of waiting.values()) w.reject(new Error('confusion worker restarted'))
  waiting.clear()
  if (!p) return
  try {
    p.stdin.write(JSON.stringify({ type: 'close', id: 0 }) + '\n')
  } catch {
    /* already gone */
  }
  setTimeout(() => p.kill(), 500)
}

function startConfusion(epoch: number): Promise<void> {
  stopConfusion()
  const child = spawn(
    PYTHON,
    [WORKER, 'confusion', '--session-id', sessionId, '--capture-epoch', String(epoch), '--artifact', CONFUSION_DIR, '--trigger-profile', process.env.OJOS_TRIGGER || 'demo'],
    { cwd: REPO }
  )
  py = child
  pyReady = new Promise<void>((ready, fail) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: { type: string; id?: number; result?: unknown; error?: string }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type === 'ready') return ready()
      const w = msg.id !== undefined ? waiting.get(msg.id) : undefined
      if (!w) return
      waiting.delete(msg.id!)
      if (msg.type === 'frame.done') w.resolve(msg.result ?? null)
      else w.reject(new Error(msg.error || msg.type))
    })
    child.once('error', fail)
    child.once('exit', (code) => {
      fail(new Error(`confusion worker exited (${code})`))
      if (py === child) {
        py = null
        for (const w of waiting.values()) w.reject(new Error('confusion worker exited'))
        waiting.clear()
      }
    })
  })
  child.stderr.on('data', (d: Buffer) => {
    const s = d.toString()
    if (!/WARN/.test(s)) console.error('[confusion]', s.trim())
  })
  return pyReady
}

// ---------- state shared with the rest of the app ----------
let visionWin: BrowserWindow | null = null
let cameraGeometry: { cameraId: string; cameraWidth: number; cameraHeight: number } | null = null
let latestGaze: (LiveGaze & { at: number }) | null = null
let status: VisionStatus = { camera: 'starting', confusion: 'off', model1: 'off' }
let lastLog = 0

function displayGeometry(d: Display): Pick<VisionConfig['display'], keyof VisionConfig['display']> {
  const vp = encodedViewport(d)
  return {
    displayId: String(d.id),
    displayScale: d.scaleFactor,
    rotationDeg: ([0, 90, 180, 270].includes(d.rotation) ? d.rotation : 0) as 0 | 90 | 180 | 270,
    viewportWidth: vp.width,
    viewportHeight: vp.height
  }
}

/** Latest tracked gaze (0-1000 over the selected display), or null if stale or invalid. */
export function liveGaze(maxAgeMs = 1500): LiveGaze | null {
  if (!latestGaze || Date.now() - latestGaze.at > maxAgeMs) return null
  return { x: latestGaze.x, y: latestGaze.y }
}

export const visionStatus = (): VisionStatus => status

function sendToSetup(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== visionWin && !w.isDestroyed() && w.webContents.getURL().includes('setup.html')) w.webContents.send(channel, ...args)
  }
}

export function startVision(opts: { onInterval(gaze: LiveGaze | null): void; onStatus?(s: VisionStatus): void }): void {
  ipcMain.on('vision:epoch-ms', (e) => (e.returnValue = EPOCH_MS))
  const avail = visionAvailable()
  if (process.argv.includes('--no-vision') || (!avail.confusion && !avail.model1)) {
    console.log('Vision: off (no model assets found, or --no-vision). Hotkey and mouse stand in.')
    ipcMain.handle('vision:geometry', () => null)
    ipcMain.handle('vision:status', () => null)
    ipcMain.handle('vision:reload', () => undefined)
    return
  }
  console.log(`Vision: confusion ${avail.confusion ? 'on' : 'missing'}, eye tracking ${avail.model1 ? 'on' : 'missing'}`)

  ipcMain.handle('vision:config', async (): Promise<VisionConfig> => {
    const a = visionAvailable()
    if (a.confusion) {
      try {
        await startConfusion(captureEpoch)
      } catch (e) {
        console.error('[confusion] failed to start:', (e as Error).message)
        a.confusion = false
      }
    }
    return { sessionId, captureEpoch, epochMs: EPOCH_MS, display: displayGeometry(selectedDisplay()), workers: a,
      trigger: { high: sensitivity(), confirmMs: Number(process.env.OJOS_TRIGGER_MS) || 1000 } }
  })
  ipcMain.handle('vision:confusion', async (_e, jpeg: Uint8Array, timeUs: number, frameId: number) => {
    if (!py || !pyReady) throw new Error('confusion worker is not running')
    await pyReady
    const id = ++nextId
    const reply = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
    py.stdin.write(
      JSON.stringify({ type: 'frame', id, time_us: timeUs, frame_id: frameId, jpeg_base64: Buffer.from(jpeg).toString('base64') }) + '\n'
    )
    return reply
  })
  ipcMain.on('vision:camera', (_e, g: typeof cameraGeometry) => (cameraGeometry = g))
  ipcMain.handle('vision:geometry', () =>
    cameraGeometry ? { ...cameraGeometry, ...displayGeometry(selectedDisplay()) } : null
  )
  ipcMain.handle('vision:status', () => status)
  ipcMain.on('vision:status', (_e, s: VisionStatus) => {
    status = s
    opts.onStatus?.(s)
    sendToSetup('vision:status', s)
  })
  ipcMain.on('vision:observation', (_e, tracker: string, timeUs: number, raw: unknown) =>
    sendToSetup('vision:observation', tracker, timeUs, raw)
  )
  ipcMain.on('vision:gaze', (_e, g: LiveGaze | null, score: number | null) => {
    latestGaze = g ? { ...g, at: Date.now() } : null
    if (Date.now() - lastLog > 2000) {
      lastLog = Date.now()
      console.log(
        `[vision] confusion ${score === null ? 'n/a' : score.toFixed(2)} | gaze ${g ? `${g.x},${g.y}` : 'unavailable'} | cam ${status.camera}`
      )
    }
  })
  ipcMain.on('vision:interval', (_e, gaze: LiveGaze | null, score: number) => {
    console.log(`[vision] confusion interval (peak ${score?.toFixed?.(2)}), gaze ${gaze ? `${gaze.x},${gaze.y}` : 'unavailable'}`)
    opts.onInterval(gaze)
  })
  // New profiles or display: start a fresh capture epoch.
  ipcMain.handle('vision:reload', () => {
    captureEpoch++
    latestGaze = null
    visionWin?.webContents.send('vision:reload')
  })

  visionWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), backgroundThrottling: false }
  })
  if (process.env.ELECTRON_RENDERER_URL) visionWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}/vision.html`)
  else visionWin.loadFile(join(__dirname, '../renderer/vision.html'))
  visionWin.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[vision window]', message)
  })
  // Dev aid: OJOS_TEST_RELOAD=<ms> simulates the post-calibration reload.
  if (process.env.OJOS_TEST_RELOAD) {
    setTimeout(() => {
      console.log('[vision] TEST reload')
      captureEpoch++
      latestGaze = null
      visionWin?.webContents.send('vision:reload')
    }, Number(process.env.OJOS_TEST_RELOAD))
  }
  app.on('will-quit', stopConfusion)
}
