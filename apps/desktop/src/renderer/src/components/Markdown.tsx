import { Fragment, type ReactNode } from 'react'

/**
 * Small, safe Markdown renderer for the mascot's answers. It builds React nodes directly (no
 * HTML injection) and is tolerant of half-written Markdown, since answers stream in: an unclosed
 * marker is dropped rather than shown, so the user never sees stray asterisks, hashes or backticks.
 */

const INLINE =
  /(`+)([^`\n]+?)\1|\*\*\*([^*\n]+?)\*\*\*|\*\*([^\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*\s][^*\n]*?)\*|(?<![A-Za-z0-9_])_([^_\s][^_\n]*?)_(?![A-Za-z0-9_])/g

/** Markers left over once every complete pair has been rendered: remove them. */
function tidy(text: string): string {
  return text
    .replace(/\*{2,}|_{2,}|~{2,}|`+/g, '')
    .replace(/(^|\s)\*(?=\S)/g, '$1') // an opening * with no close yet
    .replace(/(\S)\*(?=\s|$)/g, '$1')
}

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(tidy(text.slice(last, at)))
    const k = `${key}-${n++}`
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>)
    else if (m[3] !== undefined) out.push(<strong key={k}><em>{inline(m[3], k)}</em></strong>)
    else if (m[4] !== undefined) out.push(<strong key={k}>{inline(m[4], k)}</strong>)
    else if (m[5] !== undefined) out.push(<strong key={k}>{inline(m[5], k)}</strong>)
    else if (m[6] !== undefined) out.push(<s key={k}>{inline(m[6], k)}</s>)
    else if (m[7] !== undefined) out.push(<span key={k} className="md-link" title={m[8]}>{inline(m[7], k)}</span>)
    else if (m[9] !== undefined) out.push(<em key={k}>{inline(m[9], k)}</em>)
    else if (m[10] !== undefined) out.push(<em key={k}>{inline(m[10], k)}</em>)
    last = at + m[0].length
  }
  if (last < text.length) out.push(tidy(text.slice(last)))
  return out
}

const BULLET = /^\s*[-*+•]\s+(.*)$/
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s*(.*?)\s*#*\s*$/
const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    const key = `b${k++}`
    if (!line.trim()) {
      i++
      continue
    }
    // fenced code (an unclosed fence while streaming still renders as code)
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      blocks.push(<pre key={key}><code>{body.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(HEADING)
    if (heading && line.trim().startsWith('#')) {
      if (heading[2]) blocks.push(<p key={key} className="md-h">{inline(heading[2], key)}</p>)
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />)
      i++
      continue
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line) && !BULLET.test(line)
      const test = ordered ? NUMBERED : BULLET
      const items: string[] = []
      while (i < lines.length && (test.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(test)
        if (m) items.push(ordered ? m[2] : m[1])
        else items[items.length - 1] += ' ' + lines[i].trim().replace(/^[-*+•]\s+/, '')
        i++
        while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && test.test(lines[i + 1])) i++
      }
      const lis = items.map((item, j) => <li key={j}>{inline(item, `${key}-${j}`)}</li>)
      blocks.push(ordered ? <ol key={key}>{lis}</ol> : <ul key={key}>{lis}</ul>)
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push(<blockquote key={key}>{inline(quote.join(' '), key)}</blockquote>)
      continue
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      blocks.push(
        <div key={key} className="md-table">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${key}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, a) => <tr key={a}>{r.map((c, j) => <td key={j}>{inline(c, `${key}-${a}-${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
      continue
    }
    // paragraph: consecutive plain lines
    const para: string[] = []
    while (
      i < lines.length && lines[i].trim() && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i]) &&
      !/^\s*(```|~~~|>)/.test(lines[i]) && !(lines[i].trim().startsWith('#') && HEADING.test(lines[i]))
    ) para.push(lines[i++].trim())
    blocks.push(
      <p key={key}>
        {para.map((l, j) => <Fragment key={j}>{j > 0 && ' '}{inline(l, `${key}-${j}`)}</Fragment>)}
      </p>
    )
  }
  return <div className="md">{blocks}</div>
}
