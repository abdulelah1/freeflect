import { CheckCircleIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { useT } from '../i18n'

export interface Toast {
  id: string
  tone: 'info' | 'success' | 'error'
  title: string
  body?: string
  /** 0..1 for an in-progress transfer. */
  progress?: number
  action?: { label: string; onClick(): void }
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
  const tr = useT()
  return (
    <ol aria-live="polite" className="pointer-events-none fixed end-4 bottom-20 z-20 grid w-80 gap-2">
      {toasts.map((t) => (
        <li
          key={t.id}
          className="pointer-events-auto rounded-[var(--radius-panel)] border border-line bg-surface p-3 shadow-[0_8px_24px_oklch(0.2_0.02_260/0.18)]"
        >
          <div className="flex items-start gap-2.5">
            {t.tone === 'success' && <CheckCircleIcon size={18} weight="fill" className="mt-px shrink-0 text-ok" />}
            {t.tone === 'error' && <WarningCircleIcon size={18} weight="fill" className="mt-px shrink-0 text-err" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t.title}</p>
              {t.body && <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted">{t.body}</p>}
              {t.progress !== undefined && (
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(t.progress * 100)}
                  className="mt-2 h-1 overflow-hidden rounded-full bg-fg/8"
                >
                  <div className="h-full rounded-full bg-accent" style={{ width: `${t.progress * 100}%` }} />
                </div>
              )}
              {t.action && (
                <button
                  type="button"
                  onClick={t.action.onClick}
                  className="mt-1.5 text-xs font-medium text-accent hover:underline"
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label={tr('common.dismiss')}
              className="shrink-0 rounded p-0.5 text-muted hover:bg-fg/8 hover:text-fg"
            >
              <XIcon size={14} />
            </button>
          </div>
        </li>
      ))}
    </ol>
  )
}
