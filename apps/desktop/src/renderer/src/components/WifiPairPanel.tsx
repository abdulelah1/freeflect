import { useEffect, useState, type FormEvent } from 'react'
import type { WifiPairStatus } from '../../../shared-ipc'
import { useT } from '../i18n'

export const cleanError = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^\[\w+\] /, '')

/**
 * QR pairing plus the pairing-code fallback. Starts advertising a QR session
 * on mount and cancels it on unmount. Used by the Wi-Fi dialog and the setup
 * wizard.
 */
export function WifiPairPanel({ onConnected }: { onConnected(serial: string): void }) {
  const t = useT()
  const [qr, setQr] = useState<string | null>(null)
  const [status, setStatus] = useState<WifiPairStatus>({ state: 'waiting' })

  useEffect(() => {
    const off = window.mirror.onQrPairStatus((s) => {
      setStatus(s)
      if (s.state === 'connected') onConnected(s.serial)
    })
    void window.mirror.startQrPairing().then(setQr)
    return () => {
      off()
      window.mirror.cancelQrPairing()
    }
  }, [onConnected])

  return (
    <div>
      <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
        <div>
          <h3 className="text-sm font-medium">{t('wifi.qrTitle')}</h3>
          <ol className="mt-2 grid list-decimal gap-1.5 ps-4 text-[13px] leading-relaxed text-muted">
            <li>{t('wifi.qr1')}</li>
            <li>{t('wifi.qr2')}</li>
            <li>{t('wifi.qr3')}</li>
          </ol>
          <p className="mt-3 text-xs text-muted">{t('wifi.needsAndroid11')}</p>
          <PairStatus status={status} />
        </div>
        <div className="grid size-44 place-items-center justify-self-center rounded-[var(--radius-control)] bg-[oklch(0.99_0_0)] p-2">
          {qr ? (
            <img
              alt={t('wifi.qrAlt')}
              className="size-full"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`}
            />
          ) : (
            <div className="size-full animate-pulse rounded bg-[oklch(0.92_0.005_260)]" />
          )}
        </div>
      </div>
      <PairingCodeForm onConnected={onConnected} />
    </div>
  )
}

function PairStatus({ status }: { status: WifiPairStatus }) {
  const t = useT()
  const [text, tone] =
    status.state === 'waiting'
      ? [t('wifi.waitingScan'), 'text-muted']
      : status.state === 'pairing'
        ? [t('wifi.pairing'), 'text-fg']
        : status.state === 'connected'
          ? [t('wifi.connected'), 'text-ok']
          : [status.message, 'text-err']
  return (
    <p role="status" className={`mt-3 text-sm font-medium ${tone}`}>
      {text}
    </p>
  )
}

function PairingCodeForm({ onConnected }: { onConnected(serial: string): void }) {
  const t = useT()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onConnected(await window.mirror.pairWithCode(address, code))
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="mt-5 border-t border-line pt-4">
      <summary className="cursor-default text-sm font-medium">{t('wifi.codeTitle')}</summary>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        {t('wifi.codeHint')}
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
        <div className="grid gap-1.5">
          <label htmlFor="pair-address" className="text-xs font-medium">
            {t('wifi.address')}
          </label>
          <input
            id="pair-address"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            pattern="[0-9.]+:[0-9]+"
            inputMode="decimal"
            className="rounded-[var(--radius-control)] border border-line bg-bg px-2.5 py-1.5 font-mono text-sm"
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="pair-code" className="text-xs font-medium">
            {t('wifi.code')}
          </label>
          <input
            id="pair-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            pattern="[0-9]{6}"
            inputMode="numeric"
            maxLength={6}
            className="rounded-[var(--radius-control)] border border-line bg-bg px-2.5 py-1.5 font-mono text-sm tracking-widest"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? t('wifi.pairingShort') : t('wifi.pair')}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-xs text-err">
          {error}
        </p>
      )}
    </details>
  )
}
