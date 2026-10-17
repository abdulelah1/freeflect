import type { StreamStats } from '../video/protocol'
import { useT } from '../i18n'

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">
        {value}
        {unit && <span className="ms-0.5 text-muted">{unit}</span>}
      </dd>
    </div>
  )
}

export function HudStrip({ stats }: { stats: StreamStats | null }) {
  const t = useT()
  const s = stats
  return (
    <dl
      aria-label={t('hud.label')}
      className="grid grid-cols-3 gap-x-6 gap-y-3 border-t border-line bg-surface px-6 py-3 lg:grid-cols-6"
    >
      <Metric label={t('hud.fps')} value={s ? s.fps.toFixed(1) : '-'} unit="fps" />
      <Metric label={t('hud.latency')} value={s ? s.latencyMs.toFixed(1) : '-'} unit="ms" />
      <Metric label={t('hud.decode')} value={s ? s.decodeMs.toFixed(2) : '-'} unit="ms" />
      {s && s.bitrateMbps < 1 ? (
        <Metric label={t('hud.bitrate')} value={(s.bitrateMbps * 1000).toFixed(0)} unit="kbps" />
      ) : (
        <Metric label={t('hud.bitrate')} value={s ? s.bitrateMbps.toFixed(1) : '-'} unit="Mbps" />
      )}
      <Metric label={t('hud.resolution')} value={s?.width ? `${s.width}×${s.height}` : '-'} />
      <Metric label={t('hud.codec')} value={s?.codec ?? '-'} />
    </dl>
  )
}
