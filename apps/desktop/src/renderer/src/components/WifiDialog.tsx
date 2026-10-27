import { WarningIcon, WifiHighIcon, WifiSlashIcon, XIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { AndroidDevice } from '../../../shared-ipc'
import { cleanError, WifiPairPanel } from './WifiPairPanel'
import { useT } from '../i18n'

interface Props {
  usbDevices: AndroidDevice[]
  onClose(): void
  onConnected(serial: string): void
}

export function WifiDialog({ usbDevices, onClose, onConnected }: Props) {
  const t = useT()
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [turnedOff, setTurnedOff] = useState<string | null>(null)
  /** Android SDK per plugged-in phone; null while unknown. */
  const [sdks, setSdks] = useState<Record<string, number | null>>({})
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => dialogRef.current?.focus(), [])
  useEffect(() => {
    for (const d of usbDevices) {
      void window.mirror.deviceProps(d.serial).then(
        (p) => setSdks((s) => ({ ...s, [d.serial]: p.sdk })),
        () => setSdks((s) => ({ ...s, [d.serial]: null }))
      )
    }
  }, [usbDevices])

  const switchToWifi = async (serial: string) => {
    setSwitching(serial)
    setSwitchError(null)
    try {
      onConnected(await window.mirror.switchToWifi(serial))
    } catch (e) {
      setSwitchError(cleanError(e))
    } finally {
      setSwitching(null)
    }
  }

  const turnOff = async (serial: string) => {
    setSwitchError(null)
    try {
      await window.mirror.turnOffWifiDebugging(serial)
      setTurnedOff(serial)
    } catch (e) {
      setSwitchError(cleanError(e))
    }
  }

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-[oklch(0.1_0.01_260/0.45)] p-6" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wifi-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        className="max-h-full w-full max-w-[560px] overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-surface p-6 outline-none"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="wifi-title" className="text-lg font-semibold tracking-tight">
            {t('sidebar.wifi')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded p-1 text-muted hover:bg-fg/8 hover:text-fg"
          >
            <XIcon size={16} />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">{t('wifi.sameNetwork')}</p>

        <section className="mt-5 border-t border-line pt-5">
          <WifiPairPanel onConnected={onConnected} />
        </section>

        {usbDevices.length > 0 && (
          <section className="mt-5 border-t border-line pt-5">
            <h3 className="text-sm font-medium">{t('wifi.pluggedIn')}</h3>
            <p className="mt-1 flex items-start gap-1.5 text-[13px] leading-relaxed text-muted">
              <WarningIcon size={15} className="mt-0.5 shrink-0 text-warn" />
              {t('wifi.switchHint')}
            </p>
            <ul className="mt-3 grid gap-2">
              {usbDevices.map((d) => {
                // Android 11+ has Wireless debugging: pair above instead.
                const modern = (sdks[d.serial] ?? 0) >= 30
                return (
                  <li key={d.serial} className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{d.model ?? d.serial}</span>
                      {modern && <span className="block text-xs text-muted">{t('wifi.useQrInstead')}</span>}
                      {turnedOff === d.serial && <span className="block text-xs text-ok">{t('wifi.turnedOff')}</span>}
                    </span>
                    <span className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        onClick={() => void turnOff(d.serial)}
                        className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium text-muted hover:bg-fg/8 hover:text-fg"
                      >
                        <WifiSlashIcon size={14} />
                        {t('wifi.turnOff')}
                      </button>
                      {!modern && (
                        <button
                          type="button"
                          disabled={switching !== null || !(d.serial in sdks)}
                          onClick={() => void switchToWifi(d.serial)}
                          className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
                        >
                          <WifiHighIcon size={14} />
                          {switching === d.serial ? t('wifi.switching') : t('wifi.switch')}
                        </button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
            {switchError && (
              <p role="alert" className="mt-2 text-xs text-err">
                {switchError}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

