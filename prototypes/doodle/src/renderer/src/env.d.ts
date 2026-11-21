import type { OjosApi } from '../../shared/commands'

declare global {
  interface Window {
    ojos: OjosApi
  }
}
