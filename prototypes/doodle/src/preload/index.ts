import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { OjosApi } from '../shared/commands'

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

contextBridge.exposeInMainWorld('ojos', api)
