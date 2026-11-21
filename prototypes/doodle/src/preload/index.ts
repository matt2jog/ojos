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
  ask: (text) => ipcRenderer.send('ask', text),
  nudgeHidden: () => ipcRenderer.send('nudge-hidden'),
  setOverPanel: (over) => ipcRenderer.send('mouse', over),
  setFocus: (on) => ipcRenderer.send('focus', on),
  setChatPane: (rect) => ipcRenderer.send('chat-pane', rect)
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
  prepareCalibration: () => ipcRenderer.invoke('setup:prepare-calibration'),
  onCalibrationProgress(fn) {
    const handler = (_e: IpcRendererEvent, stage: Parameters<typeof fn>[0]): void => fn(stage)
    ipcRenderer.on('setup:calibration-progress', handler)
    return () => ipcRenderer.removeListener('setup:calibration-progress', handler)
  },
  calibrationClock: () => ipcRenderer.invoke('setup:calibration-clock'),
  onCalibrationObservation(fn) {
    const handler = (_e: IpcRendererEvent, point: Parameters<typeof fn>[0]): void => fn(point)
    ipcRenderer.on('setup:gaze', handler)
    return () => ipcRenderer.removeListener('setup:gaze', handler)
  },
  stopCalibration: () => ipcRenderer.send('setup:stop-calibration'),
  store: {
    getItem: (key) => ipcRenderer.sendSync('store:get', key),
    setItem: (key, value) => void ipcRenderer.sendSync('store:set', key, value),
    removeItem: (key) => void ipcRenderer.sendSync('store:set', key, null)
  }
}

contextBridge.exposeInMainWorld('ojos', api)
contextBridge.exposeInMainWorld('setup', setup)
