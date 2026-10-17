import { DeviceMobileIcon } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { useT } from '../i18n'

/** Asked once per phone: lets a new iPhone running the companion app connect. */
export function CompanionApproval({ name, onAnswer }: { name: string; onAnswer(allow: boolean): void }) {
  const t = useT()
  const allowRef = useRef<HTMLButtonElement>(null)
  useEffect(() => allowRef.current?.focus(), [])
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[oklch(0.1_0.01_260/0.45)] p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-body"
        className="w-full max-w-[400px] rounded-[var(--radius-panel)] border border-line bg-surface p-6"
      >
        <DeviceMobileIcon size={28} className="text-accent" />
        <h2 id="approval-title" className="mt-3 text-lg font-semibold tracking-tight">
          {t('approval.title', { name })}
        </h2>
        <p id="approval-body" className="mt-1.5 text-sm leading-relaxed text-muted">
          {t('approval.body')}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onAnswer(false)}
            className="rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium text-muted hover:bg-fg/8 hover:text-fg"
          >
            {t('approval.deny')}
          </button>
          <button
            ref={allowRef}
            type="button"
            onClick={() => onAnswer(true)}
            className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
          >
            {t('approval.allow')}
          </button>
        </div>
      </div>
    </div>
  )
}
