import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import { A2uiSurface } from '@a2ui/react/v0_9'
import type { UiDecision } from '../../../shared/commands'
import { assertRenderable, ojosCatalog } from './catalog'

type Surface = Parameters<typeof A2uiSurface>[0]['surface']
const LABEL: Record<string, string> = {
  diagram: 'diagram',
  bug_insight: 'bug insight',
  step_by_step: 'step by step',
  checklist: 'checklist',
  comparison: 'comparison',
  followup: 'follow-up',
  none: 'words only'
}

/** A surface that fails to render (for example a prop of the wrong type) must not take the chat down. */
class Guard extends Component<{ children: ReactNode; onError(): void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: unknown): void {
    console.error('[a2ui] render failed:', error)
    this.props.onError()
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * The generative-UI area under an answer. The agent streams A2UI v0.9 messages; @a2ui/react's
 * MessageProcessor turns them into a surface rendered with the Ojos catalog. User actions go back
 * to the agent as the next turn.
 */
export function A2uiPane(): React.JSX.Element | null {
  const processorRef = useRef<MessageProcessor | null>(null)
  const [surface, setSurface] = useState<Surface | null>(null)
  const [decision, setDecision] = useState<UiDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    const fresh = (): MessageProcessor => {
      processorRef.current?.dispose()
      const p = new MessageProcessor([ojosCatalog], (action) => {
        const a = action as { name?: string; surfaceId?: string; sourceComponentId?: string; context?: Record<string, unknown> }
        window.ojos.a2uiAction({
          name: String(a.name ?? 'action'),
          surfaceId: String(a.surfaceId ?? ''),
          sourceComponentId: String(a.sourceComponentId ?? ''),
          context: a.context ?? {}
        })
      })
      processorRef.current = p
      return p
    }
    fresh()
    const clear = (): void => {
      fresh()
      setSurface(null)
      setDecision(null)
      setError(null)
      setEpoch((n) => n + 1)
    }
    const offs = [
      window.ojos.on('a2ui-decision', (d) => {
        setDecision(d)
        setError(null)
        // A new turn that will draw its own interface replaces the previous one.
        if (d.kind !== 'none') setSurface(null)
      }),
      window.ojos.on('a2ui', (payload) => {
        try {
          assertRenderable(payload.messages)
          const p = fresh() // one surface per turn
          p.processMessages(payload.messages as Parameters<MessageProcessor['processMessages']>[0])
          const made = Array.from(p.model.surfacesMap.values()).at(-1) as Surface | undefined
          if (!made) throw new Error('The agent sent no surface.')
          setSurface(made)
          setEpoch((n) => n + 1)
          setError(null)
        } catch (e) {
          console.error('[a2ui] rejected messages:', e)
          setSurface(null)
          setError('Ojos tried to draw an interface, but it came back malformed.')
        }
      }),
      window.ojos.on('a2ui-error', (message) => setError(message)),
      window.ojos.on('chat-history', clear),
      window.ojos.on('dismiss', clear)
    ]
    return () => {
      offs.forEach((off) => off())
      processorRef.current?.dispose()
      processorRef.current = null
    }
  }, [])

  if (!decision && !surface && !error) return null
  const pct = decision ? Math.round((decision.kind === 'none' ? 1 - decision.worth_it : decision.confidence) * 100) : 0
  const waiting = decision && decision.kind !== 'none' && !surface && !error
  return (
    <div className="a2ui">
      {decision && (
        <div className="a2ui-decision" title={`worth an interface: ${Math.round(decision.worth_it * 100)}%${decision.reason ? ` · ${decision.reason}` : ''}`}>
          ✦ decision model: {LABEL[decision.kind] ?? decision.kind}
          {decision.reason === 'trivial_question' ? ' (simple question)' : decision.reason === 'user_asked' ? ' (you asked for it)' : decision.reason === 'agent_chose_words' ? ' (the agent answered in words)' : decision.kind === 'followup' ? '' : ` ${pct}%`}
        </div>
      )}
      {waiting && <div className="a2ui-wait">Building an interface for this…</div>}
      {error && <div className="a2ui-wait err">{error}</div>}
      {surface && (
        <Guard key={epoch} onError={() => setError('That interface could not be displayed.')}>
          <A2uiSurface surface={surface} />
        </Guard>
      )}
    </div>
  )
}
