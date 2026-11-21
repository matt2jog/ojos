// Dev-only page (a2ui-test.html): renders a sample A2UI surface with the Ojos catalog so the
// components and their actions can be exercised without the backend. Used by scripts/a2ui-smoke.cjs.
import { createRoot } from 'react-dom/client'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import { A2uiSurface } from '@a2ui/react/v0_9'
import { assertRenderable, ojosCatalog, OJOS_CATALOG_ID } from './catalog'
import '../styles.css'

const w = window as unknown as { __actions: unknown[]; __rejected: Record<string, string>; __ready: boolean; __errors: string[] }
w.__errors = []
addEventListener('error', (e) => void w.__errors.push(String(e.error?.stack ?? e.message).slice(0, 900)))
w.__actions = []
w.__rejected = {}
const sid = 'smoke'
const processor = new MessageProcessor([ojosCatalog], (a) => void w.__actions.push(JSON.parse(JSON.stringify(a))))
processor.processMessages([
  { version: 'v0.9', createSurface: { surfaceId: sid, catalogId: OJOS_CATALOG_ID } },
  { version: 'v0.9', updateComponents: { surfaceId: sid, components: [
    { id: 'root', component: 'Stack', children: ['bug', 'guide', 'list', 'cmp', 'next'] },
    { id: 'bug', component: 'BugInsight', title: { path: '/bug/title' }, severity: 'error', location: 'app.py:14',
      explanation: 'get_user() returns None when no row matches.', code: "name = user['name']",
      fixes: [{ label: 'Guard against None', detail: 'Return early.', code: 'if user is None:\n    return not_found()',
        action: { event: { name: 'apply_fix', context: { label: 'Guard against None' } } } }], children: ['note'] },
    { id: 'note', component: 'Note', text: 'Nested inside the bug card', tone: 'info' },
    { id: 'guide', component: 'StepByStepGuide', title: 'Apply the fix', steps: [
      { title: 'Open app.py', detail: 'Go to line 14.' }, { title: 'Add the guard', detail: 'Insert the check.', code: 'if user is None:' }],
      onDone: { event: { name: 'guide_done', context: { label: 'Finished the guide' } } } },
    { id: 'list', component: 'ActionChecklist', title: 'Before you commit', items: [{ label: 'Run tests' }, { label: 'Add a test', detail: 'for missing users' }],
      progress: { path: '/checklist/done' }, onSubmit: { event: { name: 'checklist_help', context: { label: 'Checklist help', done: { path: '/checklist/done' } } } } },
    { id: 'cmp', component: 'ComparisonCard', title: 'Two ways to handle it', options: [
      { name: 'Guard', summary: 'Check first.', pros: ['simple'], recommended: true, action: { event: { name: 'choose_option', context: { label: 'Guard' } } } },
      { name: 'Raise', cons: ['noisy'] }] },
    { id: 'next', component: 'ActionButton', label: 'How do I test this?', action: { event: { name: 'explain_testing', context: { label: 'How to test' } } } }
  ] } },
  { version: 'v0.9', updateDataModel: { surfaceId: sid, path: '/', value: { bug: { title: 'user is None on line 14' }, checklist: { done: '' } } } }
] as never)

for (const [name, bad] of Object.entries({
  unknown_component: [{ version: 'v0.9', createSurface: { surfaceId: 'b1', catalogId: OJOS_CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId: 'b1', components: [{ id: 'root', component: 'Nope' }] } }],
  unknown_catalog: [{ version: 'v0.9', createSurface: { surfaceId: 'b2', catalogId: 'https://example.com/other.json' } }],
  not_a_message: [{ hello: 'world' }],
  missing_child: [{ version: 'v0.9', createSurface: { surfaceId: 'b3', catalogId: OJOS_CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId: 'b3', components: [{ id: 'root', component: 'Stack', children: ['ghost'] }] } }]
})) {
  try {
    // Same two gates the app uses: our structural check, then the A2UI processor.
    if (name === 'unknown_component' || name === 'missing_child') assertRenderable(bad)
    new MessageProcessor([ojosCatalog]).processMessages(bad as never)
    w.__rejected[name] = 'NOT REJECTED'
  } catch (e) {
    w.__rejected[name] = String((e as Error).message).slice(0, 100)
  }
}

const surface = Array.from(processor.model.surfacesMap.values())[0]
createRoot(document.getElementById('root')!).render(<A2uiSurface surface={surface as never} />)
setTimeout(() => (w.__ready = true), 600)

// Lets the smoke script render any recorded agent payload through the same two gates as the app.
;(window as unknown as { __render: (messages: unknown[]) => Promise<string> }).__render = async (messages) => {
  assertRenderable(messages)
  const p = new MessageProcessor([ojosCatalog], (a) => void w.__actions.push(JSON.parse(JSON.stringify(a))))
  p.processMessages(messages as never)
  const host = document.createElement('div')
  host.className = 'live'
  document.body.appendChild(host)
  createRoot(host).render(<A2uiSurface surface={Array.from(p.model.surfacesMap.values())[0] as never} />)
  await new Promise((r) => setTimeout(r, 500))
  return host.innerText
}
