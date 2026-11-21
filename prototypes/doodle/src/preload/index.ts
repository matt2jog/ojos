import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { OjosApi } from '../shared/commands'
import type { SetupApi } from '../shared/setup'

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
  nudgeHidden: () => ipcRenderer.send('nudge-hidden'),
  setOverPanel: (over) => ipcRenderer.send('mouse', over)
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
  store: {
    getItem: (key) => ipcRenderer.sendSync('store:get', key),
    setItem: (key, value) => void ipcRenderer.sendSync('store:set', key, value),
    removeItem: (key) => void ipcRenderer.sendSync('store:set', key, null)
  }
}

contextBridge.exposeInMainWorld('ojos', api)
contextBridge.exposeInMainWorld('setup', setup)
