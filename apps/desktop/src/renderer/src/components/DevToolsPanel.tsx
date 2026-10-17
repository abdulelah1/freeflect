import {
  ArrowSquareOutIcon,
  EraserIcon,
  FloppyDiskIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  StopCircleIcon,
  TrashIcon,
  XIcon
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppAction, DeviceStats } from '../../../shared-ipc'
import { useT } from '../i18n'

type Tab = 'logs' | 'apps' | 'device'
const MAX_LINES = 5000
const RENDERED_LINES = 600
const STATS_POLL_MS = 2000

interface LogLine {
  id: number
  time: string
  level: string
  tag: string
  message: string
  raw: string
}

const LEVELS = ['V', 'D', 'I', 'W', 'E'] as const
/** Translation keys of the log levels. */
const LEVEL_NAMES: Record<(typeof LEVELS)[number], string> = { V: 'devtools.level.verbose', D: 'devtools.level.debug', I: 'devtools.level.info', W: 'devtools.level.warning', E: 'devtools.level.error' }
const levelRank = (l: string) => (l === 'F' ? 5 : Math.max(0, LEVELS.indexOf(l as (typeof LEVELS)[number])))

// "10-15 00:23:50.373  2232  2232 D Tag: message"
const THREADTIME = /^\d\d-\d\d (\d\d:\d\d:\d\d\.\d{3})\s+\d+\s+\d+\s+([VDIWEF])\s+(.*?)\s*:\s(.*)$/

let nextId = 0
function parse(raw: string): LogLine {
  const m = raw.match(THREADTIME)
  return m
    ? { id: nextId++, time: m[1]!, level: m[2]!, tag: m[3]!, message: m[4]!, raw }
    : { id: nextId++, time: '', level: 'I', tag: '', message: raw, raw }
}

/** Live logs, app management and device stats for the mirrored phone. */
export function DevToolsPanel({ serial, onClose }: { serial: string; onClose(): void }) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('logs')
  return (
    <aside aria-label={t('stage.devtools')} className="flex w-[30rem] shrink-0 flex-col border-s border-line bg-sidebar">
      <div className="drag flex h-12 shrink-0 items-center justify-between ps-4 pe-2">
        <div role="tablist" aria-label={t('stage.devtools')} className="no-drag flex gap-1">
          {(['logs', 'apps', 'device'] as Tab[]).map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-[var(--radius-control)] px-2.5 py-1 text-sm font-medium ${tab === id ? 'bg-fg/8 text-fg' : 'text-muted hover:text-fg'}`}
            >
              {t(`devtools.tab.${id}`)}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} aria-label={t('devtools.close')} className="no-drag rounded p-1.5 text-muted hover:bg-fg/8 hover:text-fg">
          <XIcon size={16} />
        </button>
      </div>
      {tab === 'logs' && <LogsTab serial={serial} />}
      {tab === 'apps' && <AppsTab serial={serial} />}
      {tab === 'device' && <DeviceTab serial={serial} />}
    </aside>
  )
}

function LogsTab({ serial }: { serial: string }) {
  const t = useT()
  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const [minLevel, setMinLevel] = useState<(typeof LEVELS)[number]>('I')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    setLines([])
    const off = window.mirror.onLogcat((s, batch) => {
      if (s !== serial || pausedRef.current) return
      setLines((prev) => [...prev, ...batch.map(parse)].slice(-MAX_LINES))
    })
    window.mirror.startLogcat(serial).catch((e: unknown) => setError(String(e)))
    return () => {
      off()
      window.mirror.stopLogcat()
    }
  }, [serial])

  const matcher = useMemo(() => {
    const q = query.trim()
    if (!q) return null
    // /pattern/ searches with a regular expression; anything else is plain text.
    const re = q.match(/^\/(.+)\/$/)
    if (re) {
      try {
        return new RegExp(re[1]!, 'i')
      } catch {
        return null
      }
    }
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }, [query])

  const visible = useMemo(
    () => lines.filter((l) => levelRank(l.level) >= levelRank(minLevel) && (!matcher || matcher.test(l.raw))).slice(-RENDERED_LINES),
    [lines, minLevel, matcher]
  )

  useEffect(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [visible])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-y border-line px-3 py-2">
        <label className="sr-only" htmlFor="log-search">
          {t('devtools.searchLogs')}
        </label>
        <input
          id="log-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('devtools.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-bg px-2 py-1 text-xs placeholder:text-muted"
        />
        <label className="sr-only" htmlFor="log-level">
          {t('devtools.minLevel')}
        </label>
        <select
          id="log-level"
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as (typeof LEVELS)[number])}
          className="rounded-[var(--radius-control)] border border-line bg-bg px-1.5 py-1 text-xs"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {t(LEVEL_NAMES[l])}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          aria-label={paused ? t('devtools.resumeLogs') : t('devtools.pauseLogs')}
          aria-pressed={paused}
          title={paused ? t('devtools.resume') : t('devtools.pause')}
          className={`grid size-7 place-items-center rounded-[var(--radius-control)] ${paused ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-fg/8 hover:text-fg'}`}
        >
          {paused ? <PlayIcon size={14} weight="fill" /> : <PauseIcon size={14} weight="fill" />}
        </button>
        <button type="button" onClick={() => setLines([])} aria-label={t('devtools.clearLogs')} title={t('devtools.clear')} className="grid size-7 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-fg/8 hover:text-fg">
          <EraserIcon size={15} />
        </button>
        <button
          type="button"
          onClick={() => void window.mirror.saveLog(visible.map((l) => l.raw).join('\n'))}
          aria-label={t('devtools.saveLogs')}
          title={t('devtools.saveLogsHint')}
          className="grid size-7 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-fg/8 hover:text-fg"
        >
          <FloppyDiskIcon size={15} />
        </button>
      </div>
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="min-h-0 flex-1 select-text overflow-y-auto px-2 py-1 font-mono text-[11px] leading-[1.45]"
      >
        {error && <p className="p-2 text-err">{error}</p>}
        {!error && visible.length === 0 && <p className="p-2 font-sans text-xs text-muted">{lines.length ? 'No lines match.' : 'Waiting for logs'}</p>}
        {visible.map((l) => {
          const crash = l.level === 'F' || l.message.includes('FATAL EXCEPTION') || (l.tag === 'AndroidRuntime' && l.level === 'E')
          return (
            <div key={l.id} className={`flex gap-2 rounded px-1 ${crash ? 'bg-err/12' : ''}`}>
              <span className="shrink-0 text-muted">{l.time}</span>
              <span className={`w-3 shrink-0 font-semibold ${l.level === 'E' || l.level === 'F' ? 'text-err' : l.level === 'W' ? 'text-warn' : 'text-muted'}`}>{l.level}</span>
              <span className="min-w-0 break-words">
                {l.tag && <span className="text-accent">{l.tag} </span>}
                {l.message}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AppsTab({ serial }: { serial: string }) {
  const t = useT()
  const [apps, setApps] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<{ pkg: string; action: 'clear' | 'uninstall' } | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const load = () => {
    setApps(null)
    window.mirror.listApps(serial).then(setApps, () => setApps([]))
  }
  useEffect(load, [serial])

  const run = async (pkg: string, action: AppAction) => {
    setConfirm(null)
    try {
      await window.mirror.appAction(serial, pkg, action)
      setMessage({ tone: 'ok', text: t(`devtools.done.${action}`, { pkg }) })
      if (action === 'uninstall') load()
    } catch (e) {
      setMessage({ tone: 'err', text: String(e).replace(/^.*?Error: /, '') })
    }
  }

  const shown = (apps ?? []).filter((a) => a.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-y border-line px-3 py-2">
        <label className="sr-only" htmlFor="app-search">
          {t('devtools.searchApps')}
        </label>
        <input
          id="app-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('devtools.searchAppsPlaceholder')}
          className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-bg px-2 py-1 text-xs placeholder:text-muted"
        />
        <button
          type="button"
          onClick={() => void window.mirror.installApkDialog(serial).then(load)}
          className="inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
        >
          <PlusIcon size={12} weight="bold" />
          {t('devtools.installApk')}
        </button>
      </div>
      {message && (
        <p role="status" className={`px-4 py-2 text-xs ${message.tone === 'ok' ? 'text-ok' : 'text-err'}`}>
          {message.text}
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {apps === null && <li className="p-2 text-xs text-muted">{t('devtools.loadingApps')}</li>}
        {apps?.length === 0 && <li className="p-2 text-xs text-muted">{t('devtools.noApps')}</li>}
        {shown.map((pkg) => (
          <li key={pkg} className="group flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-2 py-1.5 hover:bg-fg/5">
            <span className="min-w-0 truncate font-mono text-xs">{pkg}</span>
            {confirm?.pkg === pkg ? (
              <span className="flex shrink-0 items-center gap-1 text-xs">
                {confirm.action === 'clear' ? t('devtools.confirmClear') : t('devtools.confirmUninstall')}
                <button type="button" onClick={() => void run(pkg, confirm.action)} className="rounded px-1.5 py-0.5 font-medium text-err hover:bg-err/10">
                  {t('common.yes')}
                </button>
                <button type="button" onClick={() => setConfirm(null)} className="rounded px-1.5 py-0.5 hover:bg-fg/8">
                  {t('common.no')}
                </button>
              </span>
            ) : (
              <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <AppButton label={t('devtools.open')} onClick={() => void run(pkg, 'launch')} icon={<ArrowSquareOutIcon size={14} />} />
                <AppButton label={t('devtools.forceStop')} onClick={() => void run(pkg, 'stop')} icon={<StopCircleIcon size={14} />} />
                <AppButton label={t('devtools.clearData')} onClick={() => setConfirm({ pkg, action: 'clear' })} icon={<EraserIcon size={14} />} />
                <AppButton label={t('devtools.uninstall')} danger onClick={() => setConfirm({ pkg, action: 'uninstall' })} icon={<TrashIcon size={14} />} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function AppButton(props: { label: string; onClick(): void; icon: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      className={`grid size-7 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-fg/8 ${props.danger ? 'hover:text-err' : 'hover:text-fg'}`}
    >
      {props.icon}
    </button>
  )
}

function DeviceTab({ serial }: { serial: string }) {
  const t = useT()
  const [stats, setStats] = useState<DeviceStats | null>(null)
  useEffect(() => {
    let alive = true
    const poll = () => window.mirror.deviceStats(serial).then((s) => alive && setStats(s), () => undefined)
    void poll()
    const id = setInterval(poll, STATS_POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [serial])

  const fmt = (v: number | null | undefined, unit: string, digits = 0) => (v == null || Number.isNaN(v) ? '-' : `${v.toFixed(digits)}${unit}`)
  return (
    <div className="grid grid-cols-2 gap-px border-t border-line bg-line">
      <Metric label={t('devtools.cpu')} value={fmt(stats?.cpuPercent, '%')} />
      <Metric
        label={t('devtools.memory')}
        value={fmt(stats?.memoryUsedPercent, '%')}
        note={stats?.memoryTotalMb ? t('devtools.memoryOf', { gb: (stats.memoryTotalMb / 1024).toFixed(1) }) : undefined}
      />
      <Metric label={t('devtools.battery')} value={fmt(stats?.batteryPercent, '%')} />
      <Metric label={t('devtools.batteryTemp')} value={fmt(stats?.batteryTempC, ' °C', 1)} />
    </div>
  )
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-sidebar px-4 py-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-mono text-xl tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-[11px] text-muted">{note}</p>}
    </div>
  )
}
