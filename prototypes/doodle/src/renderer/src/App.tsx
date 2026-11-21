import { useCallback, useEffect, useRef, useState } from 'react'
import { DoodleCanvas } from './components/DoodleCanvas'
import { Panel } from './components/Panel'
import { ReadyToast } from './components/ReadyToast'
import type { DoodleEngine, EngineHooks } from './doodle/engine'

type Status = { kind: 'idle' | 'thinking' | 'error'; text?: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function App(): React.JSX.Element {
  const engineRef = useRef<DoodleEngine | null>(null)
  const [visible, setVisible] = useState(false)
  const [model, setModel] = useState('')
  const [title, setTitle] = useState('')
  const [says, setSays] = useState<string[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [gaze, setGaze] = useState<{ x: number; y: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearText = (): void => {
    setTitle('')
    setSays([])
    setStatus({ kind: 'idle' })
  }

  // Called by the engine, in order with the drawings, so text and doodles stay in sync.
  const hooks: EngineHooks = {
    title: (t) => setTitle(t),
    say: async (text, isCurrent) => {
      setSays((prev) => [...prev, ''])
      for (let i = 1; i <= text.length; i++) {
        if (!isCurrent()) return
        const partial = text.slice(0, i)
        setSays((prev) => [...prev.slice(0, -1), partial])
        await sleep(14)
      }
    }
  }

  const dismissLocal = useCallback(() => {
    engineRef.current?.cancel()
    setVisible(false)
    setGaze(null)
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    fadeTimer.current = setTimeout(() => {
      engineRef.current?.reset()
      clearText()
    }, 400) // after the CSS fade
  }, [])

  useEffect(() => {
    const offs = [
      window.ojos.on('ready', (msg) => {
        const [mode, mod] = msg.split('|')
        setToast(`👀 Ojos is running (${mode}). Point at something, then press ${mod === 'Cmd' ? '⌘⇧O' : 'Ctrl+Shift+O'}`)
      }),
      window.ojos.on('reset', ({ gaze, model }) => {
        if (fadeTimer.current) clearTimeout(fadeTimer.current)
        engineRef.current?.reset()
        clearText()
        setModel(model)
        setGaze(gaze)
        setStatus({ kind: 'thinking' })
        setVisible(true)
      }),
      window.ojos.on('cmd', (cmd) => {
        setStatus((s) => (s.kind === 'thinking' ? { kind: 'idle' } : s))
        engineRef.current?.push(cmd)
      }),
      window.ojos.on('error', (text) => setStatus({ kind: 'error', text })),
      window.ojos.on('done', () => {}),
      window.ojos.on('dismiss', dismissLocal)
    ]
    return () => offs.forEach((off) => off())
  }, [dismissLocal])

  return (
    <>
      <div className={`stage ${visible ? 'on' : ''}`}>
        <div className="vignette" />
        <DoodleCanvas hooks={hooks} engineRef={engineRef} />
        {gaze && (
          <div
            className="gaze"
            style={{ left: `${(gaze.x / 1000) * 100}vw`, top: `${(gaze.y / 1000) * 100}vh` }}
          />
        )}
        <Panel
          model={model}
          title={title}
          says={says}
          status={status}
          onGotIt={() => window.ojos.dismiss()}
          onHover={(over) => window.ojos.setOverPanel(over)}
        />
      </div>
      {toast && <ReadyToast text={toast} />}
    </>
  )
}
