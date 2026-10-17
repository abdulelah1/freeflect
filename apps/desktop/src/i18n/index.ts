/// <reference types="vite/client" />
// Translations for the window and the main process. Every JSON file in
// src/locales is a language, found at build time: adding one (copy en.json,
// translate the values, set "_meta") is all a new language needs.
//
// Values are plain strings with {placeholders}, or plural forms chosen by
// {count}: { "one": "1 file", "other": "{count} files" } with the categories
// of Intl.PluralRules for that language (Arabic uses zero, one, two, few,
// many and other). A key missing from a language falls back to English.

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>
type Messages = { [key: string]: string | PluralForms | Messages }
export interface LocaleMeta {
  /** The language's own name, shown in the language picker. */
  name: string
  dir: 'ltr' | 'rtl'
}
type LocaleFile = Messages & { _meta: LocaleMeta }

const files = import.meta.glob<LocaleFile>('../locales/*.json', { eager: true, import: 'default' })
const locales: Record<string, LocaleFile> = Object.fromEntries(
  Object.entries(files).map(([path, file]) => [path.replace(/^.*\/|\.json$/g, ''), file])
)
export const FALLBACK = 'en'

export function availableLanguages(): ({ code: string } & LocaleMeta)[] {
  return Object.entries(locales)
    .map(([code, file]) => ({ code, ...file._meta }))
    .sort((a, b) => (a.code === FALLBACK ? -1 : b.code === FALLBACK ? 1 : a.name.localeCompare(b.name)))
}

/** First of `preferred` (BCP 47 tags, best first) that has a file: exact tag, then its base language. */
export function resolveLanguage(preferred: readonly string[]): string {
  for (const tag of preferred) {
    if (locales[tag]) return tag
    const base = tag.split('-')[0]!.toLowerCase()
    if (locales[base]) return base
  }
  return FALLBACK
}

export const directionOf = (code: string): 'ltr' | 'rtl' => locales[code]?._meta.dir ?? 'ltr'

function lookup(file: Messages | undefined, key: string): string | PluralForms | undefined {
  let node: unknown = file
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Messages)[part]
  }
  return typeof node === 'string' || (node && typeof node === 'object') ? (node as string | PluralForms) : undefined
}

export type Vars = Record<string, string | number>
export type Translate = (key: string, vars?: Vars) => string

export function createTranslator(code: string): Translate {
  const plurals = new Intl.PluralRules(code)
  const fallbackPlurals = new Intl.PluralRules(FALLBACK)
  return (key, vars) => {
    let value = lookup(locales[code], key)
    let rules = plurals
    if (value === undefined) {
      value = lookup(locales[FALLBACK], key)
      rules = fallbackPlurals
    }
    if (value === undefined) return key
    let text: string
    if (typeof value === 'string') text = value
    else {
      const forms = value as PluralForms
      const n = Number(vars?.count ?? 0)
      // An explicit "zero" form wins for 0 even where the language has no zero category.
      text = (n === 0 && forms.zero) || forms[rules.select(n)] || forms.other || key
    }
    return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text
  }
}
