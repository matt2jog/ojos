import { desktopCapturer, systemPreferences, type DesktopCapturerSource, type Display } from 'electron'

export interface RecordingPlatform {
  loopback: boolean
  source(display: Display): Promise<DesktopCapturerSource>
  screenAllowed(): boolean
  cameraRevoked(): boolean
}

async function selectedSource(display: Display): Promise<DesktopCapturerSource> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const source = sources.find((item) => item.display_id === String(display.id))
  if (!source) throw new Error('The selected display is no longer available for capture.')
  return source
}

const cameraRevoked = (): boolean => ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('camera'))

export function recordingPlatform(): RecordingPlatform {
  switch (process.platform) {
    case 'darwin': {
      const [major, minor] = process.getSystemVersion().split('.').map(Number)
      return {
        loopback: major > 14 || (major === 14 && minor >= 2),
        source: selectedSource,
        screenAllowed: () => systemPreferences.getMediaAccessStatus('screen') === 'granted',
        cameraRevoked
      }
    }
    case 'win32':
      return { loopback: true, source: selectedSource, screenAllowed: () => true, cameraRevoked }
    default:
      throw new Error(`Recording is unavailable on ${process.platform}.`)
  }
}
