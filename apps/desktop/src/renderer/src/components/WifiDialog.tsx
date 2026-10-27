import { CheckCircleIcon, WarningIcon, WifiHighIcon, WifiSlashIcon, XIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { isCompanionSerial, type AndroidDevice } from '../../../shared-ipc'
import { BrandLogo } from './BrandLogo'
import { CompanionPairPanel } from './CompanionPairing'
import { cleanError, WifiPairPanel } from './WifiPairPanel'
import { useT } from '../i18n'
import { Rich } from '../lib/Rich'

type Platform = 'android' | 'ios'

interface Props {
  usbDevices: AndroidDevice[]
  /** Which phone the dialog starts with; the user can switch. */
  initialPlatform: Platform
  onClose(): void
  onConnected(serial: string): void
}

export function WifiDialog({ usbDevices, initialPlatform, onClose, onConnected }: Props) {
  const t = useT()
  const [platform, setPlatform] = useState<Platform>(initialPlatform)
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

        <div role="radiogroup" aria-label={t('wifi.whichPhone')} className="mt-4 inline-flex rounded-[var(--radius-control)] border border-line p-0.5">
          {(['android', 'ios'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={platform === p}
              onClick={() => setPlatform(p)}
              className={`inline-flex items-center gap-2 rounded-[calc(var(--radius-control)-2px)] px-3.5 py-1.5 text-sm font-medium transition-colors ${
                platform === p ? 'bg-fg/10 text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              <BrandLogo brand={p === 'ios' ? 'apple' : 'android'} size={14} />
              {p === 'ios' ? t('common.iphone') : t('wifi.android')}
            </button>
          ))}
        </div>

        {platform === 'ios' ? (
          <section className="mt-5 border-t border-line pt-5">
            <IphoneWifiPanel onConnected={onConnected} />
          </section>
        ) : (
          <section className="mt-5 border-t border-line pt-5">
            <WifiPairPanel onConnected={onConnected} />
          </section>
        )}

        {platform === 'android' && usbDevices.length > 0 && (
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

/**
 * iPhones join over Wi-Fi through the FreeFlect iPhone app: pair it once
 * (right here if it isn't yet), then start its broadcast. Calls `onConnected`
 * when a paired iPhone starts sharing its screen.
 */
function IphoneWifiPanel({ onConnected }: { onConnected(serial: string): void }) {
  const t = useT()
  const [phones, setPhones] = useState<{ deviceId: string; name: string }[] | null>(null)
  const [pairing, setPairing] = useState(false)

  useEffect(() => {
    void window.mirror.listCompanionDevices().then((list) => {
      setPhones(list)
      if (list.length === 0) setPairing(true)
    })
  }, [])

  // A paired iPhone that starts its broadcast shows up as a device.
  useEffect(() => {
    if (pairing || !phones?.length) return
    let alive = true
    const poll = async () => {
      const sharing = (await window.mirror.listIosDevices().catch(() => [])).find((d) => isCompanionSerial(d.serial))
      if (alive && sharing) onConnected(sharing.serial)
    }
    void poll()
    const id = setInterval(poll, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [pairing, phones, onConnected])

  if (phones === null) return <div aria-hidden className="h-24 rounded-[var(--radius-control)] bg-fg/6" />

  if (pairing) {
    return (
      <div>
        <h3 className="text-sm font-medium">{t('pairing.title')}</h3>
        <p className="mb-4 mt-1 text-[13px] leading-relaxed text-muted">{t('wifi.iosNeedsApp')}</p>
        <CompanionPairPanel
          onPaired={(phone) => {
            setPhones((list) => [...(list ?? []).filter((p) => p.deviceId !== phone.deviceId), phone])
            setPairing(false)
          }}
        />
      </div>
    )
  }

  return (
    <div>
      <p className="flex items-center gap-2 text-sm font-medium">
        <CheckCircleIcon size={18} weight="fill" className="shrink-0 text-ok" />
        {t('wifi.iosPaired', { names: phones.map((p) => p.name).join(', ') })}
      </p>
      <h3 className="mt-5 text-sm font-medium">{t('setup.iosBroadcast.title')}</h3>
      <ol className="mt-2 grid list-decimal gap-1.5 ps-4 text-[13px] leading-relaxed text-muted">
        <li>
          <Rich text={t('setup.iosBroadcast.step1')} />
        </li>
        <li>
          <Rich text={t('setup.iosBroadcast.step2')} />
        </li>
      </ol>
      <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted">
        <span className="relative grid size-4 place-items-center">
          <span className="absolute inset-0 rounded-full bg-accent/25 motion-safe:animate-ping" />
          <span className="size-2 rounded-full bg-accent" />
        </span>
        {t('setup.iosBroadcast.waiting')}
      </p>
      <button
        type="button"
        onClick={() => setPairing(true)}
        className="mt-5 rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-xs font-medium hover:bg-fg/6 active:scale-[0.98]"
      >
        {t('wifi.pairAnother')}
      </button>
    </div>
  )
}
