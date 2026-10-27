import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CopyIcon,
  InfoIcon,
  StethoscopeIcon,
  WarningCircleIcon,
  XIcon
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isIosSerial, type DoctorCheckId, type DoctorFix, type DoctorResult } from '../../../shared-ipc'
import { BrandLogo } from '../components/BrandLogo'
import { CompanionPairing } from '../components/CompanionPairing'
import { askMediaAccess } from '../components/PermissionGate'
import { t, useT } from '../i18n'

type Platform = 'android' | 'ios'

/**
 * Checks run in order within a group: later ones only make sense once earlier
 * ones pass, so a failure in `blocking` skips the rest of its group.
 */
interface Group {
  /** Locale key of the section heading. */
  title?: string
  checks: DoctorCheckId[]
  blocking: DoctorCheckId[]
}

const GROUPS: Record<Platform, Group[]> = {
  android: [{ checks: ['adb', 'device', 'authorized', 'network', 'brand', 'stream'], blocking: ['adb', 'device', 'authorized'] }],
  // A cable and Wi-Fi are independent ways in: a problem with one says nothing about the other.
  ios: [
    { title: 'doctor.group.cable', checks: ['iosCable', 'iosPermission', 'iosCapture'], blocking: ['iosCable', 'iosPermission'] },
    { title: 'doctor.group.wifi', checks: ['iosLan', 'iosPaired', 'iosListening', 'iosLink'], blocking: ['iosPaired', 'iosListening'] }
  ]
}

const checksOf = (platform: Platform) => GROUPS[platform].flatMap((g) => g.checks)

type Row = { state: 'pending' | 'running' } | { state: 'done'; result: DoctorResult }

interface Props {
  /** The phone to diagnose; the first ready phone is used when null. */
  serial: string | null
  /** Which kind of phone to start with; the user can switch. */
  initialPlatform: Platform
  onClose(): void
  onOpenSetup(): void
}

export function ConnectionDoctor({ serial, initialPlatform, onClose, onOpenSetup }: Props) {
  const [platform, setPlatform] = useState<Platform>(initialPlatform)
  const [rows, setRows] = useState<Partial<Record<DoctorCheckId, Row>>>(() => initialRows(initialPlatform))
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pairing, setPairing] = useState(false)
  // A phone of the other kind isn't diagnosed by these checks.
  const ownSerial = (p: Platform) => (serial && isIosSerial(serial) === (p === 'ios') ? serial : null)
  const [target, setTarget] = useState<string | null>(ownSerial(initialPlatform))
  const runId = useRef(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  const runAll = useCallback(async () => {
    const id = ++runId.current
    setRunning(true)
    setRows(initialRows(platform))
    let device = serial && isIosSerial(serial) === (platform === 'ios') ? serial : null
    setTarget(device)
    for (const group of GROUPS[platform]) {
      /** Why the rest of the group is skipped, once something above stops it. */
      let blocked: string | null = null
      for (const check of group.checks) {
        if (runId.current !== id) return
        if (blocked) {
          setRows((r) => ({
            ...r,
            [check]: { state: 'done', result: { id: check, status: 'skip', title: blocked! } }
          }))
          continue
        }
        setRows((r) => ({ ...r, [check]: { state: 'running' } }))
        if (check === 'authorized' && !device) {
          const ready = (await window.mirror.listAndroidDevices().catch(() => [])).find((d) => d.state === 'device')
          device = ready?.serial ?? null
          setTarget(device)
        }
        const result = await window.mirror.runDoctorCheck(check, device)
        if (runId.current !== id) return
        setRows((r) => ({ ...r, [check]: { state: 'done', result } }))
        if (result.status === 'fail' && group.blocking.includes(check)) blocked = t('doctor.fixAboveFirst')
        // No iPhone on the cable is fine over Wi-Fi; the cable checks just have nothing to test.
        if (check === 'iosCable' && result.status === 'warn') blocked = t('doctorMain.ios.noCableSkip')
      }
    }
    setRunning(false)
  }, [serial, platform])

  useEffect(() => {
    dialogRef.current?.focus()
    void runAll()
    return () => {
      runId.current++
    }
  }, [runAll])

  const applyFix = async (fix: DoctorFix) => {
    if (fix === 'start-adb') {
      await window.mirror.startAdb().catch(() => undefined)
      void runAll()
    } else if (fix === 'open-setup') {
      onOpenSetup()
    } else if (fix === 'pair-iphone') {
      setPairing(true)
    } else if (fix === 'ask-media') {
      // Explained first, then macOS asks. Only the camera: the microphone is
      // asked about when the user moves the iPhone's sound to this computer.
      await askMediaAccess(['camera'])
      void runAll()
    } else {
      // System Settings pages: changes there come back with Run again.
      await window.mirror.applyDoctorFix(fix).catch(() => undefined)
    }
  }

  const copyReport = async () => {
    await window.mirror.writeClipboardText(await buildReport(platform, rows, target))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-[oklch(0.1_0.01_260/0.45)] p-6" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="doctor-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        className="flex max-h-full w-full max-w-[600px] flex-col rounded-[var(--radius-panel)] border border-line bg-surface outline-none"
      >
        {pairing && (
          <CompanionPairing
            onClose={() => {
              setPairing(false)
              void runAll()
            }}
          />
        )}
        <div className="flex items-start justify-between gap-4 p-6 pb-4">
          <div className="flex items-start gap-3">
            <StethoscopeIcon size={22} className="mt-0.5 text-accent" />
            <div>
              <h2 id="doctor-title" className="text-lg font-semibold tracking-tight">
                {t('doctor.title')}
              </h2>
              <p className="mt-0.5 text-sm text-muted">{t('doctor.body')}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded p-1 text-muted hover:bg-fg/8 hover:text-fg">
            <XIcon size={16} />
          </button>
        </div>

        <div role="radiogroup" aria-label={t('wifi.whichPhone')} className="mx-6 mb-3 inline-flex self-start rounded-[var(--radius-control)] border border-line p-0.5">
          {(['android', 'ios'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={platform === p}
              disabled={running && platform !== p}
              onClick={() => setPlatform(p)}
              className={`inline-flex items-center gap-2 rounded-[calc(var(--radius-control)-2px)] px-3.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                platform === p ? 'bg-fg/10 text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              <BrandLogo brand={p === 'ios' ? 'apple' : 'android'} size={14} />
              {p === 'ios' ? t('common.iphone') : t('wifi.android')}
            </button>
          ))}
        </div>

        <div aria-live="polite" className="grid min-h-0 gap-3 overflow-y-auto px-4">
          {GROUPS[platform].map((group) => (
            <section key={group.checks[0]}>
              {group.title && <h3 className="px-2 pb-1 pt-1 text-xs font-medium text-muted">{t(group.title)}</h3>}
              <ol className="grid gap-1">
                {group.checks.map((id) => (
                  <CheckRow key={id} row={rows[id] ?? { state: 'pending' }} pending={t(`doctor.check.${id}`)} onFix={(f) => void applyFix(f)} />
                ))}
              </ol>
            </section>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={() => void copyReport()}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm font-medium text-muted hover:bg-fg/8 hover:text-fg disabled:opacity-50"
          >
            {copied ? <CheckCircleIcon size={16} className="text-ok" /> : <CopyIcon size={16} />}
            {copied ? t('doctor.reportCopied') : t('doctor.copyReport')}
          </button>
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={running}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
          >
            <ArrowClockwiseIcon size={16} />
            {running ? t('doctor.checking') : t('doctor.runAgain')}
          </button>
        </div>
      </div>
    </div>
  )
}

function CheckRow({ row, pending, onFix }: { row: Row; pending: string; onFix(fix: DoctorFix): void }) {
  const t = useT()
  if (row.state !== 'done') {
    return (
      <li className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-2.5">
        {row.state === 'running' ? (
          <span className="grid size-5 place-items-center">
            <span className="size-3 rounded-full bg-accent motion-safe:animate-pulse" />
          </span>
        ) : (
          <CircleDashedIcon size={20} className="text-muted" />
        )}
        <span className={`text-sm ${row.state === 'running' ? 'text-fg' : 'text-muted'}`}>{pending}</span>
      </li>
    )
  }
  const { result } = row
  const icon = {
    pass: <CheckCircleIcon size={20} weight="fill" className="text-ok" />,
    warn: <InfoIcon size={20} weight="fill" className="text-warn" />,
    fail: <WarningCircleIcon size={20} weight="fill" className="text-err" />,
    skip: <CircleDashedIcon size={20} className="text-muted" />
  }[result.status]
  return (
    <li className={`flex items-start gap-3 rounded-[var(--radius-control)] px-2 py-2.5 ${result.status === 'fail' ? 'bg-err/6' : ''}`}>
      <span className="mt-px shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm ${result.status === 'skip' ? 'text-muted' : 'font-medium'}`}>{result.title}</p>
        {result.detail && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{result.detail}</p>}
        {result.fix && (
          <button
            type="button"
            onClick={() => onFix(result.fix!)}
            className="mt-2 rounded-[var(--radius-control)] border border-line bg-bg px-2.5 py-1 text-xs font-medium hover:bg-fg/5 active:scale-[0.98]"
          >
            {t(`doctor.fix.${result.fix}`)}
          </button>
        )}
      </div>
    </li>
  )
}

function initialRows(platform: Platform): Partial<Record<DoctorCheckId, Row>> {
  return Object.fromEntries(checksOf(platform).map((id) => [id, { state: 'pending' }]))
}

/** Plain-text report for support. The serial is shortened to avoid sharing it in full. */
async function buildReport(platform: Platform, rows: Partial<Record<DoctorCheckId, Row>>, serial: string | null): Promise<string> {
  const info = await window.mirror.appInfo()
  const props = serial && platform === 'android' ? await window.mirror.deviceProps(serial).catch(() => null) : null
  const iphones = platform === 'ios' ? await window.mirror.listIosDevices().catch(() => []) : []
  const phone =
    platform === 'ios'
      ? `iPhone: ${iphones.map((d) => `${d.model ?? 'iPhone'} (${d.transport === 'usb' ? 'cable' : 'Wi-Fi'})`).join(', ') || 'none connected'}`
      : props
        ? `Phone: ${props.manufacturer} ${props.model}, Android ${props.androidVersion} (SDK ${props.sdk}), serial ${serial!.slice(0, 4)}****`
        : 'Phone: none detected'
  const lines = [
    'FreeFlect diagnostic report',
    `Generated: ${new Date().toISOString()}`,
    `App ${info.version} (native ${info.nativeVersion}, Electron ${info.electron}) on ${info.platform}${info.packaged ? '' : ', development run'}`,
    platform === 'android' ? `adb: ${info.adbPath}` : 'Checked: iPhone',
    phone,
    '',
    'Checks:'
  ]
  for (const id of checksOf(platform)) {
    const row = rows[id]
    if (!row || row.state !== 'done') {
      lines.push(`[not run] ${id}`)
      continue
    }
    const r = row.result
    lines.push(`[${r.status}] ${id}: ${r.title}${r.detail ? ` (${r.detail})` : ''}${r.raw ? `\n    ${r.raw}` : ''}`)
  }
  return lines.join('\n')
}
