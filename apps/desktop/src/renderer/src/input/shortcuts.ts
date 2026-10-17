// Phone shortcuts: user-rebindable key combos that act on the phone while its
// screen has focus. Stored in localStorage (shared by all windows).

import { useEffect, useState } from 'react'

export type ShortcutAction =
  | 'home'
  | 'back'
  | 'recents'
  | 'notifications'
  | 'quick-settings'
  | 'volume-up'
  | 'volume-down'
  | 'power'
  | 'screen-power'

export interface KeyCombo {
  /** KeyboardEvent.code, the physical key. */
  code: string
  alt: boolean
  shift: boolean
  ctrl: boolean
  meta: boolean
}

export type Shortcuts = Record<ShortcutAction, KeyCombo | null>

/** Translation keys of each action's name. */
export const ACTION_LABELS: Record<ShortcutAction, string> = {
  home: 'shortcuts.action.home',
  back: 'shortcuts.action.back',
  recents: 'shortcuts.action.recents',
  notifications: 'shortcuts.action.notifications',
  'quick-settings': 'shortcuts.action.quickSettings',
  'volume-up': 'shortcuts.action.volumeUp',
  'volume-down': 'shortcuts.action.volumeDown',
  power: 'shortcuts.action.power',
  'screen-power': 'shortcuts.action.screenPower'
}

const alt = (code: string, shift = false): KeyCombo => ({ code, alt: true, shift, ctrl: false, meta: false })

export const DEFAULT_SHORTCUTS: Shortcuts = {
  home: alt('KeyH'),
  back: alt('KeyB'),
  recents: alt('KeyS'),
  notifications: alt('KeyN'),
  'quick-settings': alt('KeyN', true),
  'volume-up': alt('ArrowUp'),
  'volume-down': alt('ArrowDown'),
  power: alt('KeyP'),
  'screen-power': alt('KeyO')
}

const STORAGE_KEY = 'mirror.shortcuts'

export function loadShortcuts(): Shortcuts {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Shortcuts> | null
    return { ...DEFAULT_SHORTCUTS, ...saved }
  } catch {
    return DEFAULT_SHORTCUTS
  }
}

export function saveShortcuts(shortcuts: Shortcuts): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts))
  } catch {
    // Not persisted; applies until the window closes.
  }
}

/** Current shortcuts, updated when another window changes them. */
export function useShortcuts(): Shortcuts {
  const [shortcuts, setShortcuts] = useState(loadShortcuts)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === STORAGE_KEY && setShortcuts(loadShortcuts())
    const onLocal = () => setShortcuts(loadShortcuts())
    window.addEventListener('storage', onStorage)
    window.addEventListener('mirror-shortcuts-changed', onLocal)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('mirror-shortcuts-changed', onLocal)
    }
  }, [])
  return shortcuts
}

export const comboFromEvent = (e: KeyboardEvent): KeyCombo => ({
  code: e.code,
  alt: e.altKey,
  shift: e.shiftKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey
})

const sameCombo = (a: KeyCombo, b: KeyCombo) =>
  a.code === b.code && a.alt === b.alt && a.shift === b.shift && a.ctrl === b.ctrl && a.meta === b.meta

export function matchShortcut(shortcuts: Shortcuts, e: KeyboardEvent): ShortcutAction | null {
  const combo = comboFromEvent(e)
  for (const [action, bound] of Object.entries(shortcuts) as [ShortcutAction, KeyCombo | null][]) {
    if (bound && sameCombo(bound, combo)) return action
  }
  return null
}

/** Keys alone don't make a shortcut; a modifier keeps typing intact. */
export const isUsableCombo = (c: KeyCombo) =>
  (c.alt || c.ctrl || c.meta) && !['Alt', 'Shift', 'Control', 'Meta'].some((m) => c.code.startsWith(m))

const isMac = navigator.platform.toLowerCase().includes('mac')

export function formatCombo(c: KeyCombo | null): string[] {
  if (!c) return []
  const keyName = c.code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→')
  const parts: string[] = []
  if (c.ctrl) parts.push(isMac ? '⌃' : 'Ctrl')
  if (c.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (c.shift) parts.push(isMac ? '⇧' : 'Shift')
  if (c.meta) parts.push(isMac ? '⌘' : 'Win')
  parts.push(keyName)
  return parts
}
