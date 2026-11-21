import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// VS Code's terminal sets this, which makes Electron start as plain Node (no windows).
// The config is loaded in the process that spawns Electron, so clearing it here fixes all platforms.
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
