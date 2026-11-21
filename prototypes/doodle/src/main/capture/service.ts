import { app, BrowserWindow, ipcMain, net, protocol, session, type Display, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { loadTrackerProfile } from '@vision/calibration.mjs'
import { exportVisionSeries } from '@vision/series.mjs'
import { Recorder, writeBundle } from '@recorder'
import type { CalibrationGeometry } from '@vision/calibration.mjs'
import type { AudioBlock, CalibrationReady, CalibrationStage, CameraGeometry, CaptureSpec, Frame, Interval, NativeLane, Observation, VisionExport } from '../../shared/capture'
import { launchNativeVision } from '../nativeVision'
import { displayInfo, storeGet, storeSet } from '../setup'
import { recordingPlatform } from './platform'

const nowUs = (): number => Math.round(performance.now() * 1000)
const scheme = 'ojos-capture'
const partition = 'persist:ojos-capture'
protocol.registerSchemesAsPrivileged([{ scheme, privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true
} }])

type Run = {
  win: BrowserWindow
  spec: CaptureSpec
  display: Display
  recorder: InstanceType<typeof Recorder>
  workers: Map<NativeLane, ReturnType<typeof launchNativeVision>>
  abort: AbortController
  warnings: Set<string>
  lastFrameAt: number
  lastAudioAt: number
  hasCamera: boolean
}

export class RecordingService {
  #active?: Run
  #warmGaze?: ReturnType<typeof launchNativeVision>
  #epoch = 0
  #exporting: Promise<unknown> = Promise.resolve()
  #platform = recordingPlatform()
  #monitor: NodeJS.Timeout

  constructor(
    private onInterval: (event: Interval) => void,
    private onObservation: (observation: Observation) => void,
    private onStop: (reason: string) => void,
    private onCalibrationProgress: (stage: CalibrationStage) => void
  ) {
    const captureSession = session.fromPartition(partition)
    const root = resolve(__dirname, '../renderer')
    captureSession.protocol.handle(scheme, async ({ url }) => {
      const request = new URL(url)
      const file = resolve(root, '.' + decodeURIComponent(request.pathname))
      const location = relative(root, file)
      if (request.hostname !== 'local' || location.startsWith('..') || isAbsolute(location)) return new Response(null, { status: 404 })
      const response = await net.fetch(pathToFileURL(file).href)
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
      return new Response(response.body, { status: response.status, headers })
    })
    captureSession.setPermissionRequestHandler((sender, permission, callback, details) => {
      const owner = this.#active?.win.webContents === sender
      const camera = permission === 'media' && 'mediaTypes' in details &&
        details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'video'
      callback(owner && (camera || (permission === 'display-capture' && this.#active?.spec.mode === 'record')))
    })
    captureSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const active = this.#active
      if (active?.spec.mode !== 'record' || request.frame !== active.win.webContents.mainFrame || !request.videoRequested) {
        callback(null)
        return
      }
      try {
        const video = await this.#platform.source(active.display)
        callback(this.#active === active ? {
          video, ...(active.spec.loopback && request.audioRequested ? { audio: 'loopback' } : {})
        } : null)
      } catch (error) {
        console.warn('[capture]', (error as Error).message)
        callback(null)
      }
    })

    const owner = (event: IpcMainInvokeEvent | IpcMainEvent): Run | undefined => {
      const active = this.#active
      return active?.win.webContents.mainFrame === event.senderFrame ? active : undefined
    }
    ipcMain.handle('capture:clock', (event) => {
      if (owner(event)) return nowUs()
      throw new Error('Capture is closed.')
    })
    ipcMain.handle('capture:screen', (event, frame: Frame) => {
      const active = owner(event)
      if (active?.spec.mode !== 'record') return
      const result = active.recorder.addFrame({ ...frame, sessionId: active.spec.sessionId })
      if (!result) return
      if (result.captureEpoch !== active.spec.epoch || frame.width !== active.spec.viewportWidth || frame.height !== active.spec.viewportHeight) {
        this.stop('Display capture geometry changed.')
        return
      }
      active.lastFrameAt = nowUs()
    })
    ipcMain.handle('capture:audio', (event, block: AudioBlock) => {
      const active = owner(event)
      if (active?.spec.mode !== 'record' || !active.spec.loopback) return
      active.recorder.addAudio({ ...block, sessionId: active.spec.sessionId })
      active.lastAudioAt = nowUs()
    })
    ipcMain.handle('capture:profiles', (event, geometry: CalibrationGeometry) => {
      if (!owner(event)) return {}
      const storage = { getItem: storeGet, setItem: storeSet }
      return Object.fromEntries((['model1', 'model2'] as const).map((tracker) => [tracker, loadTrackerProfile(storage, tracker, geometry)]))
    })
    ipcMain.handle('capture:native-ready', async (event, lane: NativeLane) => {
      const active = owner(event)
      if (!active || !['confusion', 'model2'].includes(lane) || active.workers.has(lane)) throw new Error('Invalid worker request.')
      const warmed = active.spec.mode === 'calibrate' && lane === 'model2' ? this.#warmGaze : undefined
      if (warmed) this.#warmGaze = undefined
      const worker = warmed ?? launchNativeVision(lane, active.spec)
      active.workers.set(lane, worker)
      await worker.ready
    })
    ipcMain.handle('capture:native-frame', (event, lane: NativeLane, frame) => {
      const worker = owner(event)?.workers.get(lane)
      if (!worker) throw new Error('Vision worker is closed.')
      return worker.frame(frame)
    })
    ipcMain.on('capture:interval', (event, interval: Interval) => {
      const active = owner(event)
      if (active?.spec.mode === 'record' && interval.session_id === active.spec.sessionId &&
          interval.capture_epoch === active.spec.epoch) this.onInterval(interval)
    })
    ipcMain.on('capture:observation', (event, point: Observation) => {
      if (owner(event)?.spec.mode === 'calibrate') this.onObservation(point)
    })
    ipcMain.on('capture:calibration-progress', (event, stage: CalibrationStage) => {
      if (owner(event)?.spec.mode === 'calibrate') this.onCalibrationProgress(stage)
    })
    ipcMain.on('capture:ended', (event, reason: string) => {
      if (owner(event)) this.stop(reason)
    })
    ipcMain.on('capture:worker-error', (event, lane: string, reason: string) => {
      const active = owner(event)
      if (active) this.#warn(active, lane, reason)
    })
    ipcMain.on('capture:audio-unavailable', (event, reason: string) => {
      const active = owner(event)
      if (active) this.#warn(active, 'audio', reason)
    })
    this.#monitor = setInterval(() => {
      const active = this.#active
      if (!active) return
      if (active.hasCamera && this.#platform.cameraRevoked()) this.stop('Camera permission was revoked.')
      if (active.spec.mode !== 'record') return
      const now = nowUs()
      if (!this.#platform.screenAllowed()) this.stop('Screen recording permission was revoked.')
      else if (now - active.lastFrameAt > 10_000_000) this.stop('Screen frames stopped arriving.')
      else if (active.lastAudioAt && now - active.lastAudioAt > 5_000_000) this.stop('Playback audio stopped arriving.')
      else if (active.spec.loopback && !active.lastAudioAt && now - active.spec.startUs > 5_000_000) {
        this.#warn(active, 'audio', 'The OS has not delivered playback samples. Clips are screen-only.')
      }
    }, 1500)
    this.#monitor.unref()
  }

  #warn(active: Run, lane: string, reason: string): void {
    if (active.warnings.has(lane)) return
    active.warnings.add(lane)
    console.warn(`[capture:${lane}] ${reason}`)
  }

  isRecording(): boolean { return this.#active?.spec.mode === 'record' }
  isCalibrating(): boolean { return this.#active?.spec.mode === 'calibrate' }
  clock(): number { return nowUs() - (this.#active?.spec.startUs ?? nowUs()) }
  usesDisplay(id: number): boolean { return this.#active?.display.id === id }

  prewarmCalibration(): void {
    if (this.#warmGaze) return
    // ETH-XGaze returns raw gaze and doesn’t depend on display or camera geometry.
    const worker = launchNativeVision('model2', { sessionId: randomUUID(), epoch: 0 })
    this.#warmGaze = worker
    void worker.ready.catch((error: Error) => {
      if (this.#warmGaze !== worker) return
      this.#warmGaze = undefined
      console.warn('[calibration] ETH-XGaze warm-up:', error.message)
    })
  }

  cancelCalibrationWarmup(): void {
    const worker = this.#warmGaze
    this.#warmGaze = undefined
    worker?.close()
  }

  start(display: Display, mode: 'record'): Promise<CameraGeometry | null>
  start(display: Display, mode: 'calibrate'): Promise<CalibrationReady>
  async start(display: Display, mode: CaptureSpec['mode']): Promise<CameraGeometry | CalibrationReady | null> {
    this.stop()
    if (mode === 'record' && !this.#platform.screenAllowed()) throw new Error('Screen recording permission is required.')
    const recorder = new Recorder()
    // Each Worker lifetime has a unique session ID. The outer epoch also invalidates late vision IPC.
    const epoch = ++this.#epoch
    const sessionId = recorder.start(epoch)
    const { viewportWidth, viewportHeight, scaleFactor, rotationDeg } = displayInfo(display)
    const spec = {
      sessionId, epoch, startUs: nowUs(), mode, displayId: String(display.id),
      displayScale: scaleFactor, rotationDeg, viewportWidth, viewportHeight, loopback: this.#platform.loopback
    }
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/capture.js'), partition,
        contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
      }
    })
    const active: Run = { win, spec, display, recorder, workers: new Map(), abort: new AbortController(),
      warnings: new Set(), lastFrameAt: spec.startUs, lastAudioAt: 0, hasCamera: false }
    this.#active = active
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.once('render-process-gone', () => {
      if (this.#active === active) this.stop('The capture worker exited.')
    })
    const dev = process.env.ELECTRON_RENDERER_URL
    try {
      await win.loadURL(dev ? new URL('capture.html', dev).href : `${scheme}://local/capture.html`)
      const geometry: CameraGeometry | CalibrationReady | null = await win.webContents.executeJavaScript(`window.startCapture(${JSON.stringify(spec)})`, true)
      if (this.#active !== active) throw new Error('Capture was interrupted.')
      active.hasCamera = Boolean(geometry)
      if (mode === 'record' && !spec.loopback) this.#warn(active, 'audio', 'This macOS version is running screen-only capture.')
      return geometry
    } catch (error) {
      if (this.#active === active) this.stop()
      throw error
    }
  }

  stop(reason?: string): void {
    const active = this.#active
    if (!active) return
    this.#active = undefined
    active.abort.abort()
    active.recorder.stop()
    for (const worker of active.workers.values()) worker.close()
    if (!active.win.isDestroyed()) active.win.destroy()
    if (reason) this.onStop(reason)
  }

  close(): void {
    this.stop()
    this.cancelCalibrationWarmup()
    clearInterval(this.#monitor)
  }

  async clip(interval: Interval | undefined, signal: AbortSignal) {
    const active = this.#active
    if (active?.spec.mode !== 'record') throw new Error('Recording is not active.')
    const request = AbortSignal.any([signal, active.abort.signal])
    const now = this.clock()
    if (interval) {
      if (interval.session_id !== active.spec.sessionId || interval.capture_epoch !== active.spec.epoch) throw new Error('Stale capture interval.')
      const delay = Math.max(0, (interval.end_us + 1_000_000 - now) / 1000 + 90)
      await sleep(delay, undefined, { signal: request })
    }
    request.throwIfAborted()
    const { recorder, spec } = active
    const clip = interval ? recorder.interval(interval, this.clock()) : recorder.manual(now)
    const { clip_start_us: start, clip_end_us: end } = clip.manifest
    const vision: VisionExport | undefined = await active.win.webContents.executeJavaScript(`window.exportVision(${start},${end})`)
    const sidecar: VisionExport = vision ?? exportVisionSeries({ sessionId: spec.sessionId, captureEpoch: spec.epoch,
      clipStartUs: start, clipEndUs: end, width: spec.viewportWidth, height: spec.viewportHeight })
    const evidenceUs = Math.min(end, clip.manifest.event_end_us)
    const sample = sidecar.gaze.samples.slice(0, Math.floor((evidenceUs - start) / 200_000) + 1)
      .slice(-5).findLast((sample) => sample.average_x !== null && sample.average_y !== null)
    const gaze = sample ? {
      x: Math.round(sample.average_x! / spec.viewportWidth * 1000),
      y: Math.round(sample.average_y! / spec.viewportHeight * 1000)
    } : undefined
    const still = clip.frames.findLast((frame) => frame.timeUs < evidenceUs) ?? clip.frames[0]
    const result = { ...clip, ...sidecar, manifest: { ...clip.manifest, gaze_status: sidecar.gaze_status } }
    const save = this.#exporting.then(() => {
      request.throwIfAborted()
      return writeBundle(result, app.getPath('temp'), { signal: request })
    })
    this.#exporting = save.catch(() => {})
    return { saved: save, still: still.jpeg.toString('base64'), gaze }
  }
}
