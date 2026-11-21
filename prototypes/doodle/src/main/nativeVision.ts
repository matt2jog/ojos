import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { CaptureSpec, NativeLane } from '../shared/capture'
import { assets, project, python } from './runtime'

type Request = { timeUs: number; frameId: number; jpeg: Uint8Array }
type Reply = { type: string; id?: number; time_us?: number; frame_id?: number; result?: unknown; error?: string }

export function launchNativeVision(lane: NativeLane, spec: Pick<CaptureSpec, 'sessionId' | 'epoch'>) {
  const model = lane === 'model2' ? 'eth-xgaze' : 'confusion'
  const asset = lane === 'model2' ? 'eth-xgaze-resnet50-epoch24-camera-plane-ridge-v1' : 'confusion-devemo-plus-gru-8hz-1'
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OJOS_LOCAL_TOKEN']) delete env[key]
  const child = spawn(python(lane), [
    '-u', join(project(), 'models', 'vision', 'native_worker.py'), model, '--artifact', join(assets(), asset),
    '--session-id', spec.sessionId, '--capture-epoch', String(spec.epoch)
  ], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false
  let pending: { request: Request; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined
  const ready = Promise.withResolvers<void>()
  const startup = setTimeout(() => fail(new Error(`${model} initialization timed out.`)), 60_000)
  function fail(error: Error): void {
    if (closed) return
    closed = true
    clearTimeout(startup)
    ready.reject(error)
    clearTimeout(pending?.timer)
    pending?.reject(error)
    pending = undefined
    child.kill()
  }
  child.on('error', fail)
  child.on('exit', (code) => fail(new Error(`${model} exited (${code}).`)))
  child.stdin.on('error', fail)
  child.stderr.setEncoding('utf8').on('data', (line) => console.warn(`[${model}] ${line.trimEnd()}`))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let reply: Reply
    try { reply = JSON.parse(line) } catch { return fail(new Error(`Invalid ${model} worker reply.`)) }
    if (reply.type === 'ready') {
      clearTimeout(startup)
      ready.resolve()
      return
    }
    const job = pending
    if (!job || reply.id !== job.request.frameId) return
    clearTimeout(job.timer)
    pending = undefined
    if (reply.type === 'frame.done' && reply.frame_id === job.request.frameId && reply.time_us === job.request.timeUs) {
      job.resolve(reply.result)
    } else job.reject(new Error(reply.error ?? `Mismatched ${model} worker reply.`))
  })
  return {
    ready: ready.promise,
    async frame(request: Request): Promise<unknown> {
      await ready.promise
      if (closed) throw new Error(`${model} is closed.`)
      if (pending || request.jpeg.byteLength > 2_000_000) throw new Error(`Invalid ${model} frame request.`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`${model} inference timed out.`)), 4000)
        pending = { request, resolve, reject, timer }
        child.stdin.write(JSON.stringify({ type: 'frame', id: request.frameId, frame_id: request.frameId,
          time_us: request.timeUs, jpeg_base64: Buffer.from(request.jpeg).toString('base64') }) + '\n')
      })
    },
    close(): void { fail(new Error(`${model} stopped.`)) }
  }
}
