import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve, extname, normalize, join } from 'path'
import { createReadStream, existsSync, statSync } from 'fs'
import type { Plugin } from 'vite'

// VS Code's terminal sets this, which makes Electron start as plain Node (no windows).
// The config is loaded in the process that spawns Electron, so clearing it here fixes all platforms.
delete process.env.ELECTRON_RUN_AS_NODE

const repoRoot = resolve(__dirname, '../..')

// Dev server: serve Matt's built WebEyeTrack worker and its assets at /wet/ (same origin as the app).
const wetDist = resolve(repoRoot, 'models/eye-tracking/experiments/webeyetrack/dist')
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.task': 'application/octet-stream'
}
const serveWet = (): Plugin => ({
  name: 'ojos-serve-webeyetrack',
  configureServer(server) {
    server.middlewares.use('/wet', (req, res, next) => {
      const file = normalize(join(wetDist, decodeURIComponent((req.url ?? '/').split('?')[0])))
      if (!file.startsWith(wetDist) || !existsSync(file) || !statSync(file).isFile()) return next()
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
      createReadStream(file).pipe(res)
    })
  }
})

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), serveWet()],
    resolve: {
      // Matt's headless vision modules (calibration, session, sidecar export) are imported as-is.
      alias: { '@vision': resolve(repoRoot, 'models/vision') }
    },
    server: { fs: { allow: [repoRoot] } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          setup: resolve(__dirname, 'src/renderer/setup.html'),
          vision: resolve(__dirname, 'src/renderer/vision.html')
        }
      }
    }
  }
})
