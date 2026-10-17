import { ArrowClockwiseIcon, DownloadSimpleIcon, FileImageIcon, FileVideoIcon, XIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { lang, useT } from '../i18n'

type Media = { path: string; name: string; size: number; modifiedMs: number; video: boolean }

const dateFormat = { format: (ms: number) => new Intl.DateTimeFormat(lang(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms) }
const formatSize = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

/** iPhone camera roll over USB: drag photos and videos out, or save them. */
export function IosMediaPanel({ serial, onClose }: { serial: string; onClose(): void }) {
  const t = useT()
  const [items, setItems] = useState<Media[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setItems(null)
    setError(null)
    try {
      setItems(await window.mirror.listIosMedia(serial))
    } catch (e) {
      setError(String(e).replace(/^.*?Error: /, '').replace(/^\[\w+\] /, ''))
    }
  }, [serial])
  useEffect(() => void load(), [load])

  return (
    <aside aria-label={t('media.label')} className="flex w-80 shrink-0 flex-col border-s border-line bg-sidebar">
      <div className="drag flex h-12 shrink-0 items-center justify-between ps-4 pe-2">
        <h2 className="text-[15px] font-semibold tracking-tight">{t('media.title')}</h2>
        <span className="no-drag flex">
          <button type="button" onClick={() => void load()} aria-label={t('common.refresh')} title={t('common.refresh')} className="rounded p-1.5 text-muted hover:bg-fg/8 hover:text-fg">
            <ArrowClockwiseIcon size={16} />
          </button>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded p-1.5 text-muted hover:bg-fg/8 hover:text-fg">
            <XIcon size={16} />
          </button>
        </span>
      </div>
      <p className="px-4 pb-3 text-[12px] leading-relaxed text-muted">
        {t('media.hint')}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-2 py-2">
        {items === null && !error && (
          <div aria-hidden className="grid gap-1 px-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2">
                <div className="size-[18px] rounded bg-fg/8" />
                <div className="h-3 flex-1 rounded bg-fg/8" />
              </div>
            ))}
          </div>
        )}
        {error && <p className="px-3 py-6 text-[13px] leading-relaxed text-muted">{error}</p>}
        {items?.length === 0 && <p className="px-3 py-6 text-[13px] text-muted">{t('media.empty')}</p>}
        <ul className="grid gap-0.5">
          {items?.map((m) => (
            <li key={m.path} className="group relative">
              <div
                draggable
                onDragStart={(e) => {
                  e.preventDefault()
                  window.mirror.dragPhoneFile(serial, m.path)
                }}
                title={t('media.dragHint')}
                className="flex cursor-default items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5 hover:bg-fg/5"
              >
                {m.video ? <FileVideoIcon size={18} className="shrink-0 text-muted" /> : <FileImageIcon size={18} className="shrink-0 text-muted" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.name}</span>
                  <span className="block text-[11px] text-muted">
                    {formatSize(m.size)}, {dateFormat.format(m.modifiedMs)}
                  </span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => window.mirror.savePhoneFile(serial, m.path)}
                aria-label={t('media.saveFile', { name: m.name })}
                title={t('media.save')}
                className="absolute end-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-[var(--radius-control)] bg-surface text-muted opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
              >
                <DownloadSimpleIcon size={15} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
