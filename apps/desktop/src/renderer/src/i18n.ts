import { useSyncExternalStore } from 'react'
import { createTranslator, type Translate } from '../../i18n'
import type { LanguageState } from '../../shared-ipc'

let state = { ...window.mirror.initialLanguage, t: createTranslator(window.mirror.initialLanguage.code) }
const listeners = new Set<() => void>()

function apply(l: LanguageState): void {
  state = { ...l, t: createTranslator(l.code) }
  document.documentElement.lang = l.code
  document.documentElement.dir = l.dir
  for (const cb of listeners) cb()
}
apply(state)
window.mirror.onLanguageChanged(apply)

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Translates in the current language, outside React (toasts, helpers). */
export const t: Translate = (key, vars) => state.t(key, vars)
/** The current language code, for Intl formatting. */
export const lang = () => state.code

/** Re-renders the component when the language changes; returns the translator. */
export function useT(): Translate {
  return useSyncExternalStore(subscribe, () => state).t
}
