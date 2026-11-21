import { app, BrowserWindow, globalShortcut, screen, ipcMain, Menu, nativeImage, powerMonitor, Tray, type Display, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { analyzeBundle } from '@assistant'
import type { ChatHistory, Gaze, A2uiAction } from '../shared/commands'
import type { Interval, ViewportRect, VisionExport } from '../shared/capture'
import { calibrationDisplay, closeSettings, configuredDisplay, configuringSetup, openSetup, permission, registerSetupIpc, selectedDisplay, settingsContents, setupContents, setupDone, storeGet, storeSet, triggerHigh } from './setup'
import { clampTriggerHigh, type AppSettings } from '../shared/setup'
import { RecordingService } from './capture/service'
import { assistant, chatHistory, savedChats, stopAssistant, streamChatTurn } from './assistant'
import { configureRuntime } from './runtime'

if (process.env.OJOS_USER_DATA) app.setPath('userData', process.env.OJOS_USER_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
configureRuntime()
const DOODLES = process.argv.includes('--doodles') || process.env.DOODLES === '1'
const PICK_KEYS = ['Alt+1', 'Alt+2', 'Alt+3']
const configuredIoU = Number(process.env.OJOS_CHAT_GAZE_IOU ?? 0.08)
const paneIoU = configuredIoU > 0 && configuredIoU < 1 ? configuredIoU : 0.08

let win: BrowserWindow
let display: Display
let runId = 0
let capture: RecordingService | undefined
let nudgeRequest: AbortController | undefined
let chatRequest: AbortController | undefined
let chatId: string | undefined
let chatPane: ViewportRect | null = null
let chatAnswered = false
let chatHelpOffered = false
let chatListOpen = false
const chatIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
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
  evidence: VisionExport['gaze']; stillTimeUs: number
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
let hidden = false
let overlayFocusAt = 0

function setHidden(value: boolean): void {
  if (hidden === value) return
  hidden = value
  if (hidden) {
    dismiss()
    win.hide()
  } else if (!settingsContents()) {
    win.showInactive()
  }
  refreshTray()
}

/** Confusion detected: show the mascot and start guessing the question. Never explains on its own. */
async function nudge(interval?: Interval): Promise<void> {
  if (paused || settingsContents() || chatRequest || chatListOpen || (interval && (hidden || pending)) || !capture?.isRecording()) return
  if (hidden) setHidden(false)
  if (interval && chatId && chatAnswered && chatPane) {
    const id = chatId
    const pane = chatPane
    const overlap = await capture.gazedAtPane(interval, pane, paneIoU)
    if (paused || hidden || settingsContents() || chatRequest || chatListOpen || id !== chatId || pane !== chatPane) return
    if (overlap) {
      if (!chatHelpOffered) {
        chatHelpOffered = true
        win.webContents.send('chat-help')
      }
      return // The existing explanation is the context for this offer.
    }
  }
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
      pending = { gaze: clip.gaze, still: clip.still, questions: [], evidence: clip.evidence, stillTimeUs: clip.stillTimeUs }
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
  if (hidden || settingsContents() || chatRequest || chatListOpen || (picked && !pending) ||
      (question !== undefined && typeof question !== 'string')) return
  const message = question?.trim() || 'Explain what I’m looking at.'
  if (message.length > 8000) return
  const evidence = (!chatId || picked) && pending ? pending : undefined
  const fresh = !chatId || Boolean(evidence)
  const id = fresh ? randomUUID() : chatId!
  const controller = new AbortController()
  chatId = id
  chatRequest = controller
  if (fresh) chatAnswered = false
  chatPane = null
  const current = (): boolean => chatRequest === controller && !win.isDestroyed()
  if (nudgeRequest) clearNudge()
  win.webContents.send('reset', { gaze: evidence?.gaze, question: message, fresh })

  try {
    const screenContext = evidence ? JSON.stringify({
      clip_summary: evidence.summary, still_time_us: evidence.stillTimeUs, gaze: evidence.evidence
    }) : undefined
    const answer = await streamChatTurn({
      chatId: id, turnId: randomUUID(), message, screenContext, jpeg: evidence?.still,
      doodles: DOODLES && Boolean(evidence?.still),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)])
    }, (event) => {
      if (!current()) return
      if (event.kind === 'doodle') win.webContents.send('cmd', event.command)
      else if (event.kind === 'ui-decision') win.webContents.send('a2ui-decision', event.decision)
      else if (event.kind === 'a2ui') win.webContents.send('a2ui', event.payload)
      else if (event.kind === 'a2ui-error') win.webContents.send('a2ui-error', event.message)
      else win.webContents.send(event.kind === 'status' ? 'chat-status' : 'chat-delta', event.text)
    })
    if (current()) {
      chatAnswered = true
      chatHelpOffered = false
      storeSet('chat.lastId', id)
      refreshTray()
      win.webContents.send('chat-meta', answer.chat)
      win.webContents.send('chat-answer', answer.text)
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

async function openSavedChat(id: string): Promise<void> {
  if (chatRequest || !chatIdPattern.test(id)) return
  setHidden(false)
  const controller = new AbortController()
  chatRequest = controller
  clearNudge()
  try {
    const history = await chatHistory(id, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]))
    if (chatRequest !== controller || win.isDestroyed()) return
    if (!history.chat) throw new Error('That saved chat could not be found.')
    chatId = id
    chatAnswered = history.turns.length > 0
    chatHelpOffered = false
    chatPane = null
    chatListOpen = false
    storeSet('chat.lastId', id)
    refreshTray()
    win.webContents.send('chat-history', history)
    win.webContents.send('chat')
  } catch (error) {
    if (chatRequest === controller && !win.isDestroyed()) {
      showSavedChats()
      win.webContents.send('chat-list-error', (error as Error).message)
    }
  } finally {
    if (chatRequest === controller) chatRequest = undefined
  }
}

function showSavedChats(): void {
  if (!win || win.isDestroyed()) return
  setHidden(false)
  clearNudge()
  chatListOpen = true
  chatPane = null
  win.webContents.send('chat-list')
}

function newChat(): void {
  if (chatRequest) return
  clearNudge()
  chatId = undefined
  chatAnswered = false
  chatHelpOffered = false
  chatPane = null
  chatListOpen = false
  const empty: ChatHistory = { chat: null, turns: [], older_before_seq: null }
  win.webContents.send('chat-history', empty)
  win.webContents.send('chat')
}

function dismiss(): void {
  clearNudge()
  chatRequest?.abort()
  chatRequest = undefined
  chatId = undefined
  chatAnswered = false
  chatHelpOffered = false
  chatPane = null
  chatListOpen = false
  if (win && !win.isDestroyed()) {
    win.setFocusable(false)
    win.setIgnoreMouseEvents(true, { forward: true })
    win.webContents.send('dismiss')
  }
}

const fromOverlay = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
  Boolean(win && !win.isDestroyed() && event.senderFrame === win.webContents.mainFrame)
ipcMain.on('dismiss', (event) => { if (fromOverlay(event)) dismiss() })
ipcMain.on('accept', (event, question?: string) => { if (fromOverlay(event) && pending) void ask(question, true) })
// A2UI client action: a control in a generated interface was used. It goes to the agent as the
// next turn in the same chat, so the agent can respond and render an updated interface.
ipcMain.on('a2ui-action', (_event, action: A2uiAction) => {
  if (!action || typeof action.name !== 'string') return
  const label = typeof action.context?.label === 'string' ? action.context.label : action.name.replace(/_/g, ' ')
  const detail = JSON.stringify({ action: action.name, component: action.sourceComponentId, context: action.context ?? {} })
  void ask(`[UI action] ${label} ${detail}`.slice(0, 4000))
})
ipcMain.on('ask', (event, message: string) => {
  if (fromOverlay(event) && typeof message === 'string' && message.trim()) void ask(message)
})
ipcMain.on('nudge-hidden', (event) => { if (fromOverlay(event)) clearNudge() })
ipcMain.on('chat-list-mode', (event, open: boolean) => {
  if (!fromOverlay(event)) return
  chatListOpen = open === true
  if (chatListOpen) {
    clearNudge()
    chatPane = null
  }
})
ipcMain.handle('chat-list', (event) => {
  if (!fromOverlay(event)) throw new Error('Unavailable chat list.')
  return savedChats(AbortSignal.timeout(25_000))
})
ipcMain.on('open-chat', (event, id: string) => {
  if (fromOverlay(event) && typeof id === 'string') void openSavedChat(id)
})
ipcMain.on('new-chat', (event) => { if (fromOverlay(event)) newChat() })
ipcMain.handle('chat-older', (event, before: number) => {
  if (!fromOverlay(event) || !chatId || !Number.isSafeInteger(before) || before < 1) {
    throw new Error('No earlier messages are available.')
  }
  return chatHistory(chatId, AbortSignal.timeout(25_000), before)
})
ipcMain.on('mouse', (event, overUi: boolean) => {
  if (fromOverlay(event)) win.setIgnoreMouseEvents(!overUi, { forward: true })
})
ipcMain.on('focus', (event, focus: boolean) => {
  if (!fromOverlay(event) || setupContents()) return
  win.setFocusable(Boolean(focus))
  if (focus) {
    overlayFocusAt = Date.now()
    win.focus()
  }
})
ipcMain.on('chat-pane', (event, rect: ViewportRect | null) => {
  if (!fromOverlay(event)) return
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
    rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 ||
    rect.x + rect.w > 1.001 || rect.y + rect.h > 1.001) {
    chatPane = null
    return
  }
  if (chatPane?.x === rect.x && chatPane?.y === rect.y && chatPane?.w === rect.w && chatPane?.h === rect.h) return
  chatPane = rect
})

// ---------- menu-bar / tray ----------
let tray: Tray | null = null

const visibilityItem = (): MenuItemConstructorOptions => ({
  label: hidden ? 'Show Ojos' : 'Hide Ojos', click: () => setHidden(!hidden)
})

function refreshTray(): void {
  if (!tray) return
  tray.setToolTip(hidden ? 'Ojos (hidden)' : paused ? 'Ojos (recording stopped)' : 'Ojos')
  const recording = capture?.isRecording()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hidden ? (recording ? 'Hidden · Recording continues' : 'Hidden · Recording stopped') :
        paused ? 'Recording stopped' : 'Ojos is watching for confusion', enabled: false },
      { type: 'separator' },
      { label: 'Help me with this now', accelerator: 'CommandOrControl+Shift+O', click: () => void nudge() },
      { label: 'Saved chats', click: showSavedChats },
      { label: 'Open last chat', enabled: Boolean(storeGet('chat.lastId')), click: () => {
        const id = storeGet('chat.lastId')
        if (id) void openSavedChat(id)
      } },
      visibilityItem(),
      ...(paused && setupDone() && !configuringSetup() ? [{
        label: 'Resume recording',
        click: () => {
          paused = false
          void startRecording().finally(refreshTray)
        }
      }] : []),
      { label: 'Settings…', click: openSettings },
      { label: 'Recalibrate eyes…', click: () => runSetup('calibrate') },
      { label: 'Run setup again…', click: () => runSetup('welcome') },
      { type: 'separator' },
      { label: 'Quit Ojos', accelerator: 'CommandOrControl+Shift+Q', click: () => app.quit() }
    ])
  )
  app.dock?.setMenu(Menu.buildFromTemplate([
    { label: 'Settings…', click: openSettings },
    { label: 'Saved chats', click: showSavedChats },
    { label: 'Help me with this now', click: () => void nudge() },
    visibilityItem()
  ]))
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  refreshTray()
}

let setupAfterSettings: 'calibrate' | 'welcome' | null = null

function openSettings(): void {
  if (setupContents()) {
    openSetup({ startAt: 'settings', onDone: () => {} })
    return
  }
  const overlay = win
  const settings = openSetup({
    startAt: 'settings',
    onDone: () => {
      if (!hidden && !win.isDestroyed()) win.showInactive()
      const next = setupAfterSettings
      setupAfterSettings = null
      if (next) runSetup(next)
    }
  })
  settings.once('show', () => {
    if (overlay.isDestroyed()) return
    clearNudge()
    chatPane = null
    overlay.webContents.send('suggestions-dismissed')
    overlay.setFocusable(false)
    overlay.setIgnoreMouseEvents(true, { forward: true })
    overlay.hide()
  })
  // The hidden settings renderer can miss its first paint. Show the native window directly.
  settings.show()
  settings.focus()
}

/** Show the setup window; the overlay is (re)created on the chosen display when it closes. */
function runSetup(startAt: string): void {
  if (settingsContents() && (startAt === 'calibrate' || startAt === 'welcome')) {
    setupAfterSettings = startAt
    closeSettings()
    return
  }
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
        if (hidden) win.hide()
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

ipcMain.on('open-settings', (event) => { if (fromOverlay(event)) openSettings() })
function requireSettings(event: Electron.IpcMainInvokeEvent): void {
  const contents = settingsContents()
  if (!contents || event.senderFrame !== contents.mainFrame) {
    throw new Error('Open Ojos Settings first.')
  }
}
ipcMain.handle('settings:get', (event): AppSettings => {
  requireSettings(event)
  const status = capture?.status() ?? { recording: false, camera: false, calibration: null, confusion: 'stopped' }
  const key = Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim())
  const remote = Boolean(process.env.OJOS_ASSISTANT_URL && process.env.OJOS_LOCAL_TOKEN)
  return {
    ...status, sensitivity: triggerHigh(), screenPermission: permission('screen'),
    clipAssistant: process.env.OJOS_ASSISTANT_URL ? (remote ? 'remote' : 'unconfigured') : key ? 'local' : 'unconfigured',
    chatConfigured: key
  }
})
ipcMain.handle('settings:sensitivity', (event, value: number) => {
  requireSettings(event)
  if (!Number.isFinite(value)) throw new Error('Choose a valid sensitivity.')
  const high = clampTriggerHigh(value)
  if (high !== triggerHigh()) storeSet('trigger.high', String(high))
})
ipcMain.handle('settings:close', (event) => {
  requireSettings(event)
  closeSettings()
})
ipcMain.handle('settings:setup', (event, view: string) => {
  requireSettings(event)
  if (view !== 'calibrate' && view !== 'welcome') throw new Error('Unknown setup action.')
  runSetup(view)
})

async function startRecording(): Promise<void> {
  const target = configuredDisplay()
  if (!setupDone() || configuringSetup() || !target) {
    paused = true
    refreshTray()
    return
  }
  try {
    if (!capture) throw new Error('This platform does not have a recording adapter.')
    if (!capture.isRecording()) await capture.start(target, 'record')
    refreshTray()
  } catch (error) {
    if (configuringSetup()) return
    paused = true
    refreshTray()
    console.warn('Recording did not start:', (error as Error).message)
  }
}

ipcMain.handle('setup:prepare-calibration', async (event) => {
  const target = calibrationDisplay()
  if (!configuringSetup() || event.sender !== setupContents() || !target || !capture) {
    throw new Error('Live calibration is unavailable.')
  }
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

function openLauncherAction(args: string[]): void {
  if (!win || win.isDestroyed()) return
  if (args.includes('--setup')) runSetup('welcome')
  else if (args.includes('--saved-chats')) showSavedChats()
  else openSettings()
}

app.on('second-instance', (_event, args) => openLauncherAction(args))
app.on('activate', () => {
  if (process.platform !== 'darwin') return
  setImmediate(() => {
    const focused = BrowserWindow.getFocusedWindow()
    if (!win || win.isDestroyed() || Date.now() - overlayFocusAt < 500 || (focused && focused !== win)) return
    openSettings()
  })
})

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png')))
  } else if (process.platform === 'win32' && app.isPackaged) {
    app.setAppUserModelId('com.ojos.desktop')
    const options = { program: process.execPath, iconPath: process.execPath, iconIndex: 0 }
    if (!app.setUserTasks([
      { ...options, arguments: '--settings', title: 'Settings', description: 'Open Ojos Settings.' },
      { ...options, arguments: '--saved-chats', title: 'Saved chats', description: 'Resume an Ojos conversation.' }
    ])) console.warn('Windows did not register the Ojos taskbar actions.')
  }
  createOverlay()
  createTray()
  try {
    capture = new RecordingService(
      (interval) => void nudge(interval),
      (observation) => setupContents()?.send('setup:gaze', observation),
      (reason) => {
        if (!configuringSetup()) {
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
    if (resumeAfterSleep && !configuringSetup()) {
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
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('ready', `${mode}|${mod}`)
    if (process.argv.includes('--settings') || process.argv.includes('--saved-chats')) openLauncherAction(process.argv)
  })

})

app.on('before-quit', () => {
  nudgeRequest?.abort()
  chatRequest?.abort()
  capture?.close()
  stopAssistant()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
