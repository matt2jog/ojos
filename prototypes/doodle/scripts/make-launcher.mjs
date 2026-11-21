// Builds the app and creates a double-clickable Ojos.app on the Desktop (macOS).
// The launcher starts the built app through LaunchServices: no terminal, no dev server.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('The launcher script is macOS-only for now. Use `npm start` elsewhere.')
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronApp = join(appDir, 'node_modules/electron/dist/Electron.app')
const target = process.argv[2] ? resolve(process.argv[2]) : join(homedir(), 'Desktop', 'Ojos.app')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
execFileSync('npx', ['electron-vite', 'build'], { cwd: appDir, stdio: 'inherit', env })

// `env -u` matters when launched from an editor terminal that sets ELECTRON_RUN_AS_NODE.
const script = `do shell script "env -u ELECTRON_RUN_AS_NODE open -n -a " & quoted form of ${JSON.stringify(electronApp)} & " --args " & quoted form of ${JSON.stringify(appDir)}`
if (existsSync(target)) rmSync(target, { recursive: true })
execFileSync('osacompile', ['-o', target, '-e', script])
// Give the launcher the Ojos icon, then nudge Finder to refresh it.
const icon = join(appDir, 'resources', 'icon.icns')
if (existsSync(icon)) {
  copyFileSync(icon, join(target, 'Contents/Resources/applet.icns'))
  execFileSync('touch', [target])
}
console.log(`Created ${target}. Double-click it to start Ojos.`)
