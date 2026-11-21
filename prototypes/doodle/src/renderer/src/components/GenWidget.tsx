import { useEffect, useState } from 'react'
import type { WidgetEvent } from '../../../shared/commands'

/**
 * Generated visual for the current answer. Gemini's decision model picks none, diagram, steps,
 * comparison or interactive; the generated HTML is shown in a sandboxed frame (scripts only, no
 * access to the app, no network via CSP).
 */
const LABEL: Record<string, string> = { diagram: 'Diagram', steps: 'Step by step', comparison: 'Comparison', interactive: 'Try it' }

export function GenWidget(): React.JSX.Element | null {
  const [w, setW] = useState<WidgetEvent | null>(null)

  useEffect(() => {
    const offs = [
      window.ojos.on('widget', setW),
      window.ojos.on('chat-history', () => setW(null)),
      window.ojos.on('reset', () => setW(null)),
      window.ojos.on('dismiss', () => setW(null))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  if (!w) return null
  const pct = Math.round(w.confidence * 100)
  const tip = Object.entries(w.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
    .join(' · ')
  // The decision model said no visual is needed: show that it was considered, nothing more.
  if (w.state === 'text') {
    return (
      <div className="gen-decision" title={tip}>
        ✦ decision model: text is enough ({pct}%)
      </div>
    )
  }
  return (
    <div className="gen-widget">
      <div className="gen-widget-head">
        <span>✦ {LABEL[w.kind] ?? 'Visual'}</span>
        <span title={tip}>decision model: {w.kind} {pct}%</span>
      </div>
      {w.state === 'drawing' && <div className="gen-widget-loading">Drawing it for you…</div>}
      {w.state === 'error' && <div className="gen-widget-loading">Couldn’t draw this one.</div>}
      {w.state === 'ready' && w.html && (
        <iframe
          title="Generated visual"
          sandbox="allow-scripts"
          srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"><style>html{background:#1b1c20;color:#ececec;color-scheme:dark}body{margin:0;padding:10px;font:13px system-ui,sans-serif}</style>${w.html}`}
        />
      )}
    </div>
  )
}
