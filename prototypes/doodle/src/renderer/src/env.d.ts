import type { OjosApi } from '../../shared/commands'
import type { SetupApi } from '../../shared/setup'
import type { VisionApi } from '../../shared/vision'

declare global {
  interface Window {
    ojos: OjosApi
    setup: SetupApi
    vision: VisionApi
  }
}
