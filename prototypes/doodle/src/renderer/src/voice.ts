// Voice for the mascot. In: record the microphone, main transcribes it with Gemini and asks it.
// Out: answers are read aloud sentence by sentence with the system voice as they stream in.
type Listener = () => void
const listeners = new Set<Listener>()
const emit = (): void => listeners.forEach((l) => l())
export const subscribe = (l: Listener): (() => void) => (listeners.add(l), () => void listeners.delete(l))

// ---------- text to voice ----------
let speakOn = true
try {
  speakOn = localStorage.getItem('ojos.voice') !== 'off'
} catch {
  /* storage unavailable */
}
export const isSpeakOn = (): boolean => speakOn
export function setSpeakOn(on: boolean): void {
  speakOn = on
  try {
    localStorage.setItem('ojos.voice', on ? 'on' : 'off')
  } catch {
    /* ignore */
  }
  if (!on) stopSpeaking()
  emit()
}

let voice: SpeechSynthesisVoice | null = null
function pickVoice(): void {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'))
  voice =
    voices.find((v) => /Samantha|Ava|Allison|Zoe|Google US English/i.test(v.name)) ?? voices.find((v) => v.default) ?? voices[0] ?? null
}
pickVoice()
speechSynthesis.addEventListener('voiceschanged', pickVoice)

// Sentences are fetched from ElevenLabs as they arrive (in parallel) and played strictly in
// order. A sentence that comes back null (no key, or an error) is spoken by the system voice.
let generation = 0
let chain: Promise<void> = Promise.resolve()
let playing: HTMLAudioElement | null = null

function stopSpeaking(): void {
  generation++
  chain = Promise.resolve()
  playing?.pause()
  playing = null
  speechSynthesis.cancel()
}

function playClip(bytes: Uint8Array, mine: number): Promise<void> {
  return new Promise((done) => {
    if (mine !== generation) return done()
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/mpeg' }))
    const audio = new Audio(url)
    playing = audio
    const finish = (): void => {
      URL.revokeObjectURL(url)
      if (playing === audio) playing = null
      done()
    }
    audio.onended = finish
    audio.onerror = finish
    audio.onpause = finish
    void audio.play().catch(finish)
  })
}

function systemClip(text: string, mine: number): Promise<void> {
  return new Promise((done) => {
    if (mine !== generation) return done()
    const u = new SpeechSynthesisUtterance(text)
    if (voice) u.voice = voice
    u.rate = 1.05
    u.onend = u.onerror = () => done()
    speechSynthesis.speak(u)
  })
}

function say(text: string): void {
  if (!speakOn || !text.trim()) return
  const mine = generation
  const clip = window.ojos.tts(text).catch(() => null)
  chain = chain.then(async () => {
    const bytes = await clip
    if (mine !== generation) return
    await (bytes ? playClip(bytes, mine) : systemClip(text, mine))
  })
}

window.ojos.on('cmd', (cmd) => {
  if ('say' in cmd) say(cmd.say)
})
window.ojos.on('reset', stopSpeaking)
window.ojos.on('dismiss', stopSpeaking)

// ---------- voice to text ----------
export type MicState = 'idle' | 'recording' | 'thinking' | 'error'
let mic: MicState = 'idle'
let micError = ''
export const micState = (): MicState => mic
export const micMessage = (): string => micError
const setMic = (s: MicState, msg = ''): void => {
  mic = s
  micError = msg
  emit()
}

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let autoStop: number | undefined

export async function toggleMic(): Promise<void> {
  if (mic === 'recording') return recorder?.stop()
  if (mic === 'thinking') return
  try {
    stopSpeaking()
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    chunks = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    recorder.onstop = async () => {
      clearTimeout(autoStop)
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
      recorder = null
      if (blob.size < 1500) return setMic('idle')
      setMic('thinking')
      try {
        const heard = await window.ojos.voiceAsk(new Uint8Array(await blob.arrayBuffer()), blob.type)
        setMic(heard ? 'idle' : 'error', heard ? '' : "Didn't catch that")
      } catch (e) {
        setMic('error', String((e as Error).message ?? e))
      }
      if (mic === 'error') setTimeout(() => mic === 'error' && setMic('idle'), 2500)
    }
    recorder.start()
    setMic('recording')
    autoStop = window.setTimeout(() => recorder?.stop(), 20_000)
  } catch (e) {
    const denied = (e as DOMException).name === 'NotAllowedError'
    setMic('error', denied ? 'Microphone access is off' : String((e as Error).message ?? e))
    setTimeout(() => mic === 'error' && setMic('idle'), 2500)
  }
}
