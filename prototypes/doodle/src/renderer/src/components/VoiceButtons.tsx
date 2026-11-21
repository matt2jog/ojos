import { useSyncExternalStore } from 'react'
import { isSpeakOn, micMessage, micState, setSpeakOn, subscribe, toggleMic } from '../voice'

/** Microphone (ask out loud) and speaker (read answers aloud) buttons for the mascot bar. */
export function VoiceButtons(): React.JSX.Element {
  const mic = useSyncExternalStore(subscribe, micState)
  const speak = useSyncExternalStore(subscribe, isSpeakOn)
  const msg = useSyncExternalStore(subscribe, micMessage)
  const micTitle =
    mic === 'recording' ? 'Listening… click to send' : mic === 'thinking' ? 'Transcribing…' : mic === 'error' ? msg : 'Ask out loud'
  return (
    <>
      <button
        onClick={() => void toggleMic()}
        aria-label={micTitle}
        title={micTitle}
        className={`voice-mic ${mic}`}
        aria-pressed={mic === 'recording'}
      >
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path d="M8 2.2a1.9 1.9 0 0 0-1.9 1.9v3.3a1.9 1.9 0 0 0 3.8 0V4.1A1.9 1.9 0 0 0 8 2.2z" />
          <path d="M4.2 7.4a3.8 3.8 0 0 0 7.6 0M8 11.2v2.4" />
        </svg>
      </button>
      <button
        onClick={() => setSpeakOn(!speak)}
        aria-label={speak ? 'Voice replies on' : 'Voice replies off'}
        title={speak ? 'Voice replies on · click to mute' : 'Voice replies off · click to turn on'}
        aria-pressed={speak}
        className={speak ? '' : 'voice-muted'}
      >
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path d="M2.8 6.4h2l2.9-2.3v7.8L4.8 9.6h-2z" />
          {speak ? <path d="M10.2 5.9a3 3 0 0 1 0 4.2M12 4.4a5.2 5.2 0 0 1 0 7.2" /> : <path d="M10.4 6.2l3.2 3.6M13.6 6.2l-3.2 3.6" />}
        </svg>
      </button>
    </>
  )
}
