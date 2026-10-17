import { useCallback } from 'react'
import type { KeyName } from '../../../shared-ipc'
import type { ShortcutAction } from './shortcuts'

const KEY_ACTIONS: Partial<Record<ShortcutAction, KeyName>> = {
  home: 'home',
  back: 'back',
  recents: 'recents',
  'volume-up': 'volume_up',
  'volume-down': 'volume_down',
  power: 'power'
}

/** Runs a phone action (shortcut or toolbar) on `serial`. */
export function usePhoneActions(serial: string | null, onToggleScreen: () => void) {
  return useCallback(
    (action: ShortcutAction) => {
      if (!serial) return
      const key = KEY_ACTIONS[action]
      if (key) {
        window.mirror.sendInput(serial, { type: 'key', key, down: true, modifiers: 0 })
        window.mirror.sendInput(serial, { type: 'key', key, down: false, modifiers: 0 })
      } else if (action === 'notifications') {
        window.mirror.systemAction(serial, 'notifications')
      } else if (action === 'quick-settings') {
        window.mirror.systemAction(serial, 'quick-settings')
      } else if (action === 'screen-power') {
        onToggleScreen()
      }
    },
    [serial, onToggleScreen]
  )
}
