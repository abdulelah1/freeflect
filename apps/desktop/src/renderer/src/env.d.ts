import type { MirrorApi } from '../../shared-ipc'

declare global {
  interface Window {
    mirror: MirrorApi
  }
}
