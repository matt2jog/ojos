import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { OjosApi } from '../shared/commands'
import type { SetupApi } from '../shared/setup'
import type { VisionApi } from '../shared/vision'

const api: OjosApi = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, fn: (data: any) => void) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_e: IpcRendererEvent, data: any): void => fn(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  dismiss: () => ipcRenderer.send('dismiss'),
  accept: (question) => ipcRenderer.send('accept', question),
  ask: (text) => ipcRenderer.send('ask', text),
  nudgeHidden: () => ipcRenderer.send('nudge-hidden'),
  setOverPanel: (over) => ipcRenderer.send('mouse', over),
  setFocus: (on) => ipcRenderer.send('focus', on),
  openSettings: () => ipcRenderer.send('open-settings'),
  voiceAsk: (audio, mimeType) => ipcRenderer.invoke('voice-ask', audio, mimeType),
  tts: (text) => ipcRenderer.invoke('tts', text)
}

const setup: SetupApi = {
  platform: () => ipcRenderer.invoke('setup:platform'),
  permissions: () => ipcRenderer.invoke('setup:permissions'),
  request: (kind) => ipcRenderer.invoke('setup:request', kind),
  relaunch: () => ipcRenderer.invoke('setup:relaunch'),
  displays: () => ipcRenderer.invoke('setup:displays'),
  selectDisplay: (id) => ipcRenderer.invoke('setup:select-display', id),
  fullscreen: (id) => ipcRenderer.invoke('setup:fullscreen', id),
  finish: () => ipcRenderer.invoke('setup:finish'),
  close: () => ipcRenderer.invoke('setup:close'),
  settings: () => ipcRenderer.invoke('settings:get'),
  setSensitivity: (high) => ipcRenderer.invoke('settings:sensitivity', high),
  quit: () => ipcRenderer.invoke('app:quit'),
  store: {
    getItem: (key) => ipcRenderer.sendSync('store:get', key),
    setItem: (key, value) => void ipcRenderer.sendSync('store:set', key, value),
    removeItem: (key) => void ipcRenderer.sendSync('store:set', key, null)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listen = (channel: string, fn: (...args: any[]) => void): (() => void) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (_e: IpcRendererEvent, ...args: any[]): void => fn(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

let epochMs: number | null = null
const vision: VisionApi = {
  epochMs: () => (epochMs ??= (ipcRenderer.sendSync('vision:epoch-ms') as number | undefined) ?? Date.now()),
  config: () => ipcRenderer.invoke('vision:config'),
  confusion: (jpeg, timeUs, frameId) => ipcRenderer.invoke('vision:confusion', jpeg, timeUs, frameId),
  reportCamera: (g) => ipcRenderer.send('vision:camera', g),
  reportStatus: (s) => ipcRenderer.send('vision:status', s),
  reportObservation: (tracker, timeUs, raw) => ipcRenderer.send('vision:observation', tracker, timeUs, raw),
  reportGaze: (gaze, score) => ipcRenderer.send('vision:gaze', gaze, score),
  reportInterval: (gaze, score) => ipcRenderer.send('vision:interval', gaze, score),
  geometry: () => ipcRenderer.invoke('vision:geometry').catch(() => null),
  status: () => ipcRenderer.invoke('vision:status').catch(() => null),
  reload: () => ipcRenderer.invoke('vision:reload').catch(() => undefined),
  onReload: (fn) => listen('vision:reload', fn),
  onStatus: (fn) => listen('vision:status', fn),
  onObservation: (fn) => listen('vision:observation', fn)
}

contextBridge.exposeInMainWorld('vision', vision)
contextBridge.exposeInMainWorld('ojos', api)
contextBridge.exposeInMainWorld('setup', setup)
