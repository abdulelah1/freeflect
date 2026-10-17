// The app's language: the Language setting, or the system's preferred
// languages ("system"), matched against the files in src/locales.

import { app, BrowserWindow, ipcMain } from 'electron'
import { createTranslator, directionOf, FALLBACK, resolveLanguage, type Translate } from '../i18n'

let code = FALLBACK
let translate = createTranslator(FALLBACK)
const listeners: (() => void)[] = []

/** Translates in the app's current language (main process). */
export const t: Translate = (key, vars) => translate(key, vars)
export const currentLanguage = () => code

/** Called whenever the language may have changed (see after an update). */
export function onLanguageChange(cb: () => void): void {
  listeners.push(cb)
}

/** `setting` is a language code or "system". MIRROR_LANG overrides it (tests). */
export function applyLanguage(setting: string): void {
  const forced = process.env.MIRROR_LANG
  const next = forced
    ? resolveLanguage([forced])
    : setting === 'system'
      ? resolveLanguage(app.isReady() ? app.getPreferredSystemLanguages() : [app.getLocale()])
      : resolveLanguage([setting])
  if (next === code) return
  code = next
  translate = createTranslator(code)
  for (const cb of listeners) cb()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('i18n:changed', { code, dir: directionOf(code) })
}

export function registerI18nIpc(): void {
  // Synchronous so a window renders in the right language from its first frame.
  ipcMain.on('i18n:get-sync', (e) => {
    e.returnValue = { code, dir: directionOf(code) }
  })
}
