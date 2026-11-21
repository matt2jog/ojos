// Ojos overlay prototype, main process.
// Flow: confusion event (hotkey for now) -> mascot + suggested questions -> user picks one
// -> answer streams into the side panel (text only; doodles behind --doodles).
// The mouse pointer stands in for gaze until the eye tracker is wired in.
import { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, Menu, nativeImage, Tray, type Display } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { streamGemini, suggest } from './gemini'
import { MOCK_SUGGESTIONS, streamMock } from './mock'
import type { Cmd, Gaze, Suggestions } from '../shared/commands'
import { openSetup, registerSetupIpc, selectedDisplay, setupDone } from './setup'

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

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
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
  return src.thumbnail.toPNG().toString('base64')
}

function currentGaze(): Gaze {
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
async function nudge(): Promise<void> {
  if (paused) return
  const myRun = ++runId
  const gaze = currentGaze()
  const png = MOCK ? null : captureScreen()
  pending = { gaze, png, questions: [] }
  win.webContents.send('nudge', gaze)
  setPickKeys(true)

  try {
    const sug: Suggestions = MOCK
      ? await new Promise<Suggestions>((r) => setTimeout(() => r(MOCK_SUGGESTIONS), 900))
      : await suggest({ apiKey: process.env.GEMINI_API_KEY!, model: SUGGEST_MODEL, pngBase64: await png!, gaze })
    if (myRun !== runId || !pending) return
    pending.questions = sug.questions
    win.webContents.send('suggest', sug)
  } catch (e) {
    console.error('suggest failed:', e)
    // UI falls back to a generic bubble + "Explain what I'm looking at"
    if (myRun === runId) win.webContents.send('suggest', { stuck_on: '', questions: [] })
  }
}

/** User picked a question (or clicked the mascot): stream the answer. Replaces any open answer. */
async function explain(question?: string): Promise<void> {
  const myRun = ++runId
  const isCurrent = (): boolean => myRun === runId
  const onCmd = (cmd: Cmd): void => {
    if (isCurrent()) win.webContents.send('cmd', cmd)
  }
  setPickKeys(false)

  const gaze = pending?.gaze ?? currentGaze()
  const png = pending?.png ?? (MOCK ? null : captureScreen())
  pending = null
  win.webContents.send('reset', { gaze, model: MOCK ? 'mock' : EXPLAIN_MODEL })

  try {
    if (MOCK) {
      await streamMock({ gaze, question, doodles: DOODLES, isCurrent, onCmd })
    } else {
      const pngBase64 = await png!
      if (!isCurrent()) return
      await streamGemini({
        apiKey: process.env.GEMINI_API_KEY!,
        model: EXPLAIN_MODEL,
        pngBase64,
        gaze,
        question,
        doodles: DOODLES,
        isCurrent,
        onCmd
      })
    }
    if (isCurrent()) win.webContents.send('done')
  } catch (e) {
    console.error(e)
    if (isCurrent()) win.webContents.send('error', String((e as Error).message ?? e))
  }
}

function dismiss(): void {
  runId++
  pending = null
  setPickKeys(false)
  win.webContents.send('dismiss')
}

ipcMain.on('dismiss', dismiss)
ipcMain.on('accept', (_e, question?: string) => void explain(question))
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
const argValue = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

app.on('window-all-closed', () => {
  /* stay alive in the menu bar */
})

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide()
  createOverlay()
  createTray()
  if (!setupDone() || process.argv.includes('--setup') || argValue('setup-step')) runSetup(argValue('setup-step') ?? 'welcome')

  const keys: Record<string, () => void> = {
    'CommandOrControl+Shift+O': () => {
      console.log('Confusion event: showing mascot + questions...')
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
  console.log(`  ${mod}+Shift+O = confusion event (point the mouse at what confuses you first)`)
  console.log(`  ${mac ? 'Option' : 'Alt'}+1/2/3 = pick a suggested question`)
  console.log(`  ${mod}+Shift+X = dismiss    ${mod}+Shift+Q = quit`)
  win.webContents.once('did-finish-load', () => win.webContents.send('ready', `${mode}|${mod}`))

  // Dev aid: --snapshot=<file.png> triggers a nudge, saves a screenshot of the overlay and quits.
  const snap = process.argv.find((a) => a.startsWith('--snapshot='))?.split('=')[1]
  if (snap) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => void nudge(), 300)
      setTimeout(async () => {
        const img = await win.webContents.capturePage()
        writeFileSync(snap, img.toPNG())
        app.quit()
      }, 3200)
    })
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())
