import { app } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

export const project = (): string => app.isPackaged ? join(process.resourcesPath, 'ojos') : resolve(app.getAppPath(), '../..')
const runtime = (): string => process.env.OJOS_RUNTIME_DIR ?? join(project(), 'runtime')

export function configureRuntime(): void {
  const env = app.isPackaged ? join(app.getPath('userData'), '.env') : join(project(), '.env')
  if (existsSync(env)) loadEnvFile(env)
  process.env.PATH = [join(runtime(), 'bin'), process.env.PATH].filter(Boolean).join(delimiter)
}

export function python(lane: 'confusion' | 'model2' | 'assistant'): string {
  const override = process.env[`OJOS_${lane.toUpperCase()}_PYTHON`] ?? process.env.OJOS_PYTHON
  const executable = process.platform === 'win32' ? join('python', 'python.exe') : join('python', 'bin', 'python3')
  const bundled = join(runtime(), executable)
  return override ?? (existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3')
}

export function assets(): string {
  const bundled = join(runtime(), 'model-assets')
  const local = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Ojos', 'model-assets')
    : join(homedir(), 'Library', 'Application Support', 'Ojos', 'model-assets')
  return process.env.OJOS_MODEL_ASSETS ?? (existsSync(bundled) ? bundled : local)
}
