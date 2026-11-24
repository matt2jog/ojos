import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// VS Code's terminal sets this, which makes Electron start as plain Node (no windows).
// The config is loaded in the process that spawns Electron, so clearing it here fixes all platforms.
delete process.env.ELECTRON_RUN_AS_NODE

const repoRoot = resolve(__dirname, '../..')
const vision = resolve(repoRoot, 'models/vision')

const buildFlags = (mode: string) => ({ __OJOS_DEV__: JSON.stringify(mode === 'development') })

export default defineConfig(({ mode }) => ({
  main: {
    define: buildFlags(mode),
    resolve: { alias: {
      '@vision': vision,
      '@recorder': resolve(repoRoot, 'agentic_system/capture/recorder.cjs'),
      '@assistant': resolve(repoRoot, 'agentic_system/assistant/desktop-client.mjs')
    } },
    build: { commonjsOptions: { include: [/node_modules/, /recorder\.cjs$/] } }
  },
  preload: {
    define: buildFlags(mode),
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/preload/index.ts'),
      capture: resolve(__dirname, 'src/preload/capture.ts')
    } } }
  },
  renderer: {
    define: buildFlags(mode),
    plugins: [react()],
    resolve: {
      // Matt's headless vision modules (calibration, session, sidecar export) are imported as-is.
      alias: { '@vision': vision }
    },
    publicDir: process.env.OJOS_WEBEYETRACK_DIST
      ? resolve(process.env.OJOS_WEBEYETRACK_DIST)
      : resolve(repoRoot, 'models/eye-tracking/experiments/webeyetrack/dist'),
    server: {
      fs: { allow: [repoRoot] },
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    },
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          setup: resolve(__dirname, 'src/renderer/setup.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html')
        }
      }
    }
  }
}))
