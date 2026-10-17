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
import type { DoctorCheckId, DoctorResult } from '../../../shared-ipc'
import { t, useT } from '../i18n'

/** Order matters: later checks only make sense once earlier ones pass. */
const CHECKS: DoctorCheckId[] = ['adb', 'device', 'authorized', 'network', 'brand', 'stream']
/** A failure here makes the remaining checks meaningless. */
const BLOCKING: DoctorCheckId[] = ['adb', 'device', 'authorized']

type Row = { state: 'pending' | 'running' } | { state: 'done'; result: DoctorResult }

interface Props {
  /** The phone to diagnose; the first ready phone is used when null. */
  serial: string | null
  onClose(): void
  onOpenSetup(): void
}

export function ConnectionDoctor({ serial, onClose, onOpenSetup }: Props) {
  const [rows, setRows] = useState<Record<DoctorCheckId, Row>>(() => initialRows())
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [target, setTarget] = useState<string | null>(serial)
  const runId = useRef(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  const runAll = useCallback(async () => {
    const id = ++runId.current
    setRunning(true)
    setRows(initialRows())
    let device = serial
    let blocked: DoctorResult | null = null
    for (const check of CHECKS) {
      if (runId.current !== id) return
      if (blocked) {
        setRows((r) => ({
          ...r,
          [check]: { state: 'done', result: { id: check, status: 'skip', title: t('doctor.fixAboveFirst') } }
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
      if (result.status === 'fail' && BLOCKING.includes(check)) blocked = result
    }
    setRunning(false)
  }, [serial])

  useEffect(() => {
    dialogRef.current?.focus()
    void runAll()
    return () => {
      runId.current++
    }
  }, [runAll])

  const applyFix = async (fix: DoctorResult['fix']) => {
    if (fix === 'start-adb') {
      await window.mirror.startAdb().catch(() => undefined)
      void runAll()
    } else if (fix === 'open-setup') {
      onOpenSetup()
    }
  }

  const copyReport = async () => {
    await window.mirror.writeClipboardText(await buildReport(rows, target))
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

        <ol aria-live="polite" className="grid min-h-0 gap-1 overflow-y-auto px-4">
          {CHECKS.map((id) => (
            <CheckRow key={id} row={rows[id]} pending={t(`doctor.check.${id}`)} onFix={(f) => void applyFix(f)} />
          ))}
        </ol>

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

function CheckRow({ row, pending, onFix }: { row: Row; pending: string; onFix(fix: DoctorResult['fix']): void }) {
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
            onClick={() => onFix(result.fix)}
            className="mt-2 rounded-[var(--radius-control)] border border-line bg-bg px-2.5 py-1 text-xs font-medium hover:bg-fg/5 active:scale-[0.98]"
          >
            {result.fix === 'start-adb' ? t('doctor.startAdb') : t('doctor.openSetup')}
          </button>
        )}
      </div>
    </li>
  )
}

function initialRows(): Record<DoctorCheckId, Row> {
  return Object.fromEntries(CHECKS.map((id) => [id, { state: 'pending' }])) as Record<DoctorCheckId, Row>
}

/** Plain-text report for support. The serial is shortened to avoid sharing it in full. */
async function buildReport(rows: Record<DoctorCheckId, Row>, serial: string | null): Promise<string> {
  const info = await window.mirror.appInfo()
  const props = serial ? await window.mirror.deviceProps(serial).catch(() => null) : null
  const lines = [
    'FreeFlect diagnostic report',
    `Generated: ${new Date().toISOString()}`,
    `App ${info.version} (native ${info.nativeVersion}, Electron ${info.electron}) on ${info.platform}`,
    `adb: ${info.adbPath}`,
    props
      ? `Phone: ${props.manufacturer} ${props.model}, Android ${props.androidVersion} (SDK ${props.sdk}), serial ${serial!.slice(0, 4)}****`
      : 'Phone: none detected',
    '',
    'Checks:'
  ]
  for (const id of CHECKS) {
    const row = rows[id]
    if (row.state !== 'done') {
      lines.push(`[not run] ${id}`)
      continue
    }
    const r = row.result
    lines.push(`[${r.status}] ${id}: ${r.title}${r.detail ? ` (${r.detail})` : ''}${r.raw ? `\n    ${r.raw}` : ''}`)
  }
  return lines.join('\n')
}
