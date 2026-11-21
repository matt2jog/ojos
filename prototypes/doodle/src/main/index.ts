// Ojos live-doodle prototype, main process.
// Transparent click-through overlay + hotkey trigger. The mouse pointer stands in for gaze.
import { app, BrowserWindow, globalShortcut, screen, desktopCapturer, ipcMain, type Display } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { streamGemini } from './gemini'
import { streamMock } from './mock'
import type { Cmd } from '../shared/commands'

// Load .env (GEMINI_API_KEY, GEMINI_MODEL, MOCK) without extra deps.
try {
  for (const line of readFileSync(join(app.getAppPath(), '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
} catch {
  /* no .env */
}

const MODEL = process.env.GEMINI_MODEL || 'gemini-4-hydrogen'
const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1' || !process.env.GEMINI_API_KEY

let win: BrowserWindow
let display: Display
let runId = 0

function createOverlay(): void {
  display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
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
  win.setContentProtection(true) // keep doodles out of screen captures

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

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

async function trigger(): Promise<void> {
  const myRun = ++runId
  const isCurrent = (): boolean => myRun === runId
  const onCmd = (cmd: Cmd): void => {
    if (isCurrent()) win.webContents.send('cmd', cmd)
  }

  const p = screen.getCursorScreenPoint()
  const b = display.bounds
  const gaze = {
    x: Math.round(((p.x - b.x) / b.width) * 1000),
    y: Math.round(((p.y - b.y) / b.height) * 1000)
  }
  win.webContents.send('reset', { gaze, model: MOCK ? 'mock' : MODEL })

  try {
    if (MOCK) {
      await streamMock({ gaze, isCurrent, onCmd })
    } else {
      const pngBase64 = await captureScreen()
      if (!isCurrent()) return
      await streamGemini({ apiKey: process.env.GEMINI_API_KEY!, model: MODEL, pngBase64, gaze, isCurrent, onCmd })
    }
    if (isCurrent()) win.webContents.send('done')
  } catch (e) {
    console.error(e)
    if (isCurrent()) win.webContents.send('error', String((e as Error).message ?? e))
  }
}

function dismiss(): void {
  runId++
  win.webContents.send('dismiss')
}

ipcMain.on('dismiss', dismiss)
ipcMain.on('mouse', (_e, overPanel: boolean) => win.setIgnoreMouseEvents(!overPanel, { forward: true }))

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide()
  createOverlay()

  const keys: Record<string, () => void> = {
    'CommandOrControl+Shift+O': () => {
      console.log('Triggered: drawing...')
      void trigger()
    },
    'CommandOrControl+Shift+X': dismiss,
    'CommandOrControl+Shift+Q': () => app.quit()
  }
  for (const [k, fn] of Object.entries(keys)) {
    if (!globalShortcut.register(k, fn)) console.warn(`!! Could not register ${k}; another app is using it.`)
  }

  const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl'
  const mode = MOCK ? 'MOCK mode' : `model ${MODEL}`
  console.log(`Ojos doodle ready (${mode}).`)
  console.log(`  ${mod}+Shift+O = "I'm stuck" (point the mouse at what confuses you first)`)
  console.log(`  ${mod}+Shift+X = dismiss    ${mod}+Shift+Q = quit`)
  win.webContents.once('did-finish-load', () => win.webContents.send('ready', `${mode}|${mod}`))
})

app.on('will-quit', () => globalShortcut.unregisterAll())
