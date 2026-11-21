import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ChatHistory, DrawCmd, SavedChat, WidgetEvent } from '../shared/commands'
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

function localAssistant(): Promise<{ baseUrl: string; token: string }> {
  connection ??= startLocal().catch((error) => {
    stopBackend()
    throw error
  })
  return connection
}

export async function assistant(): Promise<{ baseUrl: string; token: string }> {
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
  return localAssistant()
}

async function startLocal(): Promise<{ baseUrl: string; token: string }> {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) throw new Error('Set GEMINI_API_KEY to start the live local assistant.')
  const port = await freePort()
  if (closed) throw new Error('The assistant has stopped.')
  const baseUrl = `http://127.0.0.1:${port}`
  const token = randomBytes(32).toString('hex')
  let launchError: Error | undefined
  const home = app.getPath('userData')
  const inbox = join(home, 'chat-files')
  await mkdir(inbox, { recursive: true })
  const processHandle = spawn(python('assistant'), [
    '-B', '-m', 'agentic_system.assistant', 'serve', '--port', String(port), '--chat-db', join(home, 'chat.sqlite3')
  ], {
    cwd: project(), env: {
      ...process.env, OJOS_LOCAL_TOKEN: token, OJOS_CHAT_ROOTS: process.env.OJOS_CHAT_ROOTS ?? inbox
    }, windowsHide: true, stdio: 'ignore'
  })
  child = processHandle
  processHandle.on('error', (error) => { launchError = error })
  processHandle.once('exit', () => { if (child === processHandle) stopBackend() })
  for (let i = 0; i < 200; i++) {
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

interface ChatRequest {
  chatId: string
  turnId: string
  message: string
  screenContext?: string
  jpeg?: string
  doodles: boolean
  signal: AbortSignal
}

type ChatEvent = { kind: 'status'; text: string } | { kind: 'delta'; text: string } | { kind: 'doodle'; command: DrawCmd }
  | { kind: 'widget'; widget: WidgetEvent }
const TOOL_LABELS: Record<string, string> = {
  list_files: 'Finding local files',
  read_file: 'Reading a local file',
  search_files: 'Searching local files',
  ingest_file: 'Indexing a file',
  search_ingested: 'Looking up indexed passages',
  web_search: 'Searching the web',
  read_url: 'Reading a web page',
  remember: 'Saving a note',
  recall: 'Looking up a note',
  run_subagent: 'Asking a Gemini helper',
  render_visual: 'Drawing a visual'
}

export async function streamChatTurn(opts: ChatRequest, onEvent: (event: ChatEvent) => void): Promise<{ text: string; chat: SavedChat }> {
  const { baseUrl, token } = await localAssistant()
  const response = await fetch(new URL(`/v1/chats/${opts.chatId}/messages`, baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ turn_id: opts.turnId, message: opts.message, screen_context: opts.screenContext,
      jpeg_base64: opts.jpeg, doodles: opts.doodles }),
    signal: opts.signal
  })
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.message || `Chat returned HTTP ${response.status}.`)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let ui: Pick<WidgetEvent, 'kind' | 'confidence' | 'probabilities'> | undefined
  let drawn = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Chat closed before the answer was saved.')
      buffer += value
      if (buffer.length > 500_000) throw new Error('Chat event exceeded the size limit.')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const lines = buffer.slice(0, boundary).split('\n')
        buffer = buffer.slice(boundary + 2)
        const name = lines.find((line) => line.startsWith('event: '))?.slice(7).trim()
        const raw = lines.find((line) => line.startsWith('data: '))?.slice(6)
        if (!raw) continue
        const data = JSON.parse(raw)
        if (name === 'turn.error') throw new Error(data.message)
        if (name === 'turn.done' && typeof data.text === 'string') {
          // The decision asked for a visual but the agent never rendered one.
          if (ui && ui.kind !== 'none' && !drawn) onEvent({ kind: 'widget', widget: { state: 'error', ...ui } })
          return data
        }
        if (name === 'turn.delta' && typeof data.text === 'string') onEvent({ kind: 'delta', text: data.text })
        if (name === 'turn.doodle' && data.draw) onEvent({ kind: 'doodle', command: data })
        // Generative UI: the decision model's choice, then the visual the agent rendered for it.
        if (name === 'turn.ui' && typeof data.kind === 'string') {
          ui = { kind: data.kind, confidence: data.confidence ?? 0, probabilities: data.probabilities ?? {} }
          onEvent({ kind: 'widget', widget: { state: ui.kind === 'none' ? 'text' : 'drawing', ...ui } })
        }
        if (name === 'turn.widget' && typeof data.html === 'string') {
          onEvent({ kind: 'widget', widget: { state: 'ready', ...(ui ?? { kind: data.kind, confidence: 0, probabilities: {} }), html: data.html } })
          drawn = true
        }
        if (name === 'turn.status') {
          const text = typeof data.text === 'string' ? data.text : TOOL_LABELS[data.tools?.[0]] ?? 'Using a tool'
          onEvent({ kind: 'status', text })
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function localChatGet(route: string, signal: AbortSignal) {
  const { baseUrl, token } = await localAssistant()
  const response = await fetch(new URL(route, baseUrl), {
    headers: { Authorization: `Bearer ${token}` }, signal
  })
  if (!response.ok) throw new Error('Could not load saved chats.')
  return response.json()
}

export async function chatHistory(chatId: string, signal: AbortSignal, before?: number): Promise<ChatHistory> {
  const query = before === undefined ? '' : `?before_seq=${before}`
  return localChatGet(`/v1/chats/${chatId}/history${query}`, signal)
}

export async function savedChats(signal: AbortSignal): Promise<SavedChat[]> {
  return (await localChatGet('/v1/chats', signal)).chats
}
