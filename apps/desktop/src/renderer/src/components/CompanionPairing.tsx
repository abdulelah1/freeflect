import { CheckCircleIcon, DeviceMobileIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanionPairing as Pairing } from '../../../shared-ipc'
import { useT } from '../i18n'
import { cleanError } from './WifiPairPanel'

type Phase =
  | { kind: 'loading' }
  | { kind: 'open'; pairing: Pairing; deadline: number }
  | { kind: 'paired'; name: string }
  | { kind: 'closed'; reason: string }

/**
 * Pairs an iPhone running the FreeFlect app: it scans the QR code, or the
 * user types the code. Pairing is open on the computer while this is shown
 * (for one phone, two minutes at most) and ends when it goes away. Used in
 * the pairing dialog, the Wi-Fi dialog and the setup guide.
 */
export function CompanionPairPanel({ onPaired }: { onPaired?(phone: { deviceId: string; name: string }): void }) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [now, setNow] = useState(Date.now())
  // Read through a ref so a new callback doesn't restart pairing.
  const onPairedRef = useRef(onPaired)
  onPairedRef.current = onPaired

  const start = useCallback(() => {
    setPhase({ kind: 'loading' })
    window.mirror.startCompanionPairing().then(
      (pairing) => setPhase({ kind: 'open', pairing, deadline: Date.now() + pairing.expiresInSecs * 1000 }),
      (e: unknown) => setPhase({ kind: 'closed', reason: cleanError(e) })
    )
  }, [])

  useEffect(() => {
    const offPaired = window.mirror.onCompanionPaired((p) => {
      setPhase({ kind: 'paired', name: p.name })
      onPairedRef.current?.(p)
    })
    const offClosed = window.mirror.onCompanionPairingClosed((reason) =>
      setPhase((p) => (p.kind === 'paired' || reason === 'paired' ? p : { kind: 'closed', reason }))
    )
    start()
    return () => {
      offPaired()
      offClosed()
      void window.mirror.cancelCompanionPairing()
    }
  }, [start])

  useEffect(() => {
    if (phase.kind !== 'open') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase.kind])

  const secondsLeft = phase.kind === 'open' ? Math.max(0, Math.round((phase.deadline - now) / 1000)) : 0
  const closedText =
    phase.kind !== 'closed'
      ? ''
      : phase.reason === 'expired'
        ? t('pairing.expired')
        : phase.reason === 'attempts'
          ? t('pairing.attempts')
          : phase.reason

  if (phase.kind === 'paired') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm font-medium text-ok">
        <CheckCircleIcon size={18} weight="fill" className="shrink-0" />
        {t('pairing.done', { name: phase.name })}
      </p>
    )
  }
  if (phase.kind === 'closed') {
    return (
      <div className="grid gap-3">
        <p role="alert" className="flex items-start gap-2 text-sm text-err">
          <WarningCircleIcon size={18} className="mt-px shrink-0" />
          {closedText}
        </p>
        <button
          type="button"
          onClick={start}
          className="justify-self-start rounded-[var(--radius-control)] border border-line px-4 py-2 text-sm font-medium hover:bg-fg/6 active:scale-[0.98]"
        >
          {t('pairing.again')}
        </button>
      </div>
    )
  }
  return (
    <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
      <div>
        <ol className="grid list-decimal gap-1.5 ps-4 text-[13px] leading-relaxed text-muted">
          <li>{t('pairing.step1')}</li>
          <li>{t('pairing.step2')}</li>
        </ol>
        <p className="mt-4 text-xs font-medium">{t('pairing.codeLabel')}</p>
        {phase.kind === 'open' ? (
          <p dir="ltr" className="mt-1 select-all text-start font-mono text-2xl font-semibold tracking-[0.12em]" aria-live="off">
            {phase.pairing.code}
          </p>
        ) : (
          <div aria-hidden className="mt-1 h-8 w-40 animate-pulse rounded bg-fg/6" />
        )}
        <p role="status" className="mt-3 text-xs text-muted">
          {phase.kind === 'open' ? t('pairing.expiresIn', { count: secondsLeft }) : t('pairing.preparing')}
        </p>
      </div>
      <div className="grid size-44 place-items-center justify-self-center rounded-[var(--radius-control)] bg-[oklch(0.99_0_0)] p-2">
        {phase.kind === 'open' ? (
          <img
            alt={t('pairing.qrAlt')}
            className="size-full"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(phase.pairing.qrSvg)}`}
          />
        ) : (
          <div className="size-full animate-pulse rounded bg-[oklch(0.92_0.005_260)]" />
        )}
      </div>
    </div>
  )
}

/** The pairing panel as a dialog (Settings, Pair iPhone). */
export function CompanionPairing({ onClose }: { onClose(): void }) {
  const t = useT()
  const [paired, setPaired] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Focus goes to Cancel, never to an action that changes anything.
  useEffect(() => closeRef.current?.focus(), [])

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-[oklch(0.1_0.01_260/0.45)] p-6"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // Settings, underneath, closes on Escape too.
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-title"
        className="w-full max-w-[520px] rounded-[var(--radius-panel)] border border-line bg-surface p-6"
      >
        <DeviceMobileIcon size={28} className="text-accent" />
        <h2 id="pairing-title" className="mb-4 mt-3 text-lg font-semibold tracking-tight">
          {t('pairing.title')}
        </h2>
        <CompanionPairPanel onPaired={() => setPaired(true)} />
        <div className="mt-6 flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className={
              paired
                ? 'rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]'
                : 'rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium text-muted hover:bg-fg/8 hover:text-fg'
            }
          >
            {paired ? t('pairing.close') : t('pairing.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
