import { VisionSession, connectWebEyeTrack } from '@vision/index.mjs'
import type { Tracker } from '@vision/calibration.mjs'
import type { CalibrationReady, CameraGeometry, CaptureBridge, CaptureSpec, NativeLane, VisionExport } from '../../../shared/capture'
import workletUrl from './pcm.js?url'

declare global {
  interface Window {
    capture: CaptureBridge
    startCapture: (spec: CaptureSpec) => Promise<CameraGeometry | CalibrationReady | null>
    exportVision: (startUs: number, endUs: number) => VisionExport | undefined
    observeCalibration: (enabled: boolean) => Promise<Tracker[]>
    refreshCalibration: () => Promise<void>
  }
  class MediaStreamTrackProcessor {
    constructor(options: { track: MediaStreamTrack; maxBufferSize: number })
    readonly readable: ReadableStream<VideoFrame>
  }
}

const media = window.capture
const localUs = (): number => Math.round(performance.now() * 1000)
let clockOffset = 0
let startUs = 0
let vision: InstanceType<typeof VisionSession> | undefined
const clockUs = (): number => Math.round(localUs() + clockOffset - startUs)

async function syncClock(): Promise<void> {
  let shortest = Infinity
  for (let i = 0; i < 5; i++) {
    const before = localUs()
    const host = await media.clock()
    const after = localUs()
    if (after - before < shortest) {
      shortest = after - before
      clockOffset = host - (before + after) / 2
    }
  }
}

async function frames(
  track: MediaStreamTrack,
  consume: (frame: VideoFrame, timeUs: number) => Promise<void> | void
): Promise<void> {
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader()
  let base: number | undefined
  let previous = -1
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      try {
        base ??= clockUs() - value.timestamp
        const timeUs = Math.max(0, base + value.timestamp)
        if (timeUs < previous) throw new Error('Capture clock reset.')
        if (timeUs === previous) continue
        previous = timeUs
        await consume(value, timeUs)
      } finally {
        value.close()
      }
    }
    throw new Error('Capture track ended.')
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function screenFrames(track: MediaStreamTrack, spec: CaptureSpec): Promise<void> {
  const canvas = new OffscreenCanvas(spec.viewportWidth, spec.viewportHeight)
  const context = canvas.getContext('2d')!
  let next = 0
  await frames(track, async (frame, stamp) => {
    const timeUs = Math.round(stamp / 1000) * 1000
    if (timeUs < next) return
    next = timeUs + 60_000
    context.drawImage(frame, 0, 0, canvas.width, canvas.height)
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
    await media.screen({
      timeUs, width: canvas.width, height: canvas.height,
      sourceWidth: frame.displayWidth, sourceHeight: frame.displayHeight,
      jpeg: new Uint8Array(await jpeg.arrayBuffer())
    })
  })
}

async function playback(track: MediaStreamTrack | undefined): Promise<void> {
  if (track?.readyState !== 'live') throw new Error('The OS did not provide a live playback audio track.')
  track.addEventListener('ended', () => media.ended('Playback audio permission or stream was lost.'), { once: true })
  const context = new AudioContext({ sampleRate: 48_000 })
  try {
    await context.audioWorklet.addModule(workletUrl)
    const proc = new AudioWorkletNode(context, 'ojos-playback-pcm')
    const source = context.createMediaStreamSource(new MediaStream([track]))
    source.connect(proc).connect(context.destination) // the processor's output is silent
    let firstSampleUs: number | undefined
    proc.port.onmessage = ({ data }) => {
      const { contextTime, performanceTime } = context.getOutputTimestamp()
      const position = Number(data.startFrame) / context.sampleRate
      firstSampleUs ??= performanceTime && contextTime !== undefined
        ? performanceTime * 1000 + clockOffset - startUs - contextTime * 1e6
        : clockUs() - context.currentTime * 1e6
      void media.audio({ timeUs: Math.round(firstSampleUs + position * 1e6), pcm: data.pcm })
        .then(() => proc.port.postMessage(null), (e: Error) => media.ended(e.message))
    }
    await context.resume()
  } catch (error) {
    track.stop()
    await context.close()
    throw error
  }
}

function nativeLane(lane: NativeLane): (packet: { frame: VideoFrame; timeUs: number; frameId: number }) => Promise<unknown> {
  let canvas: OffscreenCanvas | undefined
  return async ({ frame, timeUs, frameId }) => {
    if (canvas?.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight)
    }
    canvas.getContext('2d')!.drawImage(frame, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    return media.nativeFrame(lane, { timeUs, frameId, jpeg: new Uint8Array(await blob.arrayBuffer()) })
  }
}

async function startVision(track: MediaStreamTrack, spec: CaptureSpec, camera: CameraGeometry): Promise<Tracker[]> {
  const geometry = { ...camera, displayId: spec.displayId, displayScale: spec.displayScale,
    rotationDeg: spec.rotationDeg, viewportWidth: spec.viewportWidth, viewportHeight: spec.viewportHeight }
  const readyWorkers: Record<string, ReturnType<typeof nativeLane>> = {}
  const load = async (lane: string, setup: () => Promise<void>): Promise<boolean> => {
    try {
      await setup()
      return true
    } catch (error) {
      media.workerError(lane, String(error))
      return false
    }
  }
  const loadNative = (lane: NativeLane): Promise<boolean> => load(lane, async () => {
    await media.nativeReady(lane)
    readyWorkers[lane] = nativeLane(lane)
  })
  const primary = load('model1', async () => {
      const worker = new Worker(new URL('./bench-worker.js', location.href))
      const connection = connectWebEyeTrack(worker, { geometry, sessionId: spec.sessionId,
        captureEpoch: spec.epoch, assetsBaseUrl: new URL('.', location.href).href })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([connection.ready, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('WebEyeTrack initialization timed out.')), 20_000)
        })])
        readyWorkers.model1 = connection.send
      } catch (error) {
        connection.close()
        throw error
      } finally {
        clearTimeout(timeout)
      }
  })
  let secondaryPending = true
  const secondary = loadNative('model2').finally(() => { secondaryPending = false })
  if (spec.mode === 'calibrate') {
    const hasPrimary = await primary
    if (secondaryPending) {
      media.calibrationProgress('secondary')
      // Once a tracker is ready, a slow optional tracker should not hold up setup.
      if (hasPrimary) {
        let grace: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([secondary, new Promise<void>((resolve) => { grace = setTimeout(resolve, 3000) })])
        } finally {
          clearTimeout(grace)
        }
      } else await secondary
    }
    if (!Object.keys(readyWorkers).length) throw new Error('Neither eye tracker could start.')
  } else void loadNative('confusion')
  let observing = spec.mode === 'calibrate'
  const readyTrackers = (): Tracker[] => (['model1', 'model2'] as const)
    .filter((lane) => Object.hasOwn(readyWorkers, lane))
  window.observeCalibration = async (enabled) => {
    observing = enabled
    if (!enabled) return []
    if (!readyTrackers().length) {
      await Promise.any([primary, secondary].map(async (ready) => {
        if (!await ready) throw new Error('Eye tracker unavailable.')
      })).catch(() => { throw new Error('Neither eye tracker is available for calibration.') })
    }
    return readyTrackers()
  }
  const profiles = spec.mode === 'record' ? await media.profiles(geometry) : {}
  const trackers = readyTrackers()
  // A tracker that becomes ready after the first target has missed part of the calibration.
  const workers = spec.mode === 'calibrate' ? { ...readyWorkers } : Object.fromEntries(['model1', 'model2', 'confusion'].map((lane) => [
    lane, async (packet: Parameters<ReturnType<typeof nativeLane>>[0]) => readyWorkers[lane]?.(packet) ?? null
  ]))
  vision = new VisionSession({
    sessionId: spec.sessionId, captureEpoch: spec.epoch, geometry, profiles, workers, clockUs,
    onInterval: media.interval,
    onObservation: (tracker, timeUs, raw) => {
      if (observing) media.observation({ tracker, timeUs, raw })
    },
    onError: (error, lane) => media.workerError(lane, error.message)
  })
  window.refreshCalibration = async () => {
    const updated = await media.profiles(geometry)
    vision?.updateProfiles(updated)
  }
  let frameId = 0
  void frames(track, (frame, timeUs) => vision!.submit(frame, timeUs, ++frameId))
    .catch((error: Error) => media.ended(error.message))
  return trackers
}

window.exportVision = (start, end) => vision?.exportClip(start, end)
window.startCapture = async (spec) => {
  startUs = spec.startUs
  // Open the selected source during Electron's gesture scope, before any async work.
  const desktop = spec.mode === 'record' ? navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor', frameRate: { ideal: 15, max: 15 } },
    audio: spec.loopback
  }) : Promise.resolve(null)
  const camera = navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } },
    audio: false
  })
  const [screenResult, cameraResult, clockResult] = await Promise.allSettled([desktop, camera, syncClock()])
  if (clockResult.status === 'rejected') throw clockResult.reason
  if (screenResult.status === 'rejected') throw screenResult.reason
  if (screenResult.value) {
    const track = screenResult.value.getVideoTracks()[0]
    if (!track || (track.getSettings().displaySurface && track.getSettings().displaySurface !== 'monitor')) {
      throw new Error('The OS did not provide the selected display.')
    }
    track.addEventListener('ended', () => media.ended('Screen sharing ended.'), { once: true })
    void screenFrames(track, spec).catch((error: Error) => media.ended(error.message))
    if (spec.loopback) {
      void playback(screenResult.value.getAudioTracks()[0]).catch((error: Error) => media.audioUnavailable(error.message))
    }
  }
  if (cameraResult.status === 'rejected') {
    if (spec.mode === 'calibrate') throw cameraResult.reason
    media.workerError('camera', String(cameraResult.reason))
    return null
  }
  const track = cameraResult.value.getVideoTracks()[0]
  track.addEventListener('ended', () => media.ended('Camera capture ended.'), { once: true })
  const { deviceId, width, height } = track.getSettings()
  if (!deviceId || !width || !height) throw new Error('Camera did not provide its calibration geometry.')
  const geometry = { cameraId: deviceId, cameraWidth: width, cameraHeight: height }
  if (spec.mode === 'calibrate') media.calibrationProgress('trackers')
  const ready = startVision(track, spec, geometry)
  if (spec.mode === 'calibrate') return { ...geometry, trackers: await ready }
  void ready.catch((error: Error) => media.workerError('vision', error.message))
  return geometry
}
