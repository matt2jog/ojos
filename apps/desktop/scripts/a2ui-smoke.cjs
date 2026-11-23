// Runs the Ojos A2UI catalog in a real Electron window and exercises it: renders a sample surface,
// clicks through the components, and checks the A2UI actions that come out.
// Usage (dev server running): electron scripts/a2ui-smoke.cjs [http://localhost:5173] [screenshot.png]
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const base = process.argv[2] || 'http://localhost:5173'
const shot = process.argv[3]
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 420, height: 1500, webPreferences: { offscreen: false } })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) })
  await win.loadURL(`${base}/a2ui-test.html`)
  const js = (code) => win.webContents.executeJavaScript(code, true)
  for (let i = 0; i < 50 && !(await js('window.__ready === true')); i++) await new Promise((r) => setTimeout(r, 200))
  const out = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const byText = (t, sel = 'button') => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === t)
    const has = (t) => document.body.innerText.includes(t)
    const r = { checks: {} }
    r.checks.dataBoundTitle = has('user is None on line 14')
    r.checks.nestedChild = has('Nested inside the bug card')
    r.checks.allFourCards = ['.a2-bug', '.a2-steps', '.a2-check', '.a2-compare'].every((s) => document.querySelector(s))
    // BugInsight: the first fix is open; press its action
    byText('Walk me through this fix')?.click(); await wait(150)
    r.checks.fixButtonLocks = Boolean(byText('Asked Ojos…'))
    // StepByStepGuide: Next shows step 2, then Done fires onDone
    r.checks.step1 = has('Open app.py')
    byText('Next')?.click(); await wait(150)
    r.checks.step2AfterNext = has('Add the guard') && !has('Go to line 14.')
    byText('Done')?.click(); await wait(150)
    // ActionChecklist: tick one item (two-way bound to /checklist/done), then submit
    document.querySelector('.a2-check input')?.click(); await wait(150)
    r.checks.checklistCount = has('1 of 2 done')
    byText('Help with what’s left')?.click(); await wait(150)
    // ComparisonCard and ActionButton
    byText('Go with this')?.click(); await wait(150)
    r.checks.optionPicked = Boolean(byText('Chosen ✓'))
    byText('How do I test this?')?.click(); await wait(200)
    r.actions = window.__actions
    r.rejected = window.__rejected
    r.errors = window.__errors
    return r
  })()`)
  if (shot) writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
  const names = out.actions.map((a) => a.name)
  const checklist = out.actions.find((a) => a.name === 'checklist_help')
  out.checks.actionsInOrder = JSON.stringify(names) === JSON.stringify(['apply_fix', 'guide_done', 'checklist_help', 'choose_option', 'explain_testing'])
  out.checks.checklistProgressReachedAction = checklist?.context?.done === 'Run tests'
  out.checks.malformedRejected = Object.values(out.rejected).every((v) => v !== 'NOT REJECTED')
  console.log(JSON.stringify({ checks: out.checks, actionNames: names, checklistContext: checklist?.context, rejected: out.rejected, pageErrors: [...(out.errors || []), ...errors].slice(0, 4) }, null, 1))
  const failed = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k)
  console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'ALL CHECKS PASSED')
  app.exit(failed.length ? 1 : 0)
})
