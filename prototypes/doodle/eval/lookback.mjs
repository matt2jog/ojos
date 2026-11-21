import electron from 'electron'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { app, nativeImage } = electron
const root = fileURLToPath(new URL('../', import.meta.url))
const out = join(root, '.eval', 'track2')
const { values: options } = parseArgs({
  args: process.argv.slice(process.argv[1]?.endsWith('lookback.mjs') ? 2 : 1),
  options: {
    live: { type: 'boolean' }, baseline: { type: 'boolean' }, media: { type: 'string' },
    at: { type: 'string' }, question: { type: 'string' }, expect: { type: 'string' },
    case: { type: 'string', multiple: true },
    cap: { type: 'string', default: '4' }, name: { type: 'string', default: 'lookback' }
  }
})
const cap = Number(options.cap)
assert(Number.isInteger(cap) && cap >= 1)
assert(/^[a-z0-9-]+$/.test(options.name))
const key = options.live ? process.env.GEMINI_API_KEY : 'lookback-test-key'
if (!key) throw Error('Set GEMINI_API_KEY for live replay')
const baselineCommit = '25caf060c47ea21842f9989fc0c7aeac21725ca5'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw Error(result.stderr || String(result.error))
  return result.stdout
}

async function main() {
app.dock?.hide()
await mkdir(out, { recursive: true })
const scratch = await mkdtemp(join(out, 'replay-'))
const originalFetch = globalThis.fetch
let requests = 0

function result(text, part) {
  return { candidates: [{ index: 0, content: { role: 'model', parts: [part ?? { text }] } }] }
}

function stub(call, scenario, trace) {
  if (call.stage === 'decisions') {
    if (scenario.decisionError) return Response.json({ error: { message: 'Unavailable' } }, { status: 503 })
    const choice = scenario.noEvidence ? 'no_prior_evidence' : scenario.invalidChoice ? 'frame-99' : 'frame-1'
    return Response.json({ answers: { best_frame: { type: 'choice', choice, confidence: 0.97 } } })
  }
  const evidence = trace.some(item => item.attachedFrame)
  const answer = evidence ? (scenario.expect ?? 'The earlier dialog displayed the error.') : 'I can see the current screen only.'
  return new Response('data: ' + JSON.stringify(result(JSON.stringify({ title: 'Screen evidence' }) + '\n' +
    JSON.stringify({ say: answer }) + '\n')) + '\n\n', {
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

async function replay(scenario, assistant, ScreenHistory) {
  const decode = bytes => nativeImage.createFromBuffer(bytes)
  const currentBytes = await readFile(scenario.current)
  const current = decode(currentBytes)
  assert(!current.isEmpty(), 'Current frame must decode')
  const history = new ScreenHistory(decode)
  for (const frame of scenario.frames) {
    const image = decode(await readFile(frame.path))
    assert(!image.isEmpty(), 'History frame must decode')
    history.remember(image, frame.at)
  }
  const frames = history.evidence(current, scenario.now, scenario.now)
  if (scenario.frames.length && !scenario.expired) assert(frames.length, 'Replay needs a visible change')
  const trace = []
  const pendingReads = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname !== 'generativelanguage.googleapis.com') throw Error('Unexpected Gemini host')
    if (options.live && requests >= cap) throw Error('Request cap reached')
    requests++
    const body = await request.clone().json()
    const stage = url.pathname.endsWith('/decisions') ? 'decisions' :
      url.pathname.includes(':streamGenerateContent') ? 'answer' : 'inspect'
    const parts = body.contents?.flatMap(turn => turn.parts ?? []) ?? []
    const evidence = parts.some(part => part.inlineData?.mimeType === 'image/jpeg')
    const row = {
      stage,
      model: body.model ?? url.pathname.split('/').at(-1).split(':')[0],
      requestBytes: Buffer.byteLength(JSON.stringify(body)),
      attachedFrame: Boolean(evidence),
      images: parts.filter(part => part.inlineData).length +
        (Array.isArray(body.input) ? body.input.filter(part => part.type === 'image').length : 0),
      status: null,
      serverLatencyMs: null,
      usage: null,
      choice: null,
      providerMessage: null
    }
    trace.push(row)
    const start = performance.now()
    const response = options.live ? await originalFetch(request) : stub(row, scenario, trace)
    row.status = response.status
    row.serverLatencyMs = Math.round(performance.now() - start)
    pendingReads.push(response.clone().text().then(raw => {
      try {
        const replies = raw.trimStart().startsWith('{') ? [JSON.parse(raw)] :
          raw.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
        const data = replies.findLast(item => item.usage || item.usageMetadata)
        row.usage = data?.usage ?? data?.usageMetadata ?? null
        row.choice = replies[0]?.answers?.best_frame ??
          replies[0]?.candidates?.[0]?.content?.parts?.find(part => part.functionCall)?.functionCall?.args ?? null
        // Preserve status only. Provider errors can quote request inputs.
        row.providerMessage = response.ok ? null : replies[0]?.error?.status ?? null
      } catch {}
    }).catch(() => {}))
    return response
  }

  let firstTextMs = null
  const messages = []
  const start = performance.now()
  let error = null
  try {
    await assistant.streamGemini({
      apiKey: key, model: 'gemini-4-hydrogen', pngBase64: current.toPNG().toString('base64'),
      source: 'typed', question: scenario.question, gaze: { x: 500, y: 500 }, gazeSource: 'unavailable',
      pastFrames: frames, doodles: false, isCurrent: () => true, onCmd: cmd => {
        if ('say' in cmd) firstTextMs ??= Math.round(performance.now() - start)
        messages.push(cmd)
      }
    })
  } catch (e) {
    error = e.name
  }
  const latencyMs = Math.round(performance.now() - start)
  await Promise.all(pendingReads)
  const spoken = messages.flatMap(message => message.say ?? []).join(' ')
  const pass = scenario.expect ? spoken.toLowerCase().includes(scenario.expect.toLowerCase()) &&
    (trace.at(-1)?.attachedFrame ?? false) && !/cannot see|can't see|only have the current/i.test(spoken) : null
  if (!options.live) {
    assert.deepEqual(trace.map(item => item.stage), scenario.stages)
    assert.equal(trace.at(-1).model, scenario.model ?? 'gemini-4-hydrogen')
    assert.equal(trace.at(-1).attachedFrame, scenario.attached ?? false)
    assert.equal(error, null)
  }
  return {
    id: scenario.id, question: scenario.question, expected: scenario.expect,
    availableFrames: frames.map(({ id, ageMs, region }) => ({ id, ageMs, region })),
    currentSha256: createHash('sha256').update(currentBytes).digest('hex'),
    pass, firstTextMs, latencyMs, messages, error, trace
  }
}

async function timedFootage() {
  assert(options.media && options.question && Number(options.at) >= 8, 'Set --media, --at >= 8, and --question')
  const now = Number(options.at)
  run('ffmpeg', ['-loglevel', 'error', '-ss', String(now - 8), '-i', options.media,
    '-t', '8', '-vf', 'fps=2', '-frames:v', '16', join(scratch, 'history-%03d.jpg')])
  const current = join(scratch, 'current.png')
  run('ffmpeg', ['-loglevel', 'error', '-ss', String(now), '-i', options.media, '-frames:v', '1', current])
  const list = (await readdir(scratch)).filter(path => path.startsWith('history')).sort()
  return [{ id: options.name, question: options.question, expect: options.expect, current, now: 8000,
    frames: list.map((path, i) => ({ path: join(scratch, path), at: i * 500 })) }]
}

try {
  const saved = options.baseline
    ? run('git', ['show', baselineCommit + ':prototypes/doodle/src/main/gemini.ts'])
    : await readFile(join(root, 'src/main/gemini.ts'), 'utf8')
  await writeFile(join(scratch, 'assistant.mts'), saved)
  await writeFile(join(scratch, 'screen-history.mts'), await readFile(join(root, 'src/main/screen-history.ts')))
  const assistant = await import(pathToFileURL(join(scratch, 'assistant.mts')))
  const { ScreenHistory } = await import(pathToFileURL(join(scratch, 'screen-history.mts')))
  const folder = join(root, 'eval', 'fixtures')
  const question = 'What error message was on screen just before now? Quote the exact code and suggest one fix.'
  const current = join(folder, 'worksheet.png')
  const frame = name => ({ path: join(folder, name + '.jpg'), at: 2000 })
  const a = { id: 'date-range', question, current, now: 4250, frames: [frame('past-date-range')], expect: 'E412' }
  const b = { id: 'read-only', question, current, now: 4250, frames: [frame('past-read-only')], expect: 'E518' }
  const deep = { stages: ['decisions', 'answer'], model: 'gemini-4-neon', attached: true }
  const offline = [
    { ...a, ...deep },
    { ...b, ...deep },
    { ...a, id: 'ordinary', question: 'What formula is on screen?', expect: undefined, stages: ['answer'] },
    { ...a, id: 'expired', expired: true, now: 15_000, expect: undefined, stages: ['answer'] },
    { ...a, id: 'irrelevant', noEvidence: true, expect: undefined, stages: ['decisions', 'answer'] },
    { ...a, ...deep, id: 'decisions-unavailable', decisionError: true },
    { ...a, ...deep, id: 'unknown-frame', invalidChoice: true }
  ]
  const all = options.media ? await timedFootage() : options.live ? [a, b] : offline
  const cases = options.case ? all.filter(row => options.case.includes(row.id)) : all
  assert(cases.length, 'No matching cases')
  const results = []
  for (const scenario of cases) {
    const report = await replay(scenario, assistant, ScreenHistory)
    results.push(report)
    console.log(scenario.id, JSON.stringify({
      pass: report.pass, ms: report.firstTextMs,
      stages: report.trace.map(call => [call.stage, call.status, call.attachedFrame, call.choice]),
      messages: report.messages, error: report.error
    }))
  }
  const path = join(out, options.name + (options.baseline ? '-baseline' : '') + (options.live ? '-live' : '-offline') + '.json')
  await writeFile(path, JSON.stringify({ requests, results }, null, 2) + '\n')
  console.log(path)
} finally {
  globalThis.fetch = originalFetch
  await rm(scratch, { recursive: true, force: true })
  app.quit()
}
}

app.whenReady().then(main).catch(error => {
  console.error(error.message)
  app.exit(1)
})
