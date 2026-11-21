import { app, BrowserWindow, globalShortcut, screen, ipcMain, Menu, nativeImage, powerMonitor, Tray, type Display } from 'electron'
import { join } from 'path'
import { readFile, rm } from 'node:fs/promises'
import { analyzeBundle } from '@assistant'
import { streamGemini } from './gemini'
import type { Cmd, Gaze } from '../shared/commands'
import type { Interval } from '../shared/capture'
import { calibrationDisplay, configuredDisplay, openSetup, registerSetupIpc, selectedDisplay, setupContents, setupDone } from './setup'
import { RecordingService } from './capture/service'
import { assistant, stopAssistant } from './assistant'
import { configureRuntime } from './runtime'

if (process.env.OJOS_USER_DATA) app.setPath('userData', process.env.OJOS_USER_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
configureRuntime()
const EXPLAIN_MODEL = process.env.GEMINI_MODEL || 'gemini-4-neon' // smart: answers it
const DOODLES = process.argv.includes('--doodles') || process.env.DOODLES === '1'
const PICK_KEYS = ['Alt+1', 'Alt+2', 'Alt+3']

let win: BrowserWindow
let display: Display
let runId = 0
let capture: RecordingService | undefined
let request: AbortController | undefined
const center: Gaze = { x: 500, y: 500 } // placement only, never sent as gaze evidence

function createOverlay(): void {
  display = selectedDisplay()
  win = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setContentProtection(true) // keep the overlay out of screen captures

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

let pending: { gaze?: Gaze; still: string; questions: string[] } | null = null

function setPickKeys(on: boolean): void {
  for (const k of PICK_KEYS) globalShortcut.unregister(k)
  if (!on) return
  PICK_KEYS.forEach((k, i) =>
    globalShortcut.register(k, () => {
      const q = pending?.questions[i]
      if (q) void explain(q)
    })
  )
}

let paused = false

/** Confusion detected: show the mascot and start guessing the question. Never explains on its own. */
async function nudge(interval?: Interval): Promise<void> {
  if (paused || !capture?.isRecording()) return
  request?.abort()
  request = new AbortController()
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
  const myRun = ++runId
  pending = null
  setPickKeys(false)
  let folder: string | undefined
  try {
    const clip = await capture.clip(interval, signal)
    if (myRun === runId) {
      pending = { gaze: clip.gaze, still: clip.still, questions: [] }
      win.webContents.send('nudge', clip.gaze ?? center)
      setPickKeys(true)
    }
    folder = await clip.saved
    if (myRun !== runId) return
    const [connection, manifest, gaze, video] = await Promise.all([
      assistant(),
      readFile(join(folder, 'manifest.json'), 'utf8').then(JSON.parse),
      readFile(join(folder, 'gaze.json'), 'utf8').then(JSON.parse),
      readFile(join(folder, 'video.mp4'), { signal })
    ])
    if (myRun !== runId) return
    const result = await analyzeBundle({ ...connection, manifest, gaze, video, signal })
    if (myRun !== runId || !pending) return
    pending.questions = result.possible_questions
    win.webContents.send('suggest', { stuck_on: result.suspected_confusion, questions: result.possible_questions, summary: result.summary })
  } catch (e) {
    if (signal.aborted || myRun !== runId) return
    console.error('suggest failed:', e)
    if (pending) win.webContents.send('suggest', { stuck_on: '', questions: [] })
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch((error) => console.error('Clip cleanup failed:', error))
  }
}

/** User picked a question (or clicked the mascot): stream the answer. Replaces any open answer. */
async function explain(question?: string): Promise<void> {
  if (!pending || paused) return
  request?.abort()
  request = new AbortController()
  const myRun = ++runId
  const isCurrent = (): boolean => myRun === runId
  const onCmd = (cmd: Cmd): void => {
    if (isCurrent()) win.webContents.send('cmd', cmd)
  }
  setPickKeys(false)

  const { gaze, still } = pending
  pending = null
  win.webContents.send('reset', { gaze: gaze ?? center, model: EXPLAIN_MODEL })

  try {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (!apiKey) throw new Error('Set GEMINI_API_KEY to use the live question explainer.')
    await streamGemini({
      apiKey,
      model: EXPLAIN_MODEL,
      jpegBase64: still,
      gaze,
      question,
      doodles: DOODLES,
      isCurrent,
      onCmd,
      signal: request.signal
    })
    if (isCurrent()) win.webContents.send('done')
  } catch (e) {
    console.error(e)
    if (isCurrent()) win.webContents.send('error', String((e as Error).message ?? e))
  }
}

function dismiss(): void {
  runId++
  request?.abort()
  request = undefined
  pending = null
  setPickKeys(false)
  if (win && !win.isDestroyed()) win.webContents.send('dismiss')
}

ipcMain.on('dismiss', dismiss)
ipcMain.on('accept', (_e, question?: string) => void explain(question))
ipcMain.on('nudge-hidden', () => {
  // Ignored (timed out): forget it. Doesn't touch an answer that's already open.
  if (pending) request?.abort()
  pending = null
  setPickKeys(false)
})
ipcMain.on('mouse', (_e, overUi: boolean) => win.setIgnoreMouseEvents(!overUi, { forward: true }))

// ---------- menu-bar / tray ----------
let tray: Tray | null = null

function refreshTray(): void {
  if (!tray) return
  tray.setToolTip(paused ? 'Ojos (paused)' : 'Ojos')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: paused ? 'Ojos is paused' : 'Ojos is watching for confusion', enabled: false },
      { type: 'separator' },
      { label: 'Help me with this now', accelerator: 'CommandOrControl+Shift+O', click: () => void nudge() },
      {
        label: paused ? 'Resume' : 'Pause',
        click: () => {
          paused = !paused
          if (paused) {
            dismiss()
            capture?.stop()
          } else void startRecording()
          refreshTray()
        }
      },
      { label: 'Recalibrate eyes…', click: () => runSetup('calibrate') },
      { label: 'Run setup again…', click: () => runSetup('welcome') },
      { type: 'separator' },
      { label: 'Quit Ojos', accelerator: 'CommandOrControl+Shift+Q', click: () => app.quit() }
    ])
  )
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  refreshTray()
}

/** Show the setup window; the overlay is (re)created on the chosen display when it closes. */
function runSetup(startAt: string): void {
  const existing = setupContents()
  if (existing) {
    const window = BrowserWindow.fromWebContents(existing)
    window?.show()
    window?.focus()
    return
  }
  paused = true
  dismiss()
  capture?.stop()
  openSetup({
    startAt,
    onDone: (completed) => {
      capture?.stop()
      capture?.cancelCalibrationWarmup()
      paused = !completed
      if (win && !win.isDestroyed() && String(selectedDisplay().id) !== String(display.id)) {
        win.destroy()
        createOverlay()
        win.webContents.once('did-finish-load', () => win.webContents.send('ready', `${modeLabel()}|${modKey()}`))
      }
      if (completed) void startRecording()
      refreshTray()
    }
  })
  capture?.prewarmCalibration()
  refreshTray()
}

const modKey = (): string => (process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
const modeLabel = (): string => `Live clip analysis → ${EXPLAIN_MODEL}`

registerSetupIpc()

async function startRecording(): Promise<void> {
  const target = configuredDisplay()
  if (!setupDone() || setupContents() || !target) {
    paused = true
    refreshTray()
    return
  }
  try {
    if (!capture) throw new Error('This platform does not have a recording adapter.')
    if (!capture.isRecording()) await capture.start(target, 'record')
  } catch (error) {
    if (setupContents()) return
    paused = true
    refreshTray()
    console.warn('Recording did not start:', (error as Error).message)
  }
}

ipcMain.handle('setup:prepare-calibration', async (event) => {
  const target = calibrationDisplay()
  if (event.sender !== setupContents() || !target || !capture) throw new Error('Live calibration is unavailable.')
  return capture.start(target, 'calibrate')
})
ipcMain.handle('setup:calibration-clock', (event) => {
  if (event.sender !== setupContents() || !capture?.isCalibrating()) throw new Error('Calibration is unavailable.')
  return capture.clock()
})
ipcMain.on('setup:stop-calibration', (event) => {
  if (event.sender === setupContents() && !capture?.isRecording()) {
    capture?.stop()
    capture?.cancelCalibrationWarmup()
  }
})

app.on('window-all-closed', () => {
  /* stay alive in the menu bar */
})

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide()
  createOverlay()
  createTray()
  try {
    capture = new RecordingService(
      (interval) => void nudge(interval),
      (observation) => setupContents()?.send('setup:gaze', observation),
      (reason) => {
        if (!setupContents()) {
          paused = true
          dismiss()
          refreshTray()
        }
        console.warn('Recording stopped:', reason)
      },
      (stage) => setupContents()?.send('setup:calibration-progress', stage)
    )
  } catch (error) {
    console.warn((error as Error).message)
  }
  if (!setupDone() || !configuredDisplay() || process.argv.includes('--setup')) runSetup('welcome')
  else void startRecording()

  let resumeAfterSleep = false
  powerMonitor.on('suspend', () => {
    resumeAfterSleep = !paused && !!capture?.isRecording()
    dismiss()
    capture?.stop('Computer suspended.')
  })
  powerMonitor.on('resume', () => {
    if (resumeAfterSleep && !setupContents()) {
      paused = false
      void startRecording()
      refreshTray()
    }
    resumeAfterSleep = false
  })
  screen.on('display-removed', (_event, removed) => {
    if (capture?.usesDisplay(removed.id)) capture.stop('Selected display was disconnected.')
  })
  screen.on('display-metrics-changed', (_event, changed, metrics) => {
    if (capture?.usesDisplay(changed.id) && metrics.some((metric) => ['bounds', 'scaleFactor', 'rotation'].includes(metric))) {
      capture.stop('Display geometry changed.')
    }
    if (display.id === changed.id) {
      display = changed
      win.setBounds(changed.bounds)
    }
  })

  const keys: Record<string, () => void> = {
    'CommandOrControl+Shift+O': () => {
      void nudge()
    },
    'CommandOrControl+Shift+X': dismiss,
    'CommandOrControl+Shift+Q': () => app.quit()
  }
  for (const [k, fn] of Object.entries(keys)) {
    if (!globalShortcut.register(k, fn)) console.warn(`!! Could not register ${k}; another app is using it.`)
  }

  const mac = process.platform === 'darwin'
  const mod = modKey()
  const mode = modeLabel()
  console.log(`Ojos ready (${mode}${DOODLES ? ', doodles on' : ''}).`)
  console.log(`  ${mod}+Shift+O = ask about the last 20 seconds`)
  console.log(`  ${mac ? 'Option' : 'Alt'}+1/2/3 = pick a suggested question`)
  console.log(`  ${mod}+Shift+X = dismiss    ${mod}+Shift+Q = quit`)
  win.webContents.once('did-finish-load', () => win.webContents.send('ready', `${mode}|${mod}`))

})

app.on('before-quit', () => {
  request?.abort()
  capture?.close()
  stopAssistant()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
