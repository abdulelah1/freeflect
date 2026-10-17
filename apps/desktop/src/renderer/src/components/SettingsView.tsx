import { ArrowCounterClockwiseIcon, FolderOpenIcon, FolderSimpleIcon, TrashIcon, XIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import type { AppSettings, FolderSetting } from '../../../shared-ipc'
import { BrandLogo } from './BrandLogo'
import { CompanionInstaller } from './CompanionInstaller'
import { availableLanguages } from '../../../i18n'
import { useT } from '../i18n'

interface Props {
  onClose(): void
  /** Sound lives in the window (it is a playback choice), so it is passed in. */
  audioOnComputer: boolean
  onToggleAudio(): void
}

/** App settings: where things are saved, file sharing, clipboard, full screen, the iPhone app. */
export function SettingsView({ onClose, audioOnComputer, onToggleAudio }: Props) {
  const t = useT()
  const [s, setS] = useState<AppSettings | null>(null)
  const [defaults, setDefaults] = useState<AppSettings | null>(null)

  useEffect(() => {
    void window.mirror.getSettings().then(setS)
    void window.mirror.getDefaultSettings().then(setDefaults)
    return window.mirror.onSettingsChanged(setS)
  }, [])

  const set = useCallback((patch: Partial<AppSettings>) => void window.mirror.setSettings(patch).then(setS), [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-30 flex flex-col bg-bg"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <header className="drag flex h-12 shrink-0 items-center justify-end pe-4">
        <button
          type="button"
          onClick={onClose}
          className="no-drag inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-fg/8 hover:text-fg"
        >
          <XIcon size={14} />
          {t('settings.close')}
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 pb-16">
          <h1 id="settings-title" className="text-2xl font-semibold tracking-tight">
            {t('settings.title')}
          </h1>
          {!s || !defaults ? (
            <SettingsSkeleton />
          ) : (
            <>
              <Section title={t('settings.language.title')}>
                <LanguageField value={s.language} onChange={(language) => set({ language })} />
              </Section>

              <Section title={t('settings.saving.title')}>
                <FolderRow
                  setting="screenshotsDir"
                  label={t('settings.saving.screenshots')}
                  value={s.screenshotsDir}
                  defaultValue={defaults.screenshotsDir}
                  onChange={setS}
                  onReset={() => set({ screenshotsDir: defaults.screenshotsDir })}
                />
                <FolderRow
                  setting="recordingsDir"
                  label={t('settings.saving.recordings')}
                  value={s.recordingsDir}
                  defaultValue={defaults.recordingsDir}
                  onChange={setS}
                  onReset={() => set({ recordingsDir: defaults.recordingsDir })}
                />
                <FolderRow
                  setting="receivedFilesDir"
                  label={t('settings.saving.received')}
                  hint={t('settings.saving.receivedHint')}
                  value={s.receivedFilesDir}
                  defaultValue={defaults.receivedFilesDir}
                  onChange={setS}
                  onReset={() => set({ receivedFilesDir: defaults.receivedFilesDir })}
                />
              </Section>

              <Section title={t('settings.sending.title')}>
                <AndroidFolderField value={s.androidFolder} defaultValue={defaults.androidFolder} onSave={(androidFolder) => set({ androidFolder })} />
                <div className="flex items-start gap-3 py-4">
                  <BrandLogo brand="apple" size={18} className="mt-0.5 shrink-0 text-muted" />
                  <div>
                    <p className="text-sm font-medium">{t('common.iphone')}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
                      {t('settings.sending.iphoneHint')}
                    </p>
                  </div>
                </div>
              </Section>

              <Section title={t('settings.clipboard.title')}>
                <ToggleRow
                  label={t('settings.clipboard.share')}
                  hint={t('settings.clipboard.shareHint')}
                  checked={s.clipboardSync}
                  onChange={(clipboardSync) => set({ clipboardSync })}
                />
                <ToggleRow
                  label={t('settings.clipboard.sound')}
                  hint={t('settings.clipboard.soundHint')}
                  checked={audioOnComputer}
                  onChange={onToggleAudio}
                />
              </Section>

              <Section title={t('settings.fullscreen.title')}>
                <ToggleRow
                  label={t('settings.fullscreen.only')}
                  hint={t('settings.fullscreen.onlyHint')}
                  checked={s.hideChromeInFullscreen}
                  onChange={(hideChromeInFullscreen) => set({ hideChromeInFullscreen })}
                />
              </Section>

              <Section title={t('settings.companion.title')}>
                <ToggleRow
                  label={t('settings.companion.allow')}
                  hint={t('settings.companion.allowHint')}
                  checked={s.companionEnabled}
                  onChange={(companionEnabled) => set({ companionEnabled })}
                />
                <AllowedPhones />
                <div className="grid gap-3 py-4">
                  <div>
                    <p className="text-sm font-medium">{t('settings.companion.install')}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
                      {t('settings.companion.installHint')}
                    </p>
                  </div>
                  <CompanionInstaller />
                </div>
              </Section>

              <Section title={t('settings.updates.title')}>
                <ToggleRow
                  label={t('settings.updates.check')}
                  hint={t('settings.updates.checkHint', { app: t('app.name') })}
                  checked={s.checkForUpdates}
                  onChange={(checkForUpdates) => set({ checkForUpdates })}
                />
              </Section>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

/** Languages come from the files in src/locales; "system" follows the computer's language. */
function LanguageField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const t = useT()
  const id = useId()
  const languages = availableLanguages()
  return (
    <div className="grid gap-2 py-4">
      <label htmlFor={id} className="text-sm font-medium">
        {t('settings.language.label')}
      </label>
      <select
        id={id}
        value={languages.some((l) => l.code === value) ? value : 'system'}
        onChange={(e) => onChange(e.target.value)}
        className="w-full max-w-xs rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
      >
        <option value="system">{t('settings.language.system')}</option>
        {languages.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.name}
          </option>
        ))}
      </select>
      <p className="text-[13px] text-muted">{t('settings.language.hint')}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-2 divide-y divide-line border-y border-line">{children}</div>
    </section>
  )
}

function FolderRow(props: {
  setting: FolderSetting
  label: string
  hint?: string
  value: string
  defaultValue: string
  onChange(s: AppSettings): void
  onReset(): void
}) {
  const t = useT()
  const isDefault = props.value === props.defaultValue
  return (
    <div className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <p className="text-sm font-medium">{props.label}</p>
        {props.hint && <p className="mt-0.5 text-[13px] text-muted">{props.hint}</p>}
        <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted" title={props.value}>
          <FolderSimpleIcon size={14} className="shrink-0" />
          <span className="truncate font-mono text-xs" dir="ltr">
            {props.value}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!isDefault && (
          <button type="button" onClick={props.onReset} title={t('settings.folder.useDefault')} aria-label={t('settings.folder.useDefaultFor', { label: props.label })} className={iconButton}>
            <ArrowCounterClockwiseIcon size={15} />
          </button>
        )}
        <button
          type="button"
          onClick={() => void window.mirror.openSettingsFolder(props.setting)}
          title={t('settings.folder.open')}
          aria-label={t('settings.folder.openFor', { label: props.label })}
          className={iconButton}
        >
          <FolderOpenIcon size={15} />
        </button>
        <button type="button" onClick={() => void window.mirror.chooseSettingsFolder(props.setting).then(props.onChange)} className={secondaryButton}>
          {t('settings.folder.change')}
        </button>
      </div>
    </div>
  )
}

function AndroidFolderField({ value, defaultValue, onSave }: { value: string; defaultValue: string; onSave(v: string): void }) {
  const t = useT()
  const id = useId()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const valid = /^\/(sdcard|storage)\/[^]*$/.test(draft) && !draft.split('/').includes('..')
  const save = () => {
    if (valid && draft !== value) onSave(draft)
  }
  return (
    <div className="grid gap-2 py-4">
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
        <BrandLogo brand="android" size={16} />
        {t('settings.sending.androidFolder')}
      </label>
      <div className="flex gap-1.5">
        <input
          id={id}
          dir="ltr"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          aria-invalid={!valid}
          aria-describedby={`${id}-hint`}
          className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 font-mono text-[13px] outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 aria-[invalid=true]:border-err"
        />
        {value !== defaultValue && (
          <button type="button" onClick={() => onSave(defaultValue)} title={t('settings.folder.useDefault')} aria-label={t('settings.sending.androidDefault')} className={iconButton}>
            <ArrowCounterClockwiseIcon size={15} />
          </button>
        )}
      </div>
      <p id={`${id}-hint`} className={`text-[13px] ${valid ? 'text-muted' : 'text-err'}`}>
        {valid
          ? t('settings.sending.androidHint')
          : t('settings.sending.androidInvalid')}
      </p>
    </div>
  )
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange(v: boolean): void }) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div>
        <p id={id} className="text-sm font-medium">
          {label}
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-fg/15'}`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${
            checked ? 'translate-x-[18px] rtl:-translate-x-[18px]' : 'translate-x-0.5 rtl:-translate-x-0.5'
          } start-0`}
        />
      </button>
    </div>
  )
}

function AllowedPhones() {
  const [phones, setPhones] = useState<{ deviceId: string; name: string }[] | null>(null)
  const t = useT()
  const load = useCallback(() => void window.mirror.listCompanionDevices().then(setPhones), [])
  useEffect(load, [load])
  return (
    <div className="py-4">
      <p className="text-sm font-medium">{t('settings.companion.allowed')}</p>
      {phones === null ? (
        <div aria-hidden className="mt-3 h-9 w-56 rounded-[var(--radius-control)] bg-fg/6" />
      ) : phones.length === 0 ? (
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
          {t('settings.companion.allowedEmpty')}
        </p>
      ) : (
        <ul className="mt-2 grid gap-1">
          {phones.map((p) => (
            <li key={p.deviceId} className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-2 py-1.5 hover:bg-fg/4">
              <span className="flex min-w-0 items-center gap-2.5 text-sm">
                <BrandLogo brand="apple" size={15} className="shrink-0 text-muted" />
                <span className="truncate">{p.name}</span>
              </span>
              <button
                type="button"
                onClick={() => void window.mirror.forgetCompanionDevice(p.deviceId).then(load)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1 text-xs font-medium text-muted hover:bg-err/10 hover:text-err"
              >
                <TrashIcon size={13} />
                {t('settings.companion.forget')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SettingsSkeleton() {
  return (
    <div aria-hidden className="mt-10 grid gap-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid gap-2">
          <div className="h-3.5 w-24 rounded bg-fg/8" />
          <div className="h-16 rounded-[var(--radius-control)] bg-fg/5" />
        </div>
      ))}
    </div>
  )
}

const iconButton =
  'grid size-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-fg/8 hover:text-fg active:scale-[0.96]'
const secondaryButton =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-xs font-medium hover:bg-fg/5 active:scale-[0.98]'
