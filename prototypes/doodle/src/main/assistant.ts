import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { project, python } from './runtime'

let child: ChildProcess | undefined
let connection: Promise<{ baseUrl: string; token: string }> | undefined
let closed = false

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject).listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No local assistant port.')); return }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

export function assistant(): Promise<{ baseUrl: string; token: string }> {
  connection ??= connect().catch((error) => {
    stopBackend()
    throw error
  })
  return connection
}

async function connect(): Promise<{ baseUrl: string; token: string }> {
  const remote = process.env.OJOS_ASSISTANT_URL
  if (remote) {
    const url = new URL(remote)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('Assistant endpoints must use HTTPS or loopback HTTP.')
    }
    const token = process.env.OJOS_LOCAL_TOKEN
    if (!token) throw new Error('The configured assistant needs OJOS_LOCAL_TOKEN.')
    return { baseUrl: url.href, token }
  }
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) throw new Error('Set GEMINI_API_KEY to start the live local assistant.')
  const port = await freePort()
  if (closed) throw new Error('The assistant has stopped.')
  const baseUrl = `http://127.0.0.1:${port}`
  const token = randomBytes(32).toString('hex')
  let launchError: Error | undefined
  const processHandle = spawn(python('assistant'), ['-B', '-m', 'agentic_system.assistant', 'serve', '--port', String(port)], {
    cwd: project(), env: { ...process.env, OJOS_LOCAL_TOKEN: token }, windowsHide: true, stdio: 'ignore'
  })
  child = processHandle
  processHandle.on('error', (error) => { launchError = error })
  processHandle.once('exit', () => { if (child === processHandle) stopBackend() })
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError
    if (child !== processHandle || processHandle.exitCode !== null) throw new Error('The local assistant exited during startup.')
    try {
      // An authenticated 404 confirms the expected server is ready without creating a job.
      const response = await fetch(`${baseUrl}/v1/jobs/00000000-0000-0000-0000-000000000000/events`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500)
      })
      if (response.status === 404 && (await response.json()).error === 'unknown_job') return { baseUrl, token }
    } catch { /* Server is still starting. */ }
    await sleep(100)
  }
  throw new Error('The local assistant did not start.')
}

function stopBackend(): void {
  const existing = child
  connection = undefined
  child = undefined
  existing?.kill()
}

export function stopAssistant(): void {
  closed = true
  stopBackend()
}
