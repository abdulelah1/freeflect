import {
  BroadcastIcon,
  CameraIcon,
  CaretLeftIcon,
  CircleIcon,
  LinkIcon,
  PackageIcon
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AndroidDevice, KeyName } from '../../../shared-ipc'
import { useInputCapture } from '../input/useInputCapture'
import { useVideoStream } from '../video/useVideoStream'
import { folderPhrase } from '../lib/folderPhrase'
import { useT } from '../i18n'

/** Low-bitrate tiles so many phones fit on the network and the GPU. */
const TILE_OPTIONS = { maxSize: 480, bitRate: 1_500_000, maxFps: 15, audio: false }
const TILE_HEIGHT = 380

interface Props {
  devices: AndroidDevice[]
  onOpenDevice(serial: string): void
  onToast(title: string, body?: string, tone?: 'success' | 'error'): void
}

/** All ready phones at once, with optional control of all of them together. */
export function FarmView({ devices, onOpenDevice, onToast }: Props) {
  const t = useT()
  const [broadcast, setBroadcast] = useState(false)
  const [url, setUrl] = useState('')
  const captures = useRef(new Map<string, () => Promise<ArrayBuffer | null>>())
  const serials = devices.map((d) => d.serial)

  const tapAll = (key: KeyName) => {
    for (const s of serials) {
      window.mirror.sendInput(s, { type: 'key', key, down: true, modifiers: 0 })
      window.mirror.sendInput(s, { type: 'key', key, down: false, modifiers: 0 })
    }
  }

  const screenshotAll = async () => {
    let saved = 0
    let last = ''
    for (const d of devices) {
      const png = await captures.current.get(d.serial)?.()
      if (!png) continue
      last = await window.mirror.saveScreenshot(png, d.model ?? d.serial)
      saved++
    }
    onToast(t('farm.screenshotsSaved', { count: saved }), last ? folderPhrase(last) : '')
  }

  const openUrl = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await window.mirror.openUrlOnPhones(serials, url.trim())
      onToast(t('farm.linkOpened'))
    } catch (err) {
      onToast(t('farm.linkFailed'), String(err).replace(/^.*?Error: /, ''), 'error')
    }
  }

  const register = useCallback((serial: string, capture: (() => Promise<ArrayBuffer | null>) | null) => {
    if (capture) captures.current.set(serial, capture)
    else captures.current.delete(serial)
  }, [])

  return (
    <section aria-label={t('sidebar.allDevices')} className="flex min-h-0 flex-1 flex-col bg-stage">
      <header className="drag flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2">
        <h1 className="text-[15px] font-semibold tracking-tight">{t('sidebar.allDevices')}</h1>
        <div className="no-drag flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setBroadcast(!broadcast)}
            aria-pressed={broadcast}
            title={t('farm.broadcastHint')}
            className={`inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border px-3 py-1.5 text-xs font-medium ${
              broadcast ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface hover:bg-fg/5'
            }`}
          >
            <BroadcastIcon size={14} />
            {broadcast ? t('farm.controllingAll') : t('farm.controlAll')}
          </button>
          <BarButton label={t('farm.backAll')} onClick={() => tapAll('back')} icon={<CaretLeftIcon size={14} weight="bold" className="rtl:-scale-x-100" />} />
          <BarButton label={t('farm.homeAll')} onClick={() => tapAll('home')} icon={<CircleIcon size={13} weight="bold" />} />
          <BarButton label={t('farm.screenshotAll')} onClick={() => void screenshotAll()} icon={<CameraIcon size={15} />} />
          <BarButton label={t('farm.installAll')} onClick={() => void window.mirror.installApkDialog(serials)} icon={<PackageIcon size={15} />} />
          <form onSubmit={openUrl} className="flex items-center gap-1">
            <label htmlFor="farm-url" className="sr-only">
              {t('farm.linkLabel')}
            </label>
            <input
              id="farm-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://"
              className="w-44 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-xs placeholder:text-muted"
            />
            <BarButton label={t('farm.openAll')} type="submit" icon={<LinkIcon size={15} />} />
          </form>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6 pt-2">
        <ul className="flex flex-wrap gap-6">
          {devices.map((d) => (
            <FarmTile
              key={d.serial}
              device={d}
              targets={broadcast ? serials : [d.serial]}
              highlighted={broadcast}
              onOpen={() => onOpenDevice(d.serial)}
              register={register}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}

function BarButton(props: { label: string; icon: ReactNode; onClick?(): void; type?: 'button' | 'submit' }) {
  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      className="grid size-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-fg/8 hover:text-fg active:scale-[0.96]"
    >
      {props.icon}
    </button>
  )
}

function FarmTile(props: {
  device: AndroidDevice
  targets: string[]
  highlighted: boolean
  onOpen(): void
  register(serial: string, capture: (() => Promise<ArrayBuffer | null>) | null): void
}) {
  const { device, targets, register } = props
  const { container, stats, captureFrame } = useVideoStream(true, device.serial)
  const t = useT()
  const [failed, setFailed] = useState<string | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  useInputCapture(screenRef, failed ? null : targets)

  useEffect(() => {
    window.mirror.startMirror(device.serial, TILE_OPTIONS).catch((e: unknown) => setFailed(String(e).replace(/^.*?\[\w+\] /, '')))
    register(device.serial, captureFrame)
    return () => {
      register(device.serial, null)
      void window.mirror.stopMirror(device.serial)
    }
  }, [device.serial, captureFrame, register])

  const aspect = stats?.width ? stats.width / stats.height : 1080 / 2340
  return (
    <li className="flex flex-col items-center gap-2">
      <div
        className={`rounded-[26px] bg-[var(--bezel)] p-[5px] ${props.highlighted ? 'outline-2 outline-offset-2 outline-accent' : ''}`}
        // Outline (not a ring): the inline box-shadow would hide a ring.
        style={{ boxShadow: 'var(--phone-shadow)', outlineStyle: props.highlighted ? 'solid' : undefined }}
      >
        <div
          ref={screenRef}
          tabIndex={0}
          aria-label={t('farm.tileScreen', { name: device.model ?? device.serial })}
          className="phone-screen relative overflow-hidden rounded-[21px] bg-[var(--bezel)]"
          style={{ height: TILE_HEIGHT, aspectRatio: aspect, touchAction: 'none' }}
        >
          <div ref={container} className="h-full w-full" />
          {(!stats?.fps || failed) && (
            <div className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-[oklch(0.8_0.01_260)]">
              {failed ?? t('farm.connecting')}
            </div>
          )}
        </div>
      </div>
      <button type="button" onClick={props.onOpen} title={t('farm.openMain')} className="max-w-52 truncate text-sm font-medium hover:text-accent">
        {device.model ?? device.serial}
      </button>
    </li>
  )
}
