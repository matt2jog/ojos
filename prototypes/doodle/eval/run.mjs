import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, '.eval')
const baseline = 'f5275ae3277effc577f8703fbd9cc8af7bf3f986'
const options = parseArgs({ options: {
  live: { type: 'boolean' }, variant: { type: 'string', default: 'candidate' },
  'max-requests': { type: 'string', default: '8' }, case: { type: 'string', multiple: true }
} }).values
const apiKey = options.live ? process.env.GEMINI_API_KEY : 'offline-test-key'
if (!apiKey) throw new Error('Set GEMINI_API_KEY to run the live benchmark')
const cap = Number(options['max-requests'])
if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('max-requests must be a positive integer')
if (!/^[a-zA-Z0-9_/-]+$/.test(options.variant) || options.variant.startsWith('-')) throw new Error('Invalid variant')

const allCases = JSON.parse(await readFile(join(root, 'eval/cases.json'), 'utf8'))
const cases = allCases.filter(c => Boolean(c.offline) !== Boolean(options.live) &&
  (!options.case || options.case.includes(c.id)))
if (!cases.length) throw new Error('No matching cases')
await mkdir(output, { recursive: true })
const scratch = await mkdtemp(join(output, 'run-'))
const originalFetch = globalThis.fetch
let providerCalls = 0

function response(text) {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] }
}
function mockResponse(test) {
  if (test.mode === 'suggest') return Response.json(response(JSON.stringify(test.mock)))
  const text = test.mock.join('\n')
  // Split inside JSON commands to exercise the SDK and app framing together.
  const parts = [text.slice(0, 22), text.slice(22, 58), text.slice(58)]
  const body = parts.map(part => 'data: ' + JSON.stringify(response(part)) + '\n\n').join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

async function usageFrom(response) {
  try {
    const text = await response.text()
    const objects = text.trimStart().startsWith('{') ? [JSON.parse(text)] :
      text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    return objects.findLast(chunk => chunk.usageMetadata)?.usageMetadata ?? null
  } catch {
    return null
  }
}

function check(test, output, calls) {
  const parts = calls[0]?.body.contents.flatMap(turn => turn.parts ?? []) ?? []
  switch (test.check) {
    case 'abstains':
      return output.questions?.length === 0
    case 'two-distinct-questions':
      return output.questions?.length === 2
    case 'one-image-bounded-context':
      return parts.filter(part => part.inlineData).length === 1 &&
        !JSON.stringify(parts).includes('Early unrelated detail') &&
        JSON.stringify(parts).includes('Question 15')
    case 'only-valid-stream-commands':
      return JSON.stringify(output) === JSON.stringify([
        { title: 'Range values' }, { say: 'AVERAGE ignores text in referenced cells.' }
      ])
    case 'non-empty-answer':
      return output.some(row => typeof row?.say === 'string' && row.say.trim())
    case 'no-stale-request':
      return calls.length === 0 && output.length === 0
    case 'valid-doodle':
      return output.some(row => row?.draw === 'circle') && output.some(row => typeof row?.say === 'string')
    default:
      return null
  }
}

async function image(name) {
  return (await readFile(join(root, 'eval/fixtures', name + '.png'))).toString('base64')
}
function turnsFor(test) {
  if (!test.generatedTurns) return test.turns ?? []
  return Array.from({ length: test.generatedTurns }, (_, i) => ({
    question: 'Question ' + (i + 1), title: 'Earlier help',
    says: Array(3).fill(i === 0 ? 'Early unrelated detail '.repeat(35) : 'Discussed a previous spreadsheet range. '.repeat(8))
  }))
}

try {
  const ref = options.variant === 'baseline' ? baseline : options.variant
  const src = ref === 'candidate' ? await readFile(join(root, 'src/main/gemini.ts'), 'utf8') :
    spawnSync('git', ['show', ref + ':prototypes/doodle/src/main/gemini.ts'], { cwd: root, encoding: 'utf8' })
  if (typeof src !== 'string' && src.status !== 0) throw new Error(src.stderr)
  const modulePath = join(scratch, 'gemini.mts')
  await writeFile(modulePath, typeof src === 'string' ? src : src.stdout)
  const assistant = await import(pathToFileURL(modulePath).href)
  const results = []
  for (const test of cases) {
    const calls = []
    const pendingUsage = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const requestUrl = new URL(request.url)
      if (requestUrl.hostname !== 'generativelanguage.googleapis.com') throw new Error('Unexpected Gemini host')
      const body = await request.clone().json()
      if (options.live && providerCalls >= cap) throw new Error('Benchmark request limit reached')
      providerCalls++
      const call = { body, status: null, usage: null }
      calls.push(call)
      const res = options.live ? await originalFetch(request) : mockResponse(test)
      call.status = res.status
      if (options.live && res.ok) pendingUsage.push(usageFrom(res.clone()).then(usage => { call.usage = usage }))
      return res
    }
    const model = test.mode === 'suggest'
      ? (process.env.GEMINI_SUGGEST_MODEL || 'gemini-4-hydrogen')
      : (process.env.GEMINI_MODEL || 'gemini-4-neon')
    const pngBase64 = await image(test.screen)
    const turns = turnsFor(test)
    const history = turns.length ? { firstPngBase64: await image(test.firstScreen), turns } : undefined
    const commands = []
    let result = commands
    let error = null
    let firstTextMs = null
    const start = performance.now()
    try {
      if (test.mode === 'suggest') {
        result = await assistant.suggest({ apiKey, model, pngBase64, gaze: test.gaze, gazeSource: 'tracked' })
      } else {
        await assistant.streamGemini({
          apiKey, model, pngBase64, gaze: test.gaze, gazeSource: 'tracked', source: test.source,
          question: test.question, history, doodles: test.doodles ?? false, isCurrent: () => !test.dismissed,
          onCmd: cmd => {
            if (typeof cmd?.say === 'string') firstTextMs ??= performance.now() - start
            commands.push(cmd)
          }
        })
      }
    } catch (e) {
      // Raw provider exceptions may contain request details. Record only status and error type.
      error = { type: e.name, status: e.status ?? calls.at(-1)?.status ?? null }
    }
    const latencyMs = performance.now() - start
    await Promise.all(pendingUsage)
    const pass = check(test, result, calls)
    results.push({
      id: test.id, model, result, error, pass, review: test.review,
      latencyMs: Math.round(latencyMs),
      firstTextMs: firstTextMs === null ? null : Math.round(firstTextMs),
      calls: calls.map(({ body, status, usage }) => ({
        status, usage,
        images: body.contents.flatMap(turn => turn.parts ?? []).filter(part => part.inlineData).length,
        bodyBytes: Buffer.byteLength(JSON.stringify(body))
      }))
    })
    console.log(test.id, error ? JSON.stringify(error) : pass === null ? 'recorded' : pass ? 'pass' : 'fail',
      Math.round(latencyMs) + 'ms')
    if (options.live && [401, 403, 429].includes(calls.at(-1)?.status)) break
  }
  const mode = options.live ? 'live' : 'offline'
  const path = join(output, options.variant.replaceAll('/', '-') + '-' + mode + '.json')
  await writeFile(path, JSON.stringify({ variant: options.variant, mode, providerCalls, results }, null, 2) + '\n')
  console.log(path)
  if (options.variant === 'candidate' && results.some(row => row.pass === false)) process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  await rm(scratch, { recursive: true, force: true })
}
