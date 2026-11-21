// Voice questions: the mascot records a short clip, Gemini transcribes it, and the text is
// asked like a typed question.
import { GoogleGenAI } from '@google/genai'

export async function transcribe(opts: { apiKey: string; model: string; audio: Uint8Array; mimeType: string }): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })
  const res = await ai.models.generateContent({
    model: opts.model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: opts.mimeType.split(';')[0], data: Buffer.from(opts.audio).toString('base64') } },
          { text: 'Transcribe exactly what the person says. Output only their words, with no quotes or commentary. If there is no speech, output nothing.' }
        ]
      }
    ]
  })
  return (res.text ?? '').trim()
}

// ---------- spoken replies: ElevenLabs ----------
// Returns MP3 bytes, or null when no key is configured (the renderer then uses the system voice).
const ELEVEN_VOICE = (): string => process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM' // "Rachel"
const ELEVEN_MODEL = (): string => process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5' // low latency
export const elevenLabsEnabled = (): boolean => Boolean(process.env.ELEVENLABS_API_KEY)

let warned = false
export async function synthesize(text: string): Promise<Uint8Array | null> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key || !text.trim()) return null
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE()}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL() })
    })
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    if (!warned) console.error('[voice] ElevenLabs failed, using the system voice:', (e as Error).message)
    warned = true
    return null
  }
}
