// Ojos overlay prototype, main process.
// Flow: confusion event (hotkey for now) -> mascot + suggested questions -> user picks one
// -> answer streams into the mascot's bubble (text only; doodles behind --doodles), and the
// user can follow up by typing or picking another suggestion.
// The mouse pointer stands in for gaze until the eye tracker is wired in.
import './log'
import { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, Menu, nativeImage, shell, systemPreferences, Tray, type Display } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { streamGemini, suggest } from './gemini'
import { MOCK_SUGGESTIONS, streamMock } from './mock'
import type { Cmd, Gaze, Suggestions, Turn } from '../shared/commands'
import { openSetup, registerSetupIpc, selectedDisplay, setupDone } from './setup'
import { liveGaze, startVision } from './vision'
import { ensureRendererUrl } from './serve'

// Load .env without extra deps.
try {
  for (const line of readFileSync(join(app.getAppPath(), '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
} catch {
  /* no .env */
}

const SUGGEST_MODEL = process.env.GEMINI_SUGGEST_MODEL || 'gemini-4-hydrogen' // fast: guesses the question
const EXPLAIN_MODEL = process.env.GEMINI_MODEL || 'gemini-4-neon' // smart: answers it
const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1' || !process.env.GEMINI_API_KEY
const DOODLES = process.argv.includes('--doodles') || process.env.DOODLES === '1'
const PICK_KEYS = ['Alt+1', 'Alt+2', 'Alt+3']

let win: BrowserWindow
let display: Display
// Separate counters, so a new confusion event restarts the question guess without
// cutting off an answer that is still streaming.
let suggestRun = 0
let runId = 0

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

// Stand-in for the recorder teammate's capture: one screenshot of the overlay's display.
async function captureScreen(): Promise<string> {
  const scale = Math.min(1, 1920 / display.size.width)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale)
    }
  })
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
  if (!src || src.thumbnail.isEmpty()) {
    throw new Error(`Screen capture returned nothing (Screen Recording permission: ${access})`)
  }
  const png = src.thumbnail.toPNG()
  console.log(`[capture] ${src.thumbnail.getSize().width}x${src.thumbnail.getSize().height}, ${png.length} bytes, screen permission ${access}`)
  return png.toString('base64')
}

function currentGaze(): Gaze {
  // Tracked eyes when live vision is running and calibrated; mouse pointer otherwise.
  const live = liveGaze()
  if (live) return live
  const p = screen.getCursorScreenPoint()
  const b = display.bounds
  return {
    x: Math.round(((p.x - b.x) / b.width) * 1000),
    y: Math.round(((p.y - b.y) / b.height) * 1000)
  }
}

// State captured at the moment the user got stuck. Kept until they pick a question,
// since the pointer moves to the mascot to click it and the screen may change.
let pending: { gaze: Gaze; png: Promise<string> | null; questions: string[] } | null = null

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
async function nudge(at?: Gaze | null): Promise<void> {
  if (paused) return
  const myRun = ++suggestRun
  const gaze = at ?? currentGaze()
  const png = MOCK ? null : captureScreen()
  pending = { gaze, png, questions: [] }
  win.webContents.send('nudge', gaze)
  setPickKeys(true)

  try {
    const sug: Suggestions = MOCK
      ? await new Promise<Suggestions>((r) => setTimeout(() => r(MOCK_SUGGESTIONS), 900))
      : await suggest({ apiKey: process.env.GEMINI_API_KEY!, model: SUGGEST_MODEL, pngBase64: await png!, gaze })
    if (myRun !== suggestRun || !pending) return
    pending.questions = sug.questions
    win.webContents.send('suggest', sug)
  } catch (e) {
    console.error('suggest failed:', e)
    const blocked = screenBlocked(e)
    // UI falls back to a generic bubble + "Explain what I'm looking at"
    if (myRun === suggestRun) {
      win.webContents.send('suggest', { stuck_on: '', questions: blocked ? ['Allow Screen Recording first'] : [] })
    }
  }
}

// The open conversation. Follow-ups are answered with its earlier turns and first screenshot.
let convo: { gaze: Gaze; firstPng: Promise<string> | null; turns: Turn[] } | null = null

/**
 * Stream an answer. With no conversation open this starts one; otherwise it is a follow-up.
 * A picked suggestion uses the screenshot from the moment of confusion. A typed follow-up
 * takes a new screenshot, because the screen may have changed since.
 */
async function explain(question: string | undefined, typed = false): Promise<void> {
  const myRun = ++runId
  suggestRun++
  const isCurrent = (): boolean => myRun === runId
  setPickKeys(false)

  const fresh = !convo
  const png = MOCK ? null : ((typed && !fresh ? null : pending?.png) ?? captureScreen())
  if (!convo) convo = { gaze: pending?.gaze ?? currentGaze(), firstPng: png, turns: [] }
  pending = null
  const { gaze, firstPng } = convo
  const history = [...convo.turns]
  const turn: Turn = { question, title: '', says: [] }
  convo.turns.push(turn)
  const onCmd = (cmd: Cmd): void => {
    if (!isCurrent()) return
    if ('title' in cmd) turn.title = cmd.title
    else if ('say' in cmd) turn.says.push(cmd.say)
    win.webContents.send('cmd', cmd)
  }
  win.webContents.send('reset', { gaze, model: MOCK ? 'mock' : EXPLAIN_MODEL, question, fresh })

  try {
    if (MOCK) {
      await streamMock({ gaze, question, followUp: !fresh, doodles: DOODLES, isCurrent, onCmd })
    } else {
      const pngBase64 = await png!
      const firstPngBase64 = await firstPng!
      if (!isCurrent()) return
      await streamGemini({
        apiKey: process.env.GEMINI_API_KEY!,
        model: EXPLAIN_MODEL,
        pngBase64,
        gaze,
        question,
        history: { firstPngBase64, turns: history },
        doodles: DOODLES,
        isCurrent,
        onCmd
      })
    }
    if (isCurrent()) win.webContents.send('done')
  } catch (e) {
    console.error(e)
    if (isCurrent()) win.webContents.send('error', screenBlocked(e) ?? String((e as Error).message ?? e))
  }
}

/** Open the chat box without a confusion event (tray or hotkey). */
function openChat(): void {
  if (paused) return
  if (!convo && !pending) pending = { gaze: currentGaze(), png: MOCK ? null : captureScreen(), questions: [] }
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
  runId++
  suggestRun++
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
  // Ignored (timed out): forget it. Doesn't touch an answer that's already open.
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
      { label: 'Chat with Ojos', accelerator: 'CommandOrControl+Shift+J', click: openChat },
      {
        label: paused ? 'Resume' : 'Pause',
        click: () => {
          paused = !paused
          if (paused) dismiss()
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
  paused = true
  dismiss()
  const setupWin = openSetup({
    startAt,
    query: process.argv.includes('--autopilot') ? 'autopilot' : undefined,
    onDone: () => {
      paused = false
      if (win && !win.isDestroyed() && String(selectedDisplay().id) !== String(display.id)) {
        win.destroy()
        createOverlay()
        win.webContents.once('did-finish-load', () => win.webContents.send('ready', `${modeLabel()}|${modKey()}`))
      }
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
  if (process.platform === 'darwin') app.dock?.hide()
  await ensureRendererUrl()
  createOverlay()
  createTray()
  // Live vision (Matt's models): a real confusion interval shows the mascot, aimed at where
  // the user was looking during it. A short cooldown stops back-to-back nudges.
  let lastNudgeAt = 0
  startVision({
    onInterval: (gaze) => {
      if (Date.now() - lastNudgeAt < 12_000) return
      lastNudgeAt = Date.now()
      void nudge(gaze)
    }
  })
  if (!setupDone() || process.argv.includes('--setup') || argValue('setup-step')) runSetup(argValue('setup-step') ?? 'welcome')

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

app.on('will-quit', () => globalShortcut.unregisterAll())
