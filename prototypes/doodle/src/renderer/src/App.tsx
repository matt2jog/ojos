import { useCallback, useEffect, useRef, useState } from 'react'
import { Companion, type TurnView } from './components/Companion'
import { DoodleCanvas } from './components/DoodleCanvas'
import { ReadyToast } from './components/ReadyToast'
import type { DoodleEngine, EngineHooks } from './doodle/engine'

type Status = { kind: 'idle' | 'thinking' | 'error'; text?: string }
type Mode = 'hidden' | 'nudge' | 'chat'

const editLast = (thread: TurnView[], edit: (t: TurnView) => TurnView): TurnView[] =>
  thread.length ? [...thread.slice(0, -1), edit(thread[thread.length - 1])] : thread
const doodleHooks: EngineHooks = { title: () => {}, say: async () => {} }

export function App(): React.JSX.Element {
  const engineRef = useRef<DoodleEngine | null>(null)
  const [mode, setMode] = useState<Mode>('hidden')
  const [thread, setThread] = useState<TurnView[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [gaze, setGaze] = useState<{ x: number; y: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [questions, setQuestions] = useState<string[] | null>(null)
  const [mac, setMac] = useState(true)
  const [focusSignal, setFocusSignal] = useState(0)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modeRef = useRef<Mode>('hidden')
  modeRef.current = mode
  const threadRef = useRef<TurnView[]>([])
  threadRef.current = thread
  const setOverUi = useCallback((over: boolean) => window.ojos.setOverPanel(over), [])

  const clearNudgeTimer = useCallback(() => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current)
  }, [])

  // Ignored mascot goes away: they were probably just thinking. Paused while hovered,
  // and never while a conversation is open.
  const armNudgeTimeout = useCallback(
    (ms: number) => {
      clearNudgeTimer()
      nudgeTimer.current = setTimeout(() => {
        if (modeRef.current !== 'nudge') return
        setMode('hidden')
        window.ojos.nudgeHidden()
      }, ms)
    },
    [clearNudgeTimer]
  )
  const onHover = useCallback(
    (over: boolean) => {
      setOverUi(over)
      if (over) clearNudgeTimer()
      else if (modeRef.current === 'nudge') armNudgeTimeout(6000)
    },
    [setOverUi, clearNudgeTimer, armNudgeTimeout]
  )

  const openChat = useCallback(() => {
    clearNudgeTimer()
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    setMode('chat')
    setFocusSignal((n) => n + 1)
  }, [clearNudgeTimer])

  const dismissLocal = useCallback(() => {
    clearNudgeTimer()
    engineRef.current?.cancel()
    setMode('hidden')
    setBusy(false)
    setGaze(null)
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    fadeTimer.current = setTimeout(() => {
      engineRef.current?.reset()
      setThread([])
      setQuestions(null)
      setStatus({ kind: 'idle' })
    }, 400) // after the CSS fade
  }, [clearNudgeTimer])

  useEffect(() => {
    const offs = [
      window.ojos.on('ready', (msg) => {
        const [label, mod] = msg.split('|')
        setMac(mod === 'Cmd')
        setToast(`Ojos is running (${label}). Press ${mod === 'Cmd' ? '⌘⇧O' : 'Ctrl+Shift+O'} for help with your recent screen activity.`)
      }),
      window.ojos.on('nudge', () => {
        // Might just be thinking: offer help, never force it.
        if (fadeTimer.current) clearTimeout(fadeTimer.current)
        setQuestions(null)
        if (modeRef.current === 'chat') return // new suggestions show up inside the conversation
        setThread([])
        setStatus({ kind: 'idle' })
        setMode('nudge')
        armNudgeTimeout(15000)
      }),
      window.ojos.on('suggest', (sug) => {
        // Inside a conversation, don't offer again what was already asked.
        const asked = new Set(threadRef.current.map((t) => t.question))
        setQuestions(sug.questions.filter((q) => !asked.has(q)))
      }),
      window.ojos.on('chat', openChat),
      window.ojos.on('chat-history', (turns) => {
        setThread(turns.map(({ question, answer }) => ({ question, title: question, says: [answer] })))
        setQuestions([])
        setStatus({ kind: 'idle' })
        setGaze(null)
      }),
      window.ojos.on('reset', ({ gaze, question, fresh }) => {
        clearNudgeTimer()
        if (fadeTimer.current) clearTimeout(fadeTimer.current)
        engineRef.current?.reset()
        setThread((prev) => [...(fresh ? [] : prev), { question, title: question ?? '', says: [] }])
        setQuestions((qs) => (qs ?? []).filter((q) => q !== question))
        setGaze(gaze ?? null)
        setStatus({ kind: 'thinking' })
        setBusy(true)
        setMode('chat')
      }),
      window.ojos.on('chat-status', (text) => setStatus({ kind: 'thinking', text })),
      window.ojos.on('chat-delta', (text) => {
        setStatus({ kind: 'idle' })
        setThread((prev) => editLast(prev, (turn) => ({ ...turn, says: [(turn.says[0] ?? '') + text] })))
      }),
      window.ojos.on('chat-answer', (text) => {
        setThread((prev) => editLast(prev, (turn) => ({ ...turn, says: [text] })))
      }),
      window.ojos.on('cmd', (cmd) => engineRef.current?.push(cmd)),
      window.ojos.on('error', (text) => {
        setStatus({ kind: 'error', text })
        setBusy(false)
      }),
      window.ojos.on('done', () => {
        setStatus({ kind: 'idle' })
        setBusy(false)
      }),
      window.ojos.on('dismiss', dismissLocal)
    ]
    return () => offs.forEach((off) => off())
  }, [dismissLocal, clearNudgeTimer, armNudgeTimeout, openChat])

  return (
    <>
      <div className={`stage ${mode === 'chat' ? 'on' : ''} ${busy ? 'busy' : ''}`}>
        <div className="vignette" />
        <DoodleCanvas hooks={doodleHooks} engineRef={engineRef} />
        {gaze && (
          <div
            className="gaze"
            style={{ left: `${(gaze.x / 1000) * 100}vw`, top: `${(gaze.y / 1000) * 100}vh` }}
          />
        )}
      </div>
      <Companion
        mode={mode}
        questions={questions}
        thread={thread}
        status={status}
        busy={busy}
        mac={mac}
        focusSignal={focusSignal}
        onPick={(q) => window.ojos.accept(q)}
        onAsk={(text) => window.ojos.ask(text)}
        onOpenChat={openChat}
        onDismiss={() => window.ojos.dismiss()}
        onHover={onHover}
      />
      {toast && <ReadyToast text={toast} />}
    </>
  )
}
