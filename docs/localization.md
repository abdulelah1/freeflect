# Adding a language

The desktop app's text lives in `apps/desktop/src/locales/<code>.json`, one file
per language (`en.json`, `ar.json`). Both the window and the main process find
every file there at build time, so a new language needs no code changes.

1. Copy `en.json` to `<code>.json`, where `<code>` is a BCP 47 language code
   (`fr`, `de`, `pt-BR`).
2. Set `_meta`: the language's own name (`"Français"`) and its direction
   (`"ltr"`, or `"rtl"` for Arabic, Hebrew, Persian, Urdu).
3. Translate the values. Keep `{placeholders}` as they are; `<b>...</b>` marks
   the emphasized words of a sentence and may move within it.
4. Plurals are objects keyed by `Intl.PluralRules` categories for the language
   (`one`, `other`; Arabic also uses `zero`, `two`, `few`, `many`).
5. Build. The language appears in Settings, Language. With "Same as the
   system", it is used when the computer's preferred language matches.

A key missing from a language falls back to English. Product names (FreeFlect,
iPhone app names, Android menu names from the phone itself) are translated too,
under `phoneMenu.*`, since phones show their menus in their own language.
