import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureBridge } from '../shared/capture'

const media: CaptureBridge = {
  clock: () => ipcRenderer.invoke('capture:clock'),
  screen: (frame) => ipcRenderer.invoke('capture:screen', frame),
  audio: (block) => ipcRenderer.invoke('capture:audio', block),
  audioUnavailable: (reason) => ipcRenderer.send('capture:audio-unavailable', reason),
  profiles: (geometry) => ipcRenderer.invoke('capture:profiles', geometry),
  nativeReady: (lane) => ipcRenderer.invoke('capture:native-ready', lane),
  nativeFrame: (lane, packet) => ipcRenderer.invoke('capture:native-frame', lane, packet),
  calibrationProgress: (stage) => ipcRenderer.send('capture:calibration-progress', stage),
  observation: (point) => ipcRenderer.send('capture:observation', point),
  interval: (event) => ipcRenderer.send('capture:interval', event),
  ended: (reason) => ipcRenderer.send('capture:ended', reason),
  workerError: (lane, reason) => ipcRenderer.send('capture:worker-error', lane, reason)
}
contextBridge.exposeInMainWorld('capture', media)
