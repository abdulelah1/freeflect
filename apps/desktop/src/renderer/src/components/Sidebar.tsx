import {
  AppWindowIcon,
  ArrowClockwiseIcon,
  CheckSquareIcon,
  CopySimpleIcon,
  SquareIcon,
  GearSixIcon,
  PlusCircleIcon,
  SquaresFourIcon,
  FilmStripIcon,
  UsbIcon,
  WarningCircleIcon,
  WifiHighIcon
} from '@phosphor-icons/react'
import { useState } from 'react'
import type { AndroidDevice } from '../../../shared-ipc'
import { useT } from '../i18n'
import { BrandLogo } from './BrandLogo'

export type Selection = { kind: 'android'; serial: string } | { kind: 'fixture' } | { kind: 'farm' } | null

interface Props {
  devices: AndroidDevice[] | null
  adbError: string | null
  selection: Selection
  onSelect(selection: Selection): void
  onRetry(): void
  onAddWifi(): void
  onSetup(): void
  onOpenDoctor(): void
  onOpenSettings(): void
  /** The test stream is a development tool, not in installed builds. */
  showTestStream: boolean
  /** Serials that currently have their own device window. */
  windowed: string[]
  onOpenWindow(device: AndroidDevice): void
  /** Opens these phones in their own windows at once, side by side. */
  onPopOut(devices: AndroidDevice[]): void
}


export function Sidebar({
  devices,
  adbError,
  selection,
  onSelect,
  onRetry,
  onAddWifi,
  onSetup,
  onOpenDoctor,
  onOpenSettings,
  showTestStream,
  windowed,
  onOpenWindow,
  onPopOut
}: Props) {
  const t = useT()
  // Choosing phones to pop out together: rows become checkboxes.
  const [choosing, setChoosing] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const poppable = (devices ?? []).filter((d) => d.state === 'device' && !windowed.includes(d.serial))
  const canPopMany = poppable.length >= 2
  const isChoosing = choosing && canPopMany
  const stopChoosing = () => {
    setChoosing(false)
    setChosen([])
  }
  const toggleChosen = (serial: string) => setChosen((c) => (c.includes(serial) ? c.filter((s) => s !== serial) : [...c, serial]))
  return (
    <aside className="flex w-72 shrink-0 flex-col border-e border-line bg-sidebar">
      <div className="drag h-12 shrink-0" />
      <div className="px-4 pb-3">
        <h1 className="text-[15px] font-semibold tracking-tight">{t('sidebar.devices')}</h1>
      </div>

      <nav aria-label={t('sidebar.devices')} className="no-drag flex-1 overflow-y-auto px-2">
        {devices === null && !adbError && <DeviceSkeleton />}
        {adbError && <AdbUnavailable message={adbError} onRetry={onRetry} onOpenDoctor={onOpenDoctor} />}
        {devices?.length === 0 && !adbError && <NoDevices onSetup={onSetup} />}
        <ul className="grid gap-1">
          {devices?.map((d) => {
            const selected = selection?.kind === 'android' && selection.serial === d.serial
            const inWindow = windowed.includes(d.serial)
            const choosable = isChoosing && poppable.includes(d)
            const checked = chosen.includes(d.serial)
            return (
              <li key={d.serial} className="group relative">
                <button
                  type="button"
                  onClick={() => (isChoosing ? choosable && toggleChosen(d.serial) : onSelect({ kind: 'android', serial: d.serial }))}
                  disabled={isChoosing && !choosable}
                  role={isChoosing ? 'checkbox' : undefined}
                  aria-checked={isChoosing ? checked : undefined}
                  aria-current={(!isChoosing && selected) || undefined}
                  className={`flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-start transition-colors disabled:opacity-50 ${
                    !isChoosing && selected ? 'bg-accent-soft' : 'hover:bg-fg/5'
                  }`}
                >
                  {isChoosing &&
                    (checked ? (
                      <CheckSquareIcon size={18} weight="fill" className="shrink-0 text-accent" />
                    ) : (
                      <SquareIcon size={18} className="shrink-0 text-muted" />
                    ))}
                  <BrandLogo brand={d.platform === 'ios' ? 'apple' : 'android'} size={18} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{d.model ?? d.serial}</span>
                    <span
                      className={`block truncate text-xs ${d.state === 'device' ? 'text-muted' : 'text-warn'}`}
                    >
                      {inWindow ? t('sidebar.inOwnWindow') : t(`sidebar.state.${d.state}`)}
                    </span>
                  </span>
                  {d.transport === 'usb' ? (
                    <UsbIcon size={16} className="shrink-0 text-muted group-hover:opacity-0" aria-label={t('common.usb')} />
                  ) : (
                    <WifiHighIcon size={16} className="shrink-0 text-muted group-hover:opacity-0" aria-label={t('common.wifi')} />
                  )}
                </button>
                {d.state === 'device' && !inWindow && !isChoosing && (
                  <button
                    type="button"
                    onClick={() => onOpenWindow(d)}
                    aria-label={t('sidebar.openWindowFor', { name: d.model ?? d.serial })}
                    title={t('sidebar.openWindow')}
                    className="absolute end-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-[var(--radius-control)] text-muted opacity-0 hover:bg-fg/8 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <AppWindowIcon size={16} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {canPopMany &&
          (isChoosing ? (
            <div className="mt-2 flex items-center gap-1.5 px-1">
              <button
                type="button"
                disabled={chosen.length === 0}
                onClick={() => {
                  onPopOut(poppable.filter((d) => chosen.includes(d.serial)))
                  stopChoosing()
                }}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
              >
                <AppWindowIcon size={14} />
                {t('sidebar.popOutChosen', { count: chosen.length })}
              </button>
              <button
                type="button"
                onClick={stopChoosing}
                className="rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium text-muted hover:bg-fg/8 hover:text-fg"
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-1.5 px-1">
              <button
                type="button"
                onClick={() => onPopOut(poppable)}
                title={t('sidebar.popOutAllHint')}
                className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-xs font-medium hover:bg-fg/5 active:scale-[0.98]"
              >
                <CopySimpleIcon size={14} />
                {t('sidebar.popOutAll')}
              </button>
              <button
                type="button"
                onClick={() => setChoosing(true)}
                title={t('sidebar.chooseHint')}
                className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-xs font-medium hover:bg-fg/5 active:scale-[0.98]"
              >
                <CheckSquareIcon size={14} />
                {t('sidebar.choose')}
              </button>
            </div>
          ))}
        {(devices?.filter((d) => d.state === 'device').length ?? 0) >= 2 && (
          <button
            type="button"
            onClick={() => onSelect({ kind: 'farm' })}
            aria-current={selection?.kind === 'farm' || undefined}
            className={`mt-1 flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-start transition-colors ${
              selection?.kind === 'farm' ? 'bg-accent-soft' : 'hover:bg-fg/5'
            }`}
          >
            <SquaresFourIcon size={20} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t('sidebar.allDevices')}</span>
              <span className="block text-xs text-muted">{t('sidebar.allDevicesHint')}</span>
            </span>
          </button>
        )}
      </nav>

      <div className="no-drag grid gap-1 border-t border-line p-2">
        <button
          type="button"
          onClick={onSetup}
          className="flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-start transition-colors hover:bg-fg/5"
        >
          <PlusCircleIcon size={20} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t('sidebar.setup')}</span>
            <span className="block text-xs text-muted">{t('sidebar.setupHint')}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={onAddWifi}
          className="flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-start transition-colors hover:bg-fg/5"
        >
          <WifiHighIcon size={20} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t('sidebar.wifi')}</span>
            <span className="block text-xs text-muted">{t('sidebar.wifiHint')}</span>
          </span>
        </button>
        {showTestStream && (
        <button
          type="button"
          onClick={() => onSelect({ kind: 'fixture' })}
          aria-current={selection?.kind === 'fixture' || undefined}
          className={`flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-start transition-colors ${
            selection?.kind === 'fixture' ? 'bg-accent-soft' : 'hover:bg-fg/5'
          }`}
        >
          <FilmStripIcon size={20} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t('sidebar.testStream')}</span>
            <span className="block text-xs text-muted">{t('sidebar.testStreamHint')}</span>
          </span>
        </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-start transition-colors hover:bg-fg/5"
        >
          <GearSixIcon size={20} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t('sidebar.settings')}</span>
            <span className="block text-xs text-muted">{t('sidebar.settingsHint')}</span>
          </span>
        </button>
      </div>
    </aside>
  )
}

function DeviceSkeleton() {
  return (
    <div aria-hidden className="grid gap-1 px-1">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2.5">
          <div className="size-5 rounded-md bg-fg/8" />
          <div className="grid flex-1 gap-1.5">
            <div className="h-3 w-28 rounded bg-fg/8" />
            <div className="h-2.5 w-16 rounded bg-fg/6" />
          </div>
        </div>
      ))}
    </div>
  )
}

function NoDevices({ onSetup }: { onSetup(): void }) {
  const t = useT()
  return (
    <div className="px-3 py-6">
      <p className="text-sm font-medium">{t('sidebar.noPhone')}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        {t('sidebar.noPhoneBody')}
      </p>
      <button
        type="button"
        onClick={onSetup}
        className="mt-4 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
      >
        {t('sidebar.setupYourPhone')}
      </button>
    </div>
  )
}

function AdbUnavailable({ message, onRetry, onOpenDoctor }: { message: string; onRetry(): void; onOpenDoctor(): void }) {
  const t = useT()
  return (
    <div role="alert" className="mx-1 rounded-[var(--radius-panel)] border border-line bg-surface p-3">
      <div className="flex items-start gap-2">
        <WarningCircleIcon size={18} className="mt-px shrink-0 text-err" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('sidebar.adbTitle')}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {t('sidebar.adbBody')}
          </p>
          <details className="mt-2 text-xs text-muted">
            <summary className="cursor-default">{t('common.details')}</summary>
            <p className="mt-1 break-words font-mono">{message}</p>
          </details>
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-line px-2.5 py-1.5 text-xs font-medium hover:bg-fg/5 active:scale-[0.98]"
      >
        <ArrowClockwiseIcon size={14} />
        {t('common.tryAgain')}
      </button>
      <button type="button" onClick={onOpenDoctor} className="ms-3 text-xs font-medium text-accent hover:underline">
        {t('common.runDoctor')}
      </button>
    </div>
  )
}
