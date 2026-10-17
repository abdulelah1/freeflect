import { WifiHighIcon, XIcon } from '@phosphor-icons/react'
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
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => dialogRef.current?.focus(), [])

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

        {usbDevices.length > 0 && (
          <section className="mt-5 border-t border-line pt-5">
            <h3 className="text-sm font-medium">{t('wifi.pluggedIn')}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              {t('wifi.switchHint')}
            </p>
            <ul className="mt-3 grid gap-2">
              {usbDevices.map((d) => (
                <li key={d.serial} className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm">{d.model ?? d.serial}</span>
                  <button
                    type="button"
                    disabled={switching !== null}
                    onClick={() => void switchToWifi(d.serial)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
                  >
                    <WifiHighIcon size={14} />
                    {switching === d.serial ? t('wifi.switching') : t('wifi.switch')}
                  </button>
                </li>
              ))}
            </ul>
            {switchError && (
              <p role="alert" className="mt-2 text-xs text-err">
                {switchError}
              </p>
            )}
          </section>
        )}

        <section className="mt-5 border-t border-line pt-5">
          <WifiPairPanel onConnected={onConnected} />
        </section>
      </div>
    </div>
  )
}
