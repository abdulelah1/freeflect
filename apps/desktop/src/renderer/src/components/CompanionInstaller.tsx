import { ArrowClockwiseIcon, CheckCircleIcon, DownloadSimpleIcon, LifebuoyIcon, ShieldCheckIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useCallback, useEffect, useId, useState } from 'react'
import { lang, t as translate, useT } from '../i18n'
import type { CompanionInstall, CompanionInstallProgress, InstallTarget, ProvisioningProfile, SigningTeam } from '../../../shared-ipc'

type Info = Awaited<ReturnType<typeof window.mirror.companionInstallInfo>>
type Method = 'team' | 'profile'

const formatDate = (ms: number) => new Intl.DateTimeFormat(lang(), { dateStyle: 'medium' }).format(ms)

/**
 * Builds the FreeFlect iPhone app with the signing the user chooses, an Apple
 * ID in Xcode or a provisioning profile, and installs it on a connected
 * iPhone. Nothing is chosen for the user: it's an open-source app and
 * everyone signs it with their own account.
 */
export function CompanionInstaller({ onInstalled }: { onInstalled?(): void }) {
  const t = useT()
  const signId = useId()
  const phoneId = useId()
  const [info, setInfo] = useState<Info | null>(null)
  const [method, setMethod] = useState<Method>('team')
  const [team, setTeam] = useState('')
  const [profile, setProfile] = useState('')
  const [phone, setPhone] = useState('')
  const [progress, setProgress] = useState<CompanionInstallProgress | null>(null)

  const load = useCallback(async () => {
    setInfo(null)
    const [next, settings] = await Promise.all([window.mirror.companionInstallInfo(), window.mirror.getSettings()])
    setInfo(next)
    // Bring back the last choice the user made, if it still exists.
    const last = settings.companionSigning
    if (last?.kind === 'team' && next.teams.some((x) => x.id === last.teamId)) {
      setMethod('team')
      setTeam((v) => v || last.teamId)
    } else if (last?.kind === 'profile' && next.profiles.some((x) => x.uuid === last.uuid)) {
      setMethod('profile')
      setProfile((v) => v || last.uuid)
    } else if (next.teams.length === 0 && next.profiles.length > 0) {
      setMethod('profile')
    }
    setPhone((v) => (next.devices.some((d) => d.udid === v) ? v : next.devices.length === 1 ? next.devices[0]!.udid : ''))
  }, [])

  useEffect(() => {
    void load()
    return window.mirror.onCompanionInstallProgress((p) => {
      setProgress(p)
      if (p.stage === 'done') onInstalled?.()
    })
  }, [load, onInstalled])

  const busy = progress !== null && progress.stage !== 'done' && progress.stage !== 'error'
  const chosen = method === 'team' ? team : profile
  const start = () => {
    if (!chosen || !phone) return
    const signing = method === 'team' ? ({ kind: 'team', teamId: team } as const) : ({ kind: 'profile', uuid: profile } as const)
    void window.mirror.setSettings({ companionSigning: signing })
    setProgress({ stage: 'preparing', message: t('installer.preparing') })
    void window.mirror.installCompanion(signing, phone)
  }

  if (!info) return <InstallerSkeleton />
  if (info.problem) return <Notice tone="warn">{info.problem}</Notice>
  if (!info.available) return <Notice tone="warn">{t('installer.missingProject')}</Notice>
  const selectedTeam = info.teams.find((x) => x.id === team)
  const selectedProfile = info.profiles.find((x) => x.uuid === profile)
  const profileProblem = selectedProfile && phone ? profileIssue(selectedProfile, phone) : null

  return (
    <div className="grid gap-4">
      <div role="radiogroup" aria-label={t('installer.methodLabel')} className="inline-flex w-fit rounded-[var(--radius-control)] border border-line bg-surface p-0.5">
        {(['team', 'profile'] as Method[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={method === m}
            disabled={busy}
            onClick={() => setMethod(m)}
            className={`rounded-[6px] px-3 py-1.5 text-xs font-medium ${method === m ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}
          >
            {t(`installer.method.${m}`)}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <label htmlFor={signId} className="text-sm font-medium">
            {method === 'team' ? t('installer.team') : t('installer.profile')}
          </label>
          {method === 'team' ? (
            info.teams.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-muted">{t('installer.noTeams')}</p>
            ) : (
              <select id={signId} value={team} disabled={busy} onChange={(e) => setTeam(e.target.value)} className={selectClass}>
                <option value="" disabled>
                  {t('installer.chooseTeam')}
                </option>
                {info.teams.map((x) => (
                  <option key={x.id} value={x.id}>
                    {teamLabel(x)}
                  </option>
                ))}
              </select>
            )
          ) : info.profiles.length === 0 ? (
            <p className="text-[13px] leading-relaxed text-muted">{t('installer.noProfiles')}</p>
          ) : (
            <select id={signId} value={profile} disabled={busy} onChange={(e) => setProfile(e.target.value)} className={selectClass}>
              <option value="" disabled>
                {t('installer.chooseProfile')}
              </option>
              {info.profiles.map((x) => (
                <option key={x.uuid} value={x.uuid}>
                  {profileLabel(x, phone)}
                </option>
              ))}
            </select>
          )}
          {method === 'team' && selectedTeam && (
            <p className="text-[13px] text-muted">{selectedTeam.free ? t('installer.freeTeam') : t('installer.paidTeam')}</p>
          )}
          {method === 'profile' && selectedProfile && (
            <p className={`text-[13px] ${profileProblem ? 'text-warn' : 'text-muted'}`}>
              {profileProblem ?? t('installer.profileInfo', { team: selectedProfile.teamName, id: selectedProfile.appId, date: formatDate(selectedProfile.expiresAt) })}
            </p>
          )}
        </div>
        <div className="grid content-start gap-2">
          <label htmlFor={phoneId} className="text-sm font-medium">
            {t('common.iphone')}
          </label>
          {info.devices.length === 0 ? (
            <p className="text-[13px] leading-relaxed text-muted">{t('installer.noPhones')}</p>
          ) : (
            <select id={phoneId} value={phone} disabled={busy} onChange={(e) => setPhone(e.target.value)} className={selectClass}>
              <option value="" disabled>
                {t('installer.choosePhone')}
              </option>
              {info.devices.map((d) => (
                <option key={d.udid} value={d.udid}>
                  {phoneLabel(d)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <SigningHelp method={method} open={method === 'team' ? info.teams.length === 0 : info.profiles.length === 0} />

      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <button type="button" onClick={() => window.mirror.cancelCompanionInstall()} className={secondaryButton}>
            {t('common.cancel')}
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={!chosen || !phone || !!profileProblem}
            className="inline-flex items-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
          >
            <DownloadSimpleIcon size={16} />
            {t('installer.install')}
          </button>
        )}
        <button type="button" onClick={() => void load()} disabled={busy} className={secondaryButton}>
          <ArrowClockwiseIcon size={14} />
          {t('common.refresh')}
        </button>
        {busy && (
          <span role="status" className="inline-flex items-center gap-2 text-[13px] text-muted">
            <span className="size-2 rounded-full bg-accent motion-safe:animate-pulse" />
            {t('installer.busy', { message: progress?.message ?? '' })}
          </span>
        )}
      </div>

      {progress?.stage === 'error' && (
        <div role="alert" className="grid gap-2">
          <Notice tone="err">{progress.message}</Notice>
          {progress.log && (
            <details className="text-xs text-muted">
              <summary className="cursor-default">{t('common.details')}</summary>
              <pre dir="ltr" className="mt-2 max-h-56 overflow-auto rounded-[var(--radius-control)] border border-line bg-surface p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                {progress.log}
              </pre>
            </details>
          )}
        </div>
      )}

      {progress?.stage === 'done' && <Installed install={progress.install} needsTrust={progress.needsTrust} />}
      {!progress && info.last && <LastInstall install={info.last} />}
    </div>
  )
}

/** Steps for each signing method; open on its own when there is nothing to choose. */
function SigningHelp({ method, open }: { method: Method; open: boolean }) {
  const t = useT()
  const steps = method === 'team' ? ['team1', 'team2', 'team3', 'team4'] : ['profile1', 'profile2', 'profile3', 'profile4', 'profile5']
  return (
    <details key={`${method}-${open}`} open={open} className="rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3">
      <summary className="flex cursor-default items-center gap-2 text-sm font-medium">
        <LifebuoyIcon size={16} className="text-muted" />
        {method === 'team' ? t('installer.help.teamTitle') : t('installer.help.profileTitle')}
      </summary>
      <ol className="mt-3 grid list-decimal gap-1.5 ps-5 text-[13px] leading-relaxed text-muted">
        {steps.map((k) => (
          <li key={k}>{t(`installer.help.${k}`)}</li>
        ))}
      </ol>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        {method === 'team' ? t('installer.help.teamNote') : t('installer.help.profileNote')}
      </p>
    </details>
  )
}

/** Why a profile can't install on this iPhone, or null. */
function profileIssue(p: ProvisioningProfile, udid: string): string | null {
  if (p.expiresAt <= Date.now()) return translate('installer.profileExpired', { date: formatDate(p.expiresAt) })
  if (!p.allDevices && !p.devices.includes(udid)) return translate('installer.profileNoDevice')
  return null
}

function Installed({ install, needsTrust }: { install: CompanionInstall; needsTrust: boolean }) {
  const t = useT()
  return (
    <div className="grid gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <CheckCircleIcon size={18} weight="fill" className="text-ok" />
        {t('installer.installedOn', { device: install.deviceName })}
      </p>
      {needsTrust ? (
        <div className="grid gap-2 text-[13px] leading-relaxed">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheckIcon size={16} className="text-accent" />
            {t('installer.trustTitle')}
          </p>
          <ol className="grid list-decimal gap-1 ps-5 text-muted">
            <li>{t('installer.trust1')}</li>
            <li>{t('installer.trust2')}</li>
            <li>{t('installer.trust3')}</li>
          </ol>
        </div>
      ) : (
        <p className="text-[13px] text-muted">{t('installer.opened')}</p>
      )}
      {install.expiresAt && (
        <p className="text-[13px] text-muted">{t('installer.reinstallBy', { date: formatDate(install.expiresAt) })}</p>
      )}
    </div>
  )
}

function LastInstall({ install }: { install: CompanionInstall }) {
  const t = useT()
  const expired = install.expiresAt !== null && install.expiresAt < Date.now()
  return (
    <p className={`text-[13px] ${expired ? 'text-warn' : 'text-muted'}`}>
      {t('installer.last', { device: install.deviceName, team: install.teamName, date: formatDate(install.installedAt) })}
      {install.expiresAt && ` ${expired ? t('installer.expired') : t('installer.expires', { date: formatDate(install.expiresAt) })}`}
    </p>
  )
}

function Notice({ tone, children }: { tone: 'warn' | 'err'; children: string }) {
  return (
    <p className={`flex items-start gap-2 text-[13px] leading-relaxed ${tone === 'err' ? 'text-err' : 'text-warn'}`}>
      <WarningCircleIcon size={16} className="mt-0.5 shrink-0" />
      {children}
    </p>
  )
}

function InstallerSkeleton() {
  return (
    <div aria-hidden className="grid gap-3 sm:grid-cols-2">
      <div className="h-[58px] rounded-[var(--radius-control)] bg-fg/6" />
      <div className="h-[58px] rounded-[var(--radius-control)] bg-fg/6" />
    </div>
  )
}

const profileLabel = (p: ProvisioningProfile, udid: string) => {
  const issue = udid ? profileIssue(p, udid) : null
  return `${p.name} (${p.teamName})${issue ? `, ${issue}` : ''}`
}
const teamLabel = (team: SigningTeam) => `${team.name} (${team.free ? translate('installer.free') : translate('installer.paid')})`
const phoneLabel = (d: InstallTarget) => `${d.name}${d.model ? `, ${d.model}` : ''}${d.wired ? '' : ` (${translate('common.wifi')})`}`

const selectClass =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-60'
const secondaryButton =
  'inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-xs font-medium hover:bg-fg/5 active:scale-[0.98] disabled:opacity-50'
