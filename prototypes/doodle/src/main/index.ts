// Ojos overlay prototype, main process.
// Flow: confusion event (vision or hotkey) -> mascot + suggested questions -> user picks one
// -> answer streams into the mascot's bubble (text only; doodles behind --doodles), and the
// user can follow up by typing or picking another suggestion.
// Manual nudges can use the mouse pointer when tracked gaze is unavailable.
import './log'
import { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, Menu, nativeImage, powerMonitor, shell, systemPreferences, Tray, type Display } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { DEFAULT_GEMINI_MODEL, LOOKBACK_MODEL, LOOKBACK_QUESTION, MAX_HISTORY_TURNS, streamGemini, suggest, wantsLookback, type GazeSource } from './gemini'
import { MOCK_SUGGESTIONS, streamMock } from './mock'
import type { Cmd, Gaze, Suggestions, Turn } from '../shared/commands'
import { openSetup, registerSetupIpc, selectedDisplay, setupDone, storeSet } from './setup'
import { clampSensitivity, liveGaze, reloadVision, sensitivity, startVision } from './vision'
import { LOG_FILE } from './log'
import { ensureRendererUrl } from './serve'
import { ScreenHistory } from './screen-history'

// Load .env without extra deps.
try {
  for (const line of readFileSync(join(app.getAppPath(), '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
} catch {
  /* no .env */
}

const SUGGEST_MODEL = process.env.GEMINI_SUGGEST_MODEL || DEFAULT_GEMINI_MODEL
const EXPLAIN_MODEL = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1' || !process.env.GEMINI_API_KEY
const DOODLES = process.argv.includes('--doodles') || process.env.DOODLES === '1'
const PICK_KEYS = ['Alt+1', 'Alt+2', 'Alt+3']

let win: BrowserWindow
let display: Display
let lookbackEnabled = !MOCK && (process.argv.includes('--lookback') || process.env.OJOS_LOOKBACK === '1')
let historyBusy = false
let historyBlocked = false
let historyEpoch = 0
let historyTimer: ReturnType<typeof setInterval> | undefined
const screenHistory = new ScreenHistory(bytes => nativeImage.createFromBuffer(bytes))
// A nudge can be replaced without interrupting an open answer.
let suggestionRequest: AbortController | undefined
let answerRequest: AbortController | undefined

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
  win.on('blur', () => setFocus(false))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// macOS blocks screen capture until the user allows this app under Screen Recording. Without it
// there is no screenshot to send, so say so plainly and open the right settings pane (once per run).
let askedForScreen = false
function screenBlocked(e: unknown): string | null {
  if (process.platform !== 'darwin') return null
  const denied = systemPreferences.getMediaAccessStatus('screen') !== 'granted'
  if (!denied && !/Failed to get sources/i.test(String((e as Error)?.message ?? e))) return null
  if (!askedForScreen) {
    askedForScreen = true
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  }
  return 'Ojos needs Screen Recording permission. Turn on "Electron" in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen Ojos.'
}

async function displayImage(target: Display, selectedOnly: boolean) {
  const scale = Math.min(1, 1920 / target.size.width)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(target.size.width * scale),
      height: Math.round(target.size.height * scale)
    }
  })
  const matching = sources.find(source => source.display_id === String(target.id))
  const displays = screen.getAllDisplays()
  const soleSource = sources.length === 1 && displays.length === 1 && displays[0].id === target.id
    ? sources[0] : undefined
  const source = matching ?? (selectedOnly ? soleSource : sources[0])
  if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture returned nothing')
  return source.thumbnail
}

async function captureScreen(): Promise<string> {
  return (await displayImage(display, lookbackEnabled)).toPNG().toString('base64')
}

function forgetLookback(): void {
  historyEpoch++
  screenHistory.clear()
}

async function sampleLookback(): Promise<void> {
  if (!lookbackEnabled || paused || hidden || historyBusy || historyBlocked) return
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    forgetLookback()
    return
  }
  historyBusy = true
  const epoch = historyEpoch
  const startedAt = performance.now()
  try {
    const target = screen.getAllDisplays().find(candidate => candidate.id === display.id)
    if (!target) return
    const image = await displayImage(target, true)
    if (epoch === historyEpoch) screenHistory.remember(image, startedAt)
  } catch {
    // Transient capture failures leave ordinary screenshot help available.
  } finally {
    historyBusy = false
  }
}

function earlierFrames(pngBase64: string, observedAt: number) {
  if (!lookbackEnabled || paused || hidden || historyBlocked) return []
  const image = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'))
  return screenHistory.evidence(image, observedAt, performance.now())
}

type Focus = { gaze: Gaze; gazeSource: GazeSource }
const NO_FOCUS: Focus = { gaze: { x: 500, y: 500 }, gazeSource: 'unavailable' }

function currentFocus(): Focus {
  const live = liveGaze()
  if (live) return { gaze: live, gazeSource: 'tracked' }
  const p = screen.getCursorScreenPoint()
  const b = display.bounds
  const gaze = {
    x: Math.round(((p.x - b.x) / b.width) * 1000),
    y: Math.round(((p.y - b.y) / b.height) * 1000)
  }
  if (gaze.x < 0 || gaze.x > 1000 || gaze.y < 0 || gaze.y > 1000) return NO_FOCUS
  return { gaze, gazeSource: 'pointer' }
}

// A picked suggestion uses the screen and focus from the nudge.
type PendingNudge = { focus: Focus; png: Promise<string> | null; capturedAt: number; questions: string[] }
let pending: PendingNudge | null = null

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
// Hidden from the tray or dock: Ojos keeps running but shows nothing and offers no help,
// until the user shows it again or asks for help themselves.
let hidden = false

function setHidden(on: boolean): void {
  hidden = on
  if (on) {
    forgetLookback()
    dismiss()
    win.hide()
  } else {
    win.showInactive()
    void sampleLookback()
  }
  refreshMenus()
}

/** Confusion detected: offer help without opening an answer. */
async function nudge(at?: Gaze | null): Promise<void> {
  if (paused) return
  if (hidden) setHidden(false)
  suggestionRequest?.abort()
  const request = new AbortController()
  suggestionRequest = request
  const focus: Focus = at === undefined ? currentFocus() : at ? { gaze: at, gazeSource: 'tracked' } : NO_FOCUS
  const capturedAt = performance.now()
  const png = MOCK ? null : captureScreen()
  const nudgeState: PendingNudge = { focus, png, capturedAt, questions: [] }
  pending = nudgeState
  win.webContents.send('nudge', focus.gaze)
  setPickKeys(true)

  try {
    let suggestions: Suggestions
    if (png) {
      const pngBase64 = await png
      request.signal.throwIfAborted()
      suggestions = await suggest({
        apiKey: process.env.GEMINI_API_KEY!,
        model: SUGGEST_MODEL,
        pngBase64,
        ...focus,
        signal: request.signal
      })
      if (!request.signal.aborted && earlierFrames(pngBase64, capturedAt).length) {
        const questions = suggestions.questions.filter(question => !wantsLookback(question))
        suggestions.questions = [...questions.slice(0, 2), LOOKBACK_QUESTION]
      }
    } else {
      suggestions = await new Promise<Suggestions>((resolve) => setTimeout(() => resolve(MOCK_SUGGESTIONS), 900))
    }
    if (request.signal.aborted || pending !== nudgeState) return
    pending.questions = suggestions.questions
    win.webContents.send('suggest', suggestions)
  } catch (e) {
    if (request.signal.aborted || pending !== nudgeState) return
    console.error('suggest failed:', (e as Error).name)
    const blocked = screenBlocked(e)
    // UI retains its existing generic hint affordance.
    win.webContents.send('suggest', { stuck_on: '', questions: blocked ? ['Allow Screen Recording first'] : [] })
  } finally {
    if (suggestionRequest === request) suggestionRequest = undefined
  }
}

let convo: { firstPngBase64?: string; turns: Turn[] } | null = null

/** Picked suggestions use the nudge screen. Typed turns use a fresh screen and the typed intent. */
async function explain(input: string | undefined, typed = false): Promise<void> {
  answerRequest?.abort()
  suggestionRequest?.abort()
  const request = new AbortController()
  answerRequest = request
  const isCurrent = (): boolean => !request.signal.aborted
  setPickKeys(false)

  const question = typeof input === 'string' ? input.trim().slice(0, 2000) || undefined : undefined
  const focus = (!typed && pending?.focus) || currentFocus()
  const picked = typed ? null : pending
  const capturedAt = picked?.capturedAt ?? performance.now()
  const png = MOCK ? null : (picked?.png ?? captureScreen())
  const fresh = !convo
  const conversation = (convo ??= { turns: [] })
  pending = null
  const turn: Turn = { question, title: '', says: [] }
  const onCmd = (cmd: Cmd): void => {
    if (!isCurrent()) return
    if ('title' in cmd) turn.title = cmd.title
    else if ('say' in cmd) turn.says.push(cmd.say)
    win.webContents.send('cmd', cmd)
  }
  win.webContents.send('reset', {
    gaze: focus.gaze,
    model: MOCK ? 'mock' : lookbackEnabled && wantsLookback(question) ? LOOKBACK_MODEL : EXPLAIN_MODEL,
    question,
    fresh
  })

  try {
    if (png) {
      const pngBase64 = await png
      if (!isCurrent()) return
      const firstPngBase64 = (conversation.firstPngBase64 ??= pngBase64)
      await streamGemini({
        apiKey: process.env.GEMINI_API_KEY!,
        model: EXPLAIN_MODEL,
        pngBase64,
        ...focus,
        question,
        source: typed ? 'typed' : 'suggestion',
        history: { firstPngBase64, turns: conversation.turns },
        pastFrames: wantsLookback(question) ? earlierFrames(pngBase64, capturedAt) : undefined,
        doodles: DOODLES,
        signal: request.signal,
        isCurrent,
        onCmd
      })
    } else {
      await streamMock({ gaze: focus.gaze, question, followUp: !fresh, doodles: DOODLES, isCurrent, onCmd })
    }
    if (!isCurrent()) return
    if (turn.says.length) conversation.turns = [...conversation.turns, turn].slice(-MAX_HISTORY_TURNS)
    win.webContents.send('done')
  } catch (e) {
    if (!isCurrent()) return
    console.error('explanation failed:', (e as Error).name)
    win.webContents.send('error', screenBlocked(e) ?? 'Gemini couldn’t finish this answer. Try asking again.')
  } finally {
    if (answerRequest === request) answerRequest = undefined
  }
}

function openChat(): void {
  if (paused) return
  if (hidden) setHidden(false)
  win.webContents.send('chat')
}

/** The overlay never takes focus, except while the user types in the chat box. */
function setFocus(on: boolean): void {
  if (!win || win.isDestroyed() || win.isFocusable() === on) return
  win.setFocusable(on)
  if (on) {
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.focus()
  } else win.blur()
  win.setAlwaysOnTop(true, 'screen-saver')
}

function dismiss(): void {
  answerRequest?.abort()
  suggestionRequest?.abort()
  pending = null
  convo = null
  setPickKeys(false)
  setFocus(false)
  win.webContents.send('dismiss')
}

ipcMain.on('dismiss', dismiss)
ipcMain.on('accept', (_e, question?: string) => void explain(question))
ipcMain.on('ask', (_e, text: string) => void explain(text, true))
ipcMain.on('focus', (_e, on: boolean) => setFocus(on))
ipcMain.on('nudge-hidden', () => {
  // The nudge timed out. An open answer can continue.
  suggestionRequest?.abort()
  pending = null
  setPickKeys(false)
})
ipcMain.on('mouse', (_e, overUi: boolean) => win.setIgnoreMouseEvents(!overUi, { forward: true }))

// ---------- menu-bar / tray ----------
let tray: Tray | null = null

function refreshTray(): void {
  if (!tray) return
  tray.setToolTip(hidden ? 'Ojos (hidden)' : 'Ojos')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: hidden ? 'Ojos is hidden and not watching' : 'Ojos is watching for confusion', enabled: false },
      { type: 'separator' },
      { label: 'Help me with this now', accelerator: 'CommandOrControl+Shift+O', click: () => void nudge() },
      { label: 'Chat with Ojos', accelerator: 'CommandOrControl+Shift+J', click: openChat },
      { label: hidden ? 'Show Ojos' : 'Hide Ojos', click: () => setHidden(!hidden) },
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => runSetup('settings') },
      {
        label: 'Screen look-back (last 12 seconds)',
        type: 'checkbox',
        checked: lookbackEnabled,
        enabled: !MOCK,
        click: item => {
          lookbackEnabled = item.checked
          forgetLookback()
          if (lookbackEnabled) void sampleLookback()
          else dismiss()
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

const dockMenu = (): Menu =>
  Menu.buildFromTemplate([
    { label: 'Settings…', click: () => runSetup('settings') },
    { label: 'Recalibrate eyes…', click: () => runSetup('calibrate') },
    { label: 'Help me with this now', click: () => void nudge() },
    { label: hidden ? 'Show Ojos' : 'Hide Ojos', click: () => setHidden(!hidden) }
  ])

function refreshMenus(): void {
  refreshTray()
  if (process.platform === 'darwin') app.dock?.setMenu(dockMenu())
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  refreshTray()
}

/** Show the setup window; the overlay is (re)created on the chosen display when it closes. */
function runSetup(startAt: string): void {
  paused = true
  forgetLookback()
  dismiss()
  const setupWin = openSetup({
    startAt,
    query: process.argv.includes('--autopilot') ? 'autopilot' : undefined,
    onDone: () => {
      paused = false
      if (win && !win.isDestroyed() && String(selectedDisplay().id) !== String(display.id)) {
        win.destroy()
        createOverlay()
        if (hidden) win.hide()
        win.webContents.once('did-finish-load', () => win.webContents.send('ready', `${modeLabel()}|${modKey()}`))
      }
      void sampleLookback()
      refreshTray()
    }
  })
  const snapFile = argValue('snapshot-setup')
  if (snapFile && setupWin) {
    setupWin.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        writeFileSync(snapFile, (await setupWin.webContents.capturePage()).toPNG())
        app.exit(0)
      }, Number(argValue('snapshot-delay') ?? 2500))
    )
  }
}

const modKey = (): string => (process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
const modeLabel = (): string => (MOCK ? 'MOCK mode' : `${SUGGEST_MODEL} -> ${EXPLAIN_MODEL}`)

registerSetupIpc()

ipcMain.on('open-settings', () => runSetup('settings'))
ipcMain.handle('settings:get', () => ({
  mock: MOCK,
  suggestModel: SUGGEST_MODEL,
  explainModel: EXPLAIN_MODEL,
  sensitivity: sensitivity(),
  screenPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
  cameraPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('camera') : 'granted',
  logFile: LOG_FILE,
  platform: process.platform
}))
ipcMain.handle('settings:sensitivity', (_e, high: number) => {
  storeSet('trigger.high', String(clampSensitivity(high)))
  reloadVision()
})

// Dev aids: isolated data folder, and setup screenshots (--setup-step=<step> --autopilot
// --snapshot-setup=<file.png> --snapshot-delay=<ms>).
if (process.env.OJOS_USER_DATA) app.setPath('userData', process.env.OJOS_USER_DATA)
// One Ojos at a time: a second launch just exits.
if (!app.requestSingleInstanceLock()) app.exit(0)
// Launching Ojos again while it's running shows the "Ojos is running" pill instead of doing nothing.
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) win.webContents.send('ready', `${modeLabel()}|${modKey()}`)
})
const argValue = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

app.on('window-all-closed', () => {
  /* stay alive in the menu bar */
})

app.whenReady().then(async () => {
  // Dock icon: clicking it opens Settings; its right-click menu also offers Quit.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png')))
    app.dock.setMenu(dockMenu())
    const startedAt = Date.now()
    // Only a real Dock click should open Settings. macOS also sends 'activate' when one of our
    // own windows takes focus (the chat box does), so require that no window is focused or visible
    // besides the always-present overlay, and ignore the activation at launch.
    app.on('activate', (_e, hasVisibleWindows) => {
      const sinceStart = Date.now() - startedAt
      const focused = BrowserWindow.getFocusedWindow()
      console.log(`[dock] activate after ${sinceStart} ms, focused window: ${focused ? focused.getTitle() : 'none'}, visible: ${hasVisibleWindows}`)
      if (sinceStart < 5000 || focused) return
      runSetup('settings')
    })
  }
  await ensureRendererUrl()
  createOverlay()
  createTray()
  // Live vision (Matt's models): a real confusion interval shows the mascot, aimed at where
  // the user was looking during it. A short cooldown stops back-to-back nudges.
  let lastNudgeAt = 0
  startVision({
    onInterval: (gaze) => {
      if (hidden || Date.now() - lastNudgeAt < 12_000) return
      lastNudgeAt = Date.now()
      void nudge(gaze)
    }
  })
  if (!setupDone() || process.argv.includes('--setup') || argValue('setup-step')) runSetup(argValue('setup-step') ?? 'welcome')

  historyTimer = setInterval(() => void sampleLookback(), 700)
  void sampleLookback()
  screen.on('display-added', forgetLookback)
  screen.on('display-removed', forgetLookback)
  screen.on('display-metrics-changed', forgetLookback)
  const blockHistory = () => {
    historyBlocked = true
    forgetLookback()
    answerRequest?.abort()
  }
  const unblockHistory = () => {
    historyBlocked = false
    void sampleLookback()
  }
  powerMonitor.on('lock-screen', blockHistory)
  powerMonitor.on('unlock-screen', unblockHistory)
  powerMonitor.on('suspend', blockHistory)
  powerMonitor.on('resume', unblockHistory)

  const keys: Record<string, () => void> = {
    'CommandOrControl+Shift+O': () => {
      console.log('Confusion event: showing mascot + questions...')
      void nudge()
    },
    'CommandOrControl+Shift+J': openChat,
    'CommandOrControl+Shift+X': dismiss,
    'CommandOrControl+Shift+Q': () => app.quit()
  }
  for (const [k, fn] of Object.entries(keys)) {
    if (!globalShortcut.register(k, fn)) console.warn(`!! Could not register ${k}; another app is using it.`)
  }

  const mac = process.platform === 'darwin'
  const mod = modKey()
  const mode = modeLabel()
  if (process.platform === 'darwin') console.log(`Screen Recording permission: ${systemPreferences.getMediaAccessStatus('screen')}`)
  console.log(`Ojos ready (${mode}${DOODLES ? ', doodles on' : ''}).`)
  console.log(`  ${mod}+Shift+O = confusion event (point the mouse at what confuses you first)`)
  console.log(`  ${mac ? 'Option' : 'Alt'}+1/2/3 = pick a suggested question`)
  console.log(`  ${mod}+Shift+J = chat with Ojos`)
  console.log(`  ${mod}+Shift+X = dismiss    ${mod}+Shift+Q = quit`)
  win.webContents.once('did-finish-load', () => win.webContents.send('ready', `${mode}|${mod}`))

  // Dev aid: --snapshot=<file.png> triggers a nudge, saves a screenshot of the overlay and quits.
  const snap = process.argv.find((a) => a.startsWith('--snapshot='))?.split('=')[1]
  if (snap) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void nudge(), 300)
      // --snapshot-do=pick | followup | chat captures a later state than the thought bubble.
      const act = argValue('snapshot-do')
      if (act === 'chat') setTimeout(openChat, 1600)
      if (act === 'pick' || act === 'followup') setTimeout(() => void explain(MOCK_SUGGESTIONS.questions[0]), 1600)
      if (act === 'followup') setTimeout(() => void explain('How do I check for None?', true), 4200)
      setTimeout(async () => {
        const img = await win.webContents.capturePage()
        writeFileSync(snap, img.toPNG())
        app.quit()
      }, Number(argValue('snapshot-delay') ?? 3200))
    })
  }
})

app.on('will-quit', () => {
  clearInterval(historyTimer)
  forgetLookback()
  answerRequest?.abort()
  suggestionRequest?.abort()
  globalShortcut.unregisterAll()
})
