// When Ojos is launched as an app (no terminal), keep a log file so failures are diagnosable.
import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { format } from 'util'

const home = app.getPath('home')
const dir = process.platform === 'darwin' ? join(home, 'Library', 'Logs', 'Ojos') : join(app.getPath('userData'), 'logs')
export const LOG_FILE = join(dir, 'ojos.log')

try {
  mkdirSync(dir, { recursive: true })
  try {
    if (statSync(LOG_FILE).size > 2_000_000) writeFileSync(LOG_FILE, '')
  } catch {
    /* no log yet */
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      try {
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`)
      } catch {
        /* logging must never break the app */
      }
    }
  }
  console.log(`--- Ojos start pid ${process.pid} args ${process.argv.slice(1).join(' ')}`)
} catch {
  /* ignore */
}
