import { build, Arch, Platform } from 'electron-builder'
import { access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'

const windows = process.platform === 'win32' && process.arch === 'x64'
const mac = process.platform === 'darwin' && process.arch === 'arm64'
if (!windows && !mac) throw new Error('Build the installer on Windows x64 or Apple Silicon macOS.')
if (!process.env.OJOS_RUNTIME_DIR) throw new Error('Set OJOS_RUNTIME_DIR to the staged portable Python and FFmpeg runtime.')

const app = resolve(import.meta.dirname, '..')
const repo = resolve(app, '../..')
const runtime = resolve(process.env.OJOS_RUNTIME_DIR)
const python = windows ? 'python.exe' : 'bin/python3'
for (const file of [
  join(app, 'out/renderer/bench-worker.js'),
  join(app, 'out/renderer/face_landmarker.task'),
  join(app, 'out/renderer/web/model.json'),
  join(app, 'out/renderer/web/group1-shard1of1.bin'),
  join(app, 'out/renderer/mp/vision_wasm_internal.wasm'),
  join(app, 'out/renderer/tf/tfjs-backend-wasm-threaded-simd.wasm'),
  join(runtime, 'bin', windows ? 'ffmpeg.exe' : 'ffmpeg'),
  join(runtime, 'bin', windows ? 'ffprobe.exe' : 'ffprobe'),
  join(runtime, 'python', python)
]) {
  await access(file).catch(() => { throw new Error(`Missing installer input: ${file}`) })
}

try {
  execFileSync(join(runtime, 'python', python), ['-B', '-c', 'import google.adk, pypdf'], {
    stdio: 'ignore', windowsHide: true
  })
} catch {
  throw new Error('Install agentic_system/assistant/requirements.txt into the staged Python runtime before packaging.')
}

await build({
  projectDir: app,
  targets: windows ? Platform.WINDOWS.createTarget('nsis', Arch.x64) : Platform.MAC.createTarget('dmg', Arch.arm64),
  config: {
    appId: 'com.ojos.desktop',
    productName: 'Ojos',
    directories: { output: process.env.OJOS_INSTALL_OUTPUT ?? 'release' },
    files: ['out/**', 'resources/**', 'package.json', '!**/.env*'],
    extraResources: [
      { from: runtime, to: 'ojos/runtime', filter: ['bin/**', 'python/**', '!**/.env*', '!**/__pycache__/**'] },
      { from: repo, to: 'ojos', filter: [
        'agentic_system/assistant/*.py', '!agentic_system/assistant/test_*.py',
        'models/vision/native_worker.py',
        'models/confusion/runtime.py', 'models/confusion/intervals.py', 'models/confusion/preprocess.py',
        'models/eye-tracking/experiments/eth-xgaze/bench.py'
      ] }
    ],
    win: { icon: join(app, 'resources', 'icon.png') },
    mac: {
      icon: join(app, 'resources', 'icon.icns'),
      minimumSystemVersion: '14.2',
      extendInfo: {
        NSCameraUsageDescription: 'Ojos uses the camera on this Mac to estimate gaze and detect when help may be useful.',
        NSAudioCaptureUsageDescription: 'Ojos includes desktop playback audio in short clips when it offers help.'
      }
    }
  }
})
