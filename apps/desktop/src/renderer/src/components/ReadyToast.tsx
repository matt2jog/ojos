import { useEffect, useState } from 'react'

export function ReadyToast({ text }: { text: string }): React.JSX.Element | null {
  const [phase, setPhase] = useState<'in' | 'out' | 'gone'>('in')

  useEffect(() => {
    setPhase('in')
    const t1 = setTimeout(() => setPhase('out'), 5000)
    const t2 = setTimeout(() => setPhase('gone'), 5600)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [text])

  if (phase === 'gone') return null
  return <div className={`toast ${phase === 'out' ? 'toast-out' : ''}`}>{text}</div>
}
