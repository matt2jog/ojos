// First-run setup: permissions, display choice and eye calibration, in one branded window.
// Also owns the small local key-value store used for settings and calibration profiles.
import { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell, systemPreferences, type Display } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { clampTriggerHigh, TRIGGER_RANGE, type DisplayInfo, type PermissionKind, type PermissionState } from '../shared/setup'
import { encodedSize } from '../shared/capture'

// ---------- local store (settings + calibration profiles; never leaves the laptop) ----------
const storePath = (): string => join(app.getPath('userData'), 'ojos-store.json')
let cache: Record<string, string> | null = null

function store(): Record<string, string> {
  if (!cache) {
    try {
      cache = existsSync(storePath()) ? JSON.parse(readFileSync(storePath(), 'utf8')) : {}
    } catch {
      cache = {}
    }
  }
  return cache!
}

export function storeGet(key: string): string | null {
  return store()[key] ?? null
}

export function storeSet(key: string, value: string | null): void {
  const s = store()
  if (value === null) delete s[key]
  else s[key] = value
  writeFileSync(storePath(), JSON.stringify(s, null, 2))
}

export const setupDone = (): boolean => storeGet('setup.done') === '1'
export function triggerHigh(): number {
  const value = Number(storeGet('trigger.high') ?? TRIGGER_RANGE.default)
  return Number.isFinite(value) ? clampTriggerHigh(value) : TRIGGER_RANGE.default
}

// ---------- displays ----------
export function configuredDisplay(): Display | undefined {
  const id = storeGet('display.id')
  return screen.getAllDisplays().find((d) => String(d.id) === id)
}

let setupDisplayId: string | null
export function calibrationDisplay(): Display | undefined {
  return screen.getAllDisplays().find((d) => String(d.id) === setupDisplayId)
}

export function selectedDisplay(): Display {
  return configuredDisplay() ?? screen.getPrimaryDisplay()
}

export function displayInfo(d: Display): DisplayInfo {
  const vp = encodedSize(Math.round(d.size.width * d.scaleFactor), Math.round(d.size.height * d.scaleFactor))
  return {
    id: String(d.id),
    label: d.label || (d.internal ? 'Built-in display' : 'Display'),
    width: d.size.width,
    height: d.size.height,
    scaleFactor: d.scaleFactor,
    rotationDeg: ([0, 90, 180, 270].includes(d.rotation) ? d.rotation : 0) as 0 | 90 | 180 | 270,
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    primary: d.id === screen.getPrimaryDisplay().id
  }
}

// ---------- permissions ----------
const mac = process.platform === 'darwin'

export function permission(kind: PermissionKind): PermissionState {
  if (kind === 'audio') return mac ? permission('screen') : 'granted' // playback audio rides on screen capture
  if (kind === 'screen' && !mac) return 'granted' // Windows has no screen-capture permission
  try {
    const s = systemPreferences.getMediaAccessStatus(kind === 'screen' ? 'screen' : 'camera')
    return (['granted', 'denied', 'restricted', 'not-determined'].includes(s) ? s : 'unknown') as PermissionState
  } catch {
    return 'unknown'
  }
}

const SETTINGS_URL: Record<'camera' | 'screen', string> = mac
  ? {
      camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
      screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    }
  : { camera: 'ms-settings:privacy-webcam', screen: 'ms-settings:privacy' }

// ---------- window ----------
let setupWin: BrowserWindow | null = null
let settingsView = false

export function openSetup(opts: { onDone(completed: boolean): void; startAt?: string }): BrowserWindow {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show()
    setupWin.focus()
    return setupWin
  }
  const isSettings = opts.startAt === 'settings'
  settingsView = isSettings
  const window = setupWin = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: isSettings ? 'Ojos Settings' : 'Ojos setup',
    backgroundColor: '#0e0f12',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js') }
  })
  completed = false
  setupDisplayId = storeGet('display.id')
  if (isSettings) {
    window.on('page-title-updated', (event) => event.preventDefault())
  } else {
    window.once('ready-to-show', () => {
      window.show()
      if (mac) app.focus({ steal: true })
    })
  }
  window.on('closed', () => {
    setupWin = null
    settingsView = false
    opts.onDone(completed)
  })
  const step = opts.startAt ?? 'welcome'
  const loading = process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/setup.html#${step}`)
    : window.loadFile(join(__dirname, '../renderer/setup.html'), { hash: step })
  void loading.catch((error) => {
    if (window.isDestroyed()) return
    console.warn('Could not load Ojos setup:', error)
    window.close()
  })
  return window
}

let completed = false
export const setupContents = () => setupWin?.webContents
export const settingsContents = () => settingsView ? setupContents() : undefined
export const configuringSetup = () => Boolean(setupWin) && !settingsView
export function closeSettings(): void {
  if (settingsView) setupWin?.close()
}

let restoreBounds: Electron.Rectangle | null = null

function setFullscreenOn(displayId: string | null): void {
  const w = setupWin
  if (!w) return
  if (displayId) {
    const d = screen.getAllDisplays().find((x) => String(x.id) === displayId)
    if (!d) throw new Error('The selected calibration display was disconnected.')
    restoreBounds = w.getBounds()
    w.setBounds(d.bounds)
    if (mac) w.setSimpleFullScreen(true)
    else w.setFullScreen(true)
    w.setAlwaysOnTop(true, 'pop-up-menu')
  } else {
    if (mac) w.setSimpleFullScreen(false)
    else w.setFullScreen(false)
    w.setAlwaysOnTop(false)
    if (restoreBounds) w.setBounds(restoreBounds)
    w.center()
  }
}

// ---------- IPC ----------
export function registerSetupIpc(): void {
  ipcMain.on('store:get', (e, key: string) => (e.returnValue = storeGet(key)))
  ipcMain.on('store:set', (e, key: string, value: string | null) => {
    storeSet(key, value)
    e.returnValue = true
  })

  ipcMain.handle('setup:platform', () => process.platform)
  ipcMain.handle('setup:permissions', () => ({
    camera: permission('camera'),
    screen: permission('screen'),
    audio: permission('audio')
  }))
  ipcMain.handle('setup:request', async (_e, kind: PermissionKind) => {
    if (kind === 'camera') {
      if (mac && permission('camera') === 'not-determined') return systemPreferences.askForMediaAccess('camera')
      if (permission('camera') !== 'granted') await shell.openExternal(SETTINGS_URL.camera)
      return permission('camera') === 'granted'
    }
    if (kind === 'screen' || kind === 'audio') {
      if (!mac) return true
      // Asking for sources registers the app with macOS (first time shows the system prompt);
      // granting itself happens in System Settings.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
      if (permission('screen') !== 'granted') await shell.openExternal(SETTINGS_URL.screen)
      return permission('screen') === 'granted'
    }
    return false
  })
  ipcMain.handle('setup:relaunch', () => {
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--setup').concat('--setup') })
    app.exit(0)
  })
  ipcMain.handle('setup:displays', () => ({
    displays: screen.getAllDisplays().map(displayInfo),
    selected: String((calibrationDisplay() ?? selectedDisplay()).id)
  }))
  ipcMain.handle('setup:select-display', (event, id: string) => {
    if (!configuringSetup() || event.sender !== setupContents() || !screen.getAllDisplays().some((d) => String(d.id) === id)) {
      throw new Error('Select an available display.')
    }
    setupDisplayId = id
  })
  ipcMain.handle('setup:fullscreen', (event, displayId: string | null) => {
    if (configuringSetup() && event.sender === setupContents()) setFullscreenOn(displayId)
  })
  ipcMain.handle('setup:finish', (event) => {
    if (!configuringSetup() || event.sender !== setupContents() || !calibrationDisplay()) {
      throw new Error('Select an available display first.')
    }
    storeSet('display.id', setupDisplayId)
    storeSet('setup.done', '1')
    completed = true
    setupWin?.close()
  })
}
