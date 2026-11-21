import { useCallback, useEffect, useRef, useState } from 'react'
import { Companion, type TurnView } from './components/Companion'
import { DoodleCanvas } from './components/DoodleCanvas'
import { ReadyToast } from './components/ReadyToast'
import type { DoodleEngine, EngineHooks } from './doodle/engine'
import type { SavedChat } from '../../shared/commands'

type Status = { kind: 'idle' | 'thinking' | 'error'; text?: string }
type Mode = 'hidden' | 'nudge' | 'chat' | 'library'

const editLast = (thread: TurnView[], edit: (t: TurnView) => TurnView): TurnView[] =>
  thread.length ? [...thread.slice(0, -1), edit(thread[thread.length - 1])] : thread
const doodleHooks: EngineHooks = { title: () => {}, say: async () => {} }

export function App(): React.JSX.Element {
  const engineRef = useRef<DoodleEngine | null>(null)
  const [mode, setMode] = useState<Mode>('hidden')
  const [thread, setThread] = useState<TurnView[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [forkOffer, setForkOffer] = useState(false)
  const [savedChats, setSavedChats] = useState<SavedChat[] | null>(null)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [openingChat, setOpeningChat] = useState<string | null>(null)
  const [activeChat, setActiveChat] = useState<SavedChat | null>(null)
  const [chatKey, setChatKey] = useState(0)
  const [olderBefore, setOlderBefore] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [offerSimpler, setOfferSimpler] = useState(false)
  const [gaze, setGaze] = useState<{ x: number; y: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [questions, setQuestions] = useState<string[] | null>(null)
  const [mac, setMac] = useState(true)
  const [focusSignal, setFocusSignal] = useState(0)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waitingForSuggestions = useRef(false)
  const modeRef = useRef<Mode>('hidden')
  modeRef.current = mode
  const libraryVersion = useRef(0)
  const transcriptVersion = useRef(0)
  const setOverUi = useCallback((over: boolean) => window.ojos.setOverPanel(over), [])

  const keepChat = useCallback(() => {
    waitingForSuggestions.current = false
    setForkOffer(false)
    setQuestions(null)
    window.ojos.declineSuggestion()
  }, [])

  const openChat = useCallback(() => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    ++libraryVersion.current
    setOpeningChat(null)
    window.ojos.setChatListOpen(false)
    setMode('chat')
    setFocusSignal((n) => n + 1)
  }, [])

  const openLibrary = useCallback(() => {
    waitingForSuggestions.current = false
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    setForkOffer(false)
    setQuestions(null)
    setOpeningChat(null)
    setSavedChats(null)
    setLibraryError(null)
    setMode('library')
    window.ojos.setFocus(false)
    window.ojos.setChatListOpen(true)
    const revision = ++libraryVersion.current
    void window.ojos.listChats().then((chats) => {
      if (libraryVersion.current === revision) setSavedChats(chats)
    }).catch(() => {
      if (libraryVersion.current === revision) setLibraryError('Could not load your saved chats.')
    })
  }, [])

  const loadEarlier = async (): Promise<void> => {
    if (olderBefore === null || loadingOlder || !activeChat) return
    const revision = transcriptVersion.current
    setLoadingOlder(true)
    try {
      const page = await window.ojos.olderChatTurns(olderBefore)
      if (transcriptVersion.current !== revision || page.chat?.id !== activeChat.id) return
      setThread((turns) => [...page.turns.map(({ question, answer }) =>
        ({ question, title: question, says: [answer], answered: true })), ...turns])
      setOlderBefore(page.older_before_seq)
    } catch {
      if (transcriptVersion.current === revision) setStatus({ kind: 'error', text: 'Could not load earlier messages.' })
    } finally {
      if (transcriptVersion.current === revision) setLoadingOlder(false)
    }
  }

  const dismissLocal = useCallback(() => {
    waitingForSuggestions.current = false
    engineRef.current?.cancel()
    setMode('hidden')
    setBusy(false)
    setOfferSimpler(false)
    setForkOffer(false)
    setGaze(null)
    ++transcriptVersion.current
    ++libraryVersion.current
    setThread([])
    setActiveChat(null)
    setChatKey((key) => key + 1)
    setOlderBefore(null)
    setLoadingOlder(false)
    setOpeningChat(null)
    setQuestions(null)
    setStatus({ kind: 'idle' })
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    fadeTimer.current = setTimeout(() => {
      engineRef.current?.reset()
    }, 400) // after the CSS fade
  }, [])

  useEffect(() => {
    const offs = [
      window.ojos.on('ready', (msg) => {
        const [label, mod] = msg.split('|')
        setMac(mod === 'Cmd')
        setToast(`Ojos is running (${label}). Press ${mod === 'Cmd' ? '⌘⇧O' : 'Ctrl+Shift+O'} for help with your recent screen activity.`)
      }),
      window.ojos.on('nudge', () => {
        // Might just be thinking: offer help, never force it.
        if (modeRef.current === 'library') return
        waitingForSuggestions.current = true
        if (fadeTimer.current) clearTimeout(fadeTimer.current)
        setQuestions(null)
        if (modeRef.current === 'chat') {
          setForkOffer(true)
          return
        }
        setThread([])
        setStatus({ kind: 'idle' })
        setMode('nudge')
      }),
      window.ojos.on('suggest', (sug) => {
        if (!waitingForSuggestions.current) return
        waitingForSuggestions.current = false
        setQuestions(sug.questions)
      }),
      window.ojos.on('chat', openChat),
      window.ojos.on('chat-list', openLibrary),
      window.ojos.on('chat-list-error', (text) => {
        setOpeningChat(null)
        setLibraryError(text)
      }),
      window.ojos.on('chat-help', () => setOfferSimpler(true)),
      window.ojos.on('chat-meta', (chat) => {
        setActiveChat(chat)
        setSavedChats((saved) => saved && [chat, ...saved.filter((item) => item.id !== chat.id)])
      }),
      window.ojos.on('chat-history', ({ chat, turns, older_before_seq }) => {
        waitingForSuggestions.current = false
        ++transcriptVersion.current
        setChatKey((key) => key + 1)
        setThread(turns.map(({ question, answer }) => ({ question, title: question, says: [answer], answered: true })))
        setActiveChat(chat)
        setOlderBefore(older_before_seq)
        setLoadingOlder(false)
        setForkOffer(false)
        setOfferSimpler(false)
        setQuestions([])
        setStatus({ kind: 'idle' })
        setGaze(null)
      }),
      window.ojos.on('reset', ({ gaze, question, fresh }) => {
        waitingForSuggestions.current = false
        if (fadeTimer.current) clearTimeout(fadeTimer.current)
        engineRef.current?.reset()
        if (fresh) {
          ++transcriptVersion.current
          setChatKey((key) => key + 1)
          setActiveChat(null)
          setOlderBefore(null)
          setLoadingOlder(false)
        }
        setThread((prev) => [...(fresh ? [] : prev), { question, title: question ?? '', says: [] }])
        setQuestions(null)
        setForkOffer(false)
        setGaze(gaze ?? null)
        setStatus({ kind: 'thinking' })
        setOfferSimpler(false)
        setBusy(true)
        setMode('chat')
      }),
      window.ojos.on('chat-status', (text) => setStatus({ kind: 'thinking', text })),
      window.ojos.on('chat-delta', (text) => {
        setStatus({ kind: 'idle' })
        setThread((prev) => editLast(prev, (turn) => ({ ...turn, says: [(turn.says[0] ?? '') + text] })))
      }),
      window.ojos.on('chat-answer', (text) => {
        setThread((prev) => editLast(prev, (turn) => ({ ...turn, says: [text], answered: true })))
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
  }, [dismissLocal, openChat, openLibrary])

  return (
    <>
      <div className={`stage ${mode === 'chat' ? 'on' : ''} ${busy ? 'busy' : ''}`}>
        <div className="vignette" />
        <DoodleCanvas hooks={doodleHooks} engineRef={engineRef} />
      </div>
      <Companion
        mode={mode}
        questions={questions}
        thread={thread}
        status={status}
        busy={busy}
        forkOffer={forkOffer}
        savedChats={savedChats}
        libraryError={libraryError}
        openingChat={openingChat}
        activeChat={activeChat}
        chatKey={chatKey}
        olderBefore={olderBefore}
        loadingOlder={loadingOlder}
        offerSimpler={offerSimpler}
        mac={mac}
        focusSignal={focusSignal}
        onPick={(q) => window.ojos.accept(q)}
        onAsk={(text) => window.ojos.ask(text)}
        onOpenChat={openChat}
        onKeepChat={keepChat}
        onOpenLibrary={openLibrary}
        onOpenSavedChat={(id) => {
          setOpeningChat(id)
          setLibraryError(null)
          window.ojos.openSavedChat(id)
        }}
        onNewChat={() => window.ojos.newChat()}
        onLoadEarlier={() => void loadEarlier()}
        onDismiss={() => window.ojos.dismiss()}
        onSimplify={() => {
          setOfferSimpler(false)
          window.ojos.ask('Can you explain your last answer in a different way?')
        }}
        onHover={setOverUi}
      />
      {toast && <ReadyToast text={toast} />}
    </>
  )
}
