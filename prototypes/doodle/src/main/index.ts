import { app, BrowserWindow, globalShortcut, screen, ipcMain, Menu, nativeImage, powerMonitor, Tray, type Display } from 'electron'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { analyzeBundle } from '@assistant'
import type { Gaze } from '../shared/commands'
import type { Interval } from '../shared/capture'
import { calibrationDisplay, configuredDisplay, openSetup, registerSetupIpc, selectedDisplay, setupContents, setupDone, storeGet, storeSet } from './setup'
import { RecordingService } from './capture/service'
import { assistant, chatHistory, stopAssistant, streamChatTurn } from './assistant'
import { configureRuntime } from './runtime'

if (process.env.OJOS_USER_DATA) app.setPath('userData', process.env.OJOS_USER_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
configureRuntime()
const DOODLES = process.argv.includes('--doodles') || process.env.DOODLES === '1'
const PICK_KEYS = ['Alt+1', 'Alt+2', 'Alt+3']

let win: BrowserWindow
let display: Display
let runId = 0
let capture: RecordingService | undefined
let nudgeRequest: AbortController | undefined
let chatRequest: AbortController | undefined
let chatId: string | undefined
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

let pending: {
  gaze?: Gaze; still: string; questions: string[]; summary?: string
} | null = null

function setPickKeys(on: boolean): void {
  for (const k of PICK_KEYS) globalShortcut.unregister(k)
  if (!on) return
  PICK_KEYS.forEach((k, i) =>
    globalShortcut.register(k, () => {
      const q = pending?.questions[i]
      if (q) void ask(q, true)
    })
  )
}

let paused = false

/** Confusion detected: show the mascot and start guessing the question. Never explains on its own. */
async function nudge(interval?: Interval): Promise<void> {
  if (paused || chatRequest || !capture?.isRecording()) return
  nudgeRequest?.abort()
  nudgeRequest = new AbortController()
  const signal = AbortSignal.any([nudgeRequest.signal, AbortSignal.timeout(120_000)])
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
    pending.summary = result.summary
    win.webContents.send('suggest', { stuck_on: result.suspected_confusion ?? '', questions: result.possible_questions, summary: result.summary })
  } catch (e) {
    if (signal.aborted || myRun !== runId) return
    console.error('suggest failed:', e)
    if (pending) win.webContents.send('suggest', { stuck_on: '', questions: [] })
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch((error) => console.error('Clip cleanup failed:', error))
  }
}

/** Taking a fresh screen suggestion opens a chat. Typed follow-ups reuse its ID. */
async function ask(question: string | undefined, picked = false): Promise<void> {
  if (paused || chatRequest || (question !== undefined && typeof question !== 'string')) return
  const message = question?.trim() || 'Explain what I’m looking at.'
  if (message.length > 8000) return
  const evidence = (!chatId || picked) && pending ? pending : undefined
  const fresh = !chatId || Boolean(evidence)
  const id = fresh ? randomUUID() : chatId!
  const controller = new AbortController()
  chatId = id
  chatRequest = controller
  const current = (): boolean => chatRequest === controller && !win.isDestroyed()
  if (nudgeRequest) clearNudge()
  win.webContents.send('reset', { gaze: evidence?.gaze, question: message, fresh })

  try {
    const answer = await streamChatTurn({
      chatId: id, turnId: randomUUID(), message, screenContext: evidence?.summary, jpeg: evidence?.still,
      doodles: DOODLES && Boolean(evidence?.still),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)])
    }, (event) => {
      if (!current()) return
      if (event.kind === 'doodle') win.webContents.send('cmd', event.command)
      else win.webContents.send(event.kind === 'status' ? 'chat-status' : 'chat-delta', event.text)
    })
    if (current()) {
      storeSet('chat.lastId', id)
      refreshTray()
      win.webContents.send('chat-answer', answer)
      win.webContents.send('done')
    }
  } catch (e) {
    if (current()) win.webContents.send('error', String((e as Error).message ?? e))
  } finally {
    if (chatRequest === controller) chatRequest = undefined
  }
}

function clearNudge(): void {
  runId++
  nudgeRequest?.abort()
  nudgeRequest = undefined
  pending = null
  setPickKeys(false)
}

async function openLastChat(): Promise<void> {
  const id = storeGet('chat.lastId')
  if (paused || chatRequest || !id || !/^[a-f0-9-]{36}$/.test(id)) return
  const controller = new AbortController()
  chatRequest = controller
  clearNudge()
  try {
    const turns = await chatHistory(id, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]))
    if (chatRequest !== controller || win.isDestroyed()) return
    chatId = id
    win.webContents.send('chat-history', turns)
    win.webContents.send('chat')
  } catch (error) {
    if (chatRequest === controller && !win.isDestroyed()) {
      win.webContents.send('chat')
      win.webContents.send('error', (error as Error).message)
    }
  } finally {
    if (chatRequest === controller) chatRequest = undefined
  }
}

function dismiss(): void {
  clearNudge()
  chatRequest?.abort()
  chatRequest = undefined
  chatId = undefined
  if (win && !win.isDestroyed()) {
    win.setFocusable(false)
    win.webContents.send('dismiss')
  }
}

const fromOverlay = (event: Electron.IpcMainEvent): boolean =>
  Boolean(win && !win.isDestroyed() && event.senderFrame === win.webContents.mainFrame)
ipcMain.on('dismiss', (event) => { if (fromOverlay(event)) dismiss() })
ipcMain.on('accept', (event, question?: string) => { if (fromOverlay(event) && (pending || chatId)) void ask(question, true) })
ipcMain.on('ask', (event, message: string) => {
  if (fromOverlay(event) && typeof message === 'string' && message.trim()) void ask(message)
})
ipcMain.on('nudge-hidden', (event) => { if (fromOverlay(event)) clearNudge() })
ipcMain.on('mouse', (event, overUi: boolean) => {
  if (fromOverlay(event)) win.setIgnoreMouseEvents(!overUi, { forward: true })
})
ipcMain.on('focus', (event, focus: boolean) => {
  if (!fromOverlay(event) || setupContents()) return
  win.setFocusable(Boolean(focus))
  if (focus) win.focus()
})
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
      { label: 'Open last chat', enabled: !paused && Boolean(storeGet('chat.lastId')), click: () => void openLastChat() },
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
const modeLabel = (): string => 'Live clip analysis and ADK chat'

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
  nudgeRequest?.abort()
  chatRequest?.abort()
  capture?.close()
  stopAssistant()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
