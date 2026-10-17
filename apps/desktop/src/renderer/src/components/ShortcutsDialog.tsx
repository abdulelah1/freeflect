import { ArrowCounterClockwiseIcon, KeyboardIcon, XIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import {
  ACTION_LABELS,
  DEFAULT_SHORTCUTS,
  comboFromEvent,
  formatCombo,
  isUsableCombo,
  loadShortcuts,
  saveShortcuts,
  type ShortcutAction,
  type Shortcuts
} from '../input/shortcuts'
import { useT } from '../i18n'

/** Lets the user rebind phone shortcuts by pressing the new keys. */
export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  const t = useT()
  const [shortcuts, setShortcuts] = useState<Shortcuts>(loadShortcuts)
  const [listening, setListening] = useState<ShortcutAction | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const commit = (next: Shortcuts) => {
    setShortcuts(next)
    saveShortcuts(next)
    // Same-window listeners; other windows get the storage event.
    window.dispatchEvent(new Event('mirror-shortcuts-changed'))
  }

  useEffect(() => dialogRef.current?.focus(), [])

  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setListening(null)
      const combo = comboFromEvent(e)
      if (['Alt', 'Shift', 'Control', 'Meta'].some((m) => combo.code.startsWith(m))) return
      if (!isUsableCombo(combo)) {
        setHint(t('shortcuts.needsModifier'))
        return
      }
      // A combo belongs to one action: take it away from any other.
      const next = { ...shortcuts }
      for (const key of Object.keys(next) as ShortcutAction[]) {
        const bound = next[key]
        if (bound && formatCombo(bound).join() === formatCombo(combo).join()) next[key] = null
      }
      next[listening] = combo
      commit(next)
      setListening(null)
      setHint(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening, shortcuts])

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-[oklch(0.1_0.01_260/0.45)] p-6" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => !listening && e.key === 'Escape' && onClose()}
        className="flex max-h-full w-full max-w-[520px] flex-col rounded-[var(--radius-panel)] border border-line bg-surface outline-none"
      >
        <div className="flex items-start justify-between gap-4 p-6 pb-3">
          <div className="flex items-start gap-3">
            <KeyboardIcon size={22} className="mt-0.5 text-accent" />
            <div>
              <h2 id="shortcuts-title" className="text-lg font-semibold tracking-tight">
                {t('shortcuts.title')}
              </h2>
              <p className="mt-0.5 text-sm text-muted">{t('shortcuts.body')}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded p-1 text-muted hover:bg-fg/8 hover:text-fg">
            <XIcon size={16} />
          </button>
        </div>

        <ul className="grid min-h-0 gap-0.5 overflow-y-auto px-4">
          {(Object.keys(ACTION_LABELS) as ShortcutAction[]).map((action) => {
            const keys = formatCombo(shortcuts[action])
            const isListening = listening === action
            return (
              <li key={action} className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-2 py-2">
                <span className="text-sm">{t(ACTION_LABELS[action])}</span>
                <span className="flex items-center gap-2">
                  {isListening ? (
                    <span className="text-xs font-medium text-accent">{t('shortcuts.listening')}</span>
                  ) : keys.length ? (
                    <span className="flex gap-1">
                      {keys.map((k) => (
                        <kbd key={k} className="min-w-6 rounded border border-line bg-bg px-1.5 py-0.5 text-center font-mono text-xs">
                          {k}
                        </kbd>
                      ))}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">{t('shortcuts.none')}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setHint(null)
                      setListening(isListening ? null : action)
                    }}
                    className="rounded-[var(--radius-control)] border border-line px-2 py-1 text-xs font-medium hover:bg-fg/5"
                  >
                    {isListening ? t('common.cancel') : t('settings.folder.change')}
                  </button>
                </span>
              </li>
            )
          })}
        </ul>

        {hint && (
          <p role="alert" className="px-6 pt-2 text-xs text-warn">
            {hint}
          </p>
        )}
        <div className="mt-3 flex justify-end border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={() => commit(DEFAULT_SHORTCUTS)}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm font-medium text-muted hover:bg-fg/8 hover:text-fg"
          >
            <ArrowCounterClockwiseIcon size={16} />
            {t('shortcuts.reset')}
          </button>
        </div>
      </div>
    </div>
  )
}
