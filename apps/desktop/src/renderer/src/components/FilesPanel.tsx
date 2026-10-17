import {
  CaretRightIcon,
  DownloadSimpleIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  HouseIcon,
  TrashIcon,
  XIcon
} from '@phosphor-icons/react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PhoneFile } from '../../../shared-ipc'
import { lang, useT } from '../i18n'

const ROOT = '/sdcard'
const PLACES: { label: string; path: string }[] = [
  { label: 'files.place.download', path: '/sdcard/Download' },
  { label: 'files.place.camera', path: '/sdcard/DCIM/Camera' },
  { label: 'files.place.screenshots', path: '/sdcard/DCIM/Screenshots' },
  { label: 'files.place.documents', path: '/sdcard/Documents' }
]

const join = (dir: string, name: string) => `${dir.replace(/\/$/, '')}/${name}`

function fileIcon(f: PhoneFile): ReactNode {
  if (f.isDir) return <FolderIcon size={18} weight="fill" className="text-accent" />
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(ext)) return <FileImageIcon size={18} className="text-muted" />
  if (['mp4', 'mkv', 'mov', 'webm', '3gp'].includes(ext)) return <FileVideoIcon size={18} className="text-muted" />
  if (['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac', 'opus'].includes(ext)) return <FileAudioIcon size={18} className="text-muted" />
  if (['txt', 'pdf', 'doc', 'docx', 'md', 'csv', 'json'].includes(ext)) return <FileTextIcon size={18} className="text-muted" />
  return <FileIcon size={18} className="text-muted" />
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

const dateFormat = { format: (ms: number) => new Intl.DateTimeFormat(lang(), { dateStyle: 'medium' }).format(ms) }

/** Browse the phone's storage; drag files out, save or delete them. */
export function FilesPanel({ serial, onClose }: { serial: string; onClose(): void }) {
  const t = useT()
  const [path, setPath] = useState(ROOT)
  const [files, setFiles] = useState<PhoneFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(
    async (dir: string) => {
      setFiles(null)
      setError(null)
      setConfirming(null)
      try {
        // Hidden files (dot-files) are app internals; keep the list tidy.
        setFiles((await window.mirror.listPhoneDir(serial, dir)).filter((f) => !f.name.startsWith('.')))
      } catch {
        setError(t('files.cantOpen'))
      }
    },
    [serial]
  )

  useEffect(() => void load(path), [load, path])

  const crumbs = path
    .replace(/^\/sdcard/, '')
    .split('/')
    .filter(Boolean)
  const remove = async (name: string) => {
    await window.mirror.deletePhoneFile(serial, join(path, name)).catch(() => undefined)
    void load(path)
  }

  return (
    <aside aria-label={t('stage.files')} className="flex w-80 shrink-0 flex-col border-s border-line bg-sidebar">
      <div className="drag flex h-12 shrink-0 items-center justify-between ps-4 pe-2">
        <h2 className="text-[15px] font-semibold tracking-tight">{t('stage.files')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('files.close')}
          className="no-drag rounded p-1.5 text-muted hover:bg-fg/8 hover:text-fg"
        >
          <XIcon size={16} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 px-3 pb-3">
        {PLACES.map((p) => (
          <button
            key={p.path}
            type="button"
            onClick={() => setPath(p.path)}
            className={`rounded-[var(--radius-control)] border px-2 py-1 text-xs font-medium transition-colors ${
              path === p.path ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-fg/5'
            }`}
          >
            {t(p.label)}
          </button>
        ))}
      </div>

      <nav aria-label={t('files.path')} className="flex flex-wrap items-center gap-0.5 border-t border-line px-3 py-2 text-xs">
        <button type="button" onClick={() => setPath(ROOT)} aria-label={t('files.storage')} className="rounded p-1 text-muted hover:bg-fg/8 hover:text-fg">
          <HouseIcon size={14} />
        </button>
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`} className="inline-flex items-center gap-0.5">
            <CaretRightIcon size={10} className="text-muted rtl:-scale-x-100" />
            <button
              type="button"
              onClick={() => setPath(`${ROOT}/${crumbs.slice(0, i + 1).join('/')}`)}
              className={`max-w-28 truncate rounded px-1 py-0.5 hover:bg-fg/8 ${i === crumbs.length - 1 ? 'font-medium' : 'text-muted'}`}
            >
              {c}
            </button>
          </span>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {files === null && !error && (
          <div aria-hidden className="grid gap-1 px-1 pt-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2">
                <div className="size-[18px] rounded bg-fg/8" />
                <div className="h-3 flex-1 rounded bg-fg/8" />
              </div>
            ))}
          </div>
        )}
        {error && <p className="px-3 py-6 text-[13px] leading-relaxed text-muted">{error}</p>}
        {files?.length === 0 && <p className="px-3 py-6 text-[13px] text-muted">{t('files.empty')}</p>}
        <ul className="grid gap-0.5">
          {files?.map((f) => {
            const full = join(path, f.name)
            return (
              <li key={f.name} className="group relative">
                <div
                  role="button"
                  tabIndex={0}
                  draggable={!f.isDir}
                  onDragStart={(e) => {
                    e.preventDefault()
                    window.mirror.dragPhoneFile(serial, full)
                  }}
                  onDoubleClick={() => f.isDir && setPath(full)}
                  onKeyDown={(e) => e.key === 'Enter' && f.isDir && setPath(full)}
                  title={f.isDir ? t('files.openHint') : t('media.dragHint')}
                  className="flex cursor-default items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5 hover:bg-fg/5"
                >
                  <span className="shrink-0">{fileIcon(f)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{f.name}</span>
                    {!f.isDir && (
                      <span className="block text-[11px] text-muted">
                        {formatSize(f.size)}, {dateFormat.format(f.modifiedMs)}
                      </span>
                    )}
                  </span>
                </div>
                {confirming === f.name ? (
                  <span className="absolute end-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-[var(--radius-control)] bg-surface px-1.5 py-1 text-xs shadow">
                    {t('files.confirmDelete')}
                    <button type="button" onClick={() => void remove(f.name)} className="rounded px-1.5 py-0.5 font-medium text-err hover:bg-err/10">
                      {t('files.delete')}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="rounded px-1.5 py-0.5 hover:bg-fg/8">
                      {t('files.keep')}
                    </button>
                  </span>
                ) : (
                  <span className="absolute end-1 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                    {!f.isDir && (
                      <button
                        type="button"
                        onClick={() => window.mirror.savePhoneFile(serial, full)}
                        aria-label={t('media.saveFile', { name: f.name })}
                        title={t('media.save')}
                        className="grid size-7 place-items-center rounded-[var(--radius-control)] bg-surface text-muted hover:text-fg"
                      >
                        <DownloadSimpleIcon size={15} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirming(f.name)}
                      aria-label={t('files.deleteFile', { name: f.name })}
                      title={t('files.deleteHint')}
                      className="grid size-7 place-items-center rounded-[var(--radius-control)] bg-surface text-muted hover:text-err"
                    >
                      <TrashIcon size={15} />
                    </button>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </aside>
  )
}
