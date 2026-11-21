// Outside the dev server (i.e. launched as an app), serve the built renderer and the
// WebEyeTrack worker assets from one loopback origin, so every window and worker loads
// exactly as it does in development.
import { createServer } from 'http'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, join, normalize } from 'path'
import type { AddressInfo } from 'net'
import { WET_DIST } from './vision'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
}

export async function ensureRendererUrl(): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) return
  const rendererDir = join(__dirname, '../renderer')
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    const [root, rel] = path.startsWith('/wet/') ? [WET_DIST, path.slice(4)] : [rendererDir, path === '/' ? '/index.html' : path]
    const file = normalize(join(root, rel))
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404
      return res.end()
    }
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
