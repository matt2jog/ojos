import type { OjosApi } from '../../shared/commands'
import type { SetupApi } from '../../shared/setup'

declare global {
  interface Window {
    ojos: OjosApi
    setup: SetupApi
  }
}
