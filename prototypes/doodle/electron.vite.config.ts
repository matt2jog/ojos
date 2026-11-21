import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// VS Code's terminal sets this, which makes Electron start as plain Node (no windows).
// The config is loaded in the process that spawns Electron, so clearing it here fixes all platforms.
delete process.env.ELECTRON_RUN_AS_NODE

const repoRoot = resolve(__dirname, '../..')

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    resolve: {
      // Matt's headless vision modules (calibration, session, sidecar export) are imported as-is.
      alias: { '@vision': resolve(repoRoot, 'models/vision') }
    },
    server: { fs: { allow: [repoRoot] } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          setup: resolve(__dirname, 'src/renderer/setup.html')
        }
      }
    }
  }
})
