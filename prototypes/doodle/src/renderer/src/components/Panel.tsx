interface Props {
  model: string
  title: string
  says: string[]
  status: { kind: 'idle' | 'thinking' | 'error'; text?: string }
  onGotIt(): void
  onHover(over: boolean): void
}

export function Panel({ model, title, says, status, onGotIt, onHover }: Props): React.JSX.Element {
  return (
    <div className="panel" onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <div className="panel-brand">
        <span>👀 Ojos</span>
        <span>{model}</span>
      </div>
      <div className="panel-title">{title}</div>
      <div className="panel-says">
        {says.map((s, i) => (
          <p key={i}>{s}</p>
        ))}
      </div>
      <div className={`panel-status ${status.kind === 'error' ? 'err' : ''}`}>
        {status.kind === 'thinking' && (
          <>
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </>
        )}
        {status.kind === 'error' && `Error: ${status.text}`}
      </div>
      <button className="panel-got" onClick={onGotIt}>
        Got it 👍
      </button>
    </div>
  )
}
