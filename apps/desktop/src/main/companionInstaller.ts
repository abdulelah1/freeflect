// Builds the Mirror iPhone app (native/ios/MirrorCompanion) for the signing
// team the user picks and installs it on a connected iPhone. The app is not
// on the App Store: Xcode on this Mac signs it with the user's own Apple ID.

import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CompanionInstall, CompanionInstallProgress, InstallTarget, ProvisioningProfile, SigningChoice, SigningTeam } from '../shared-ipc'
import { t } from './i18n'

const run = promisify(execFile)
const XCODE_PREFS = join(homedir(), 'Library/Preferences/com.apple.dt.Xcode.plist')
const PROJECT = 'native/ios/MirrorCompanion'
/** Free Apple accounts get 7-day provisioning profiles. */
const FREE_PROFILE_DAYS = 7

const workDir = () => join(app.getPath('userData'), 'companion-build')
const recordFile = () => join(app.getPath('userData'), 'companion-install.json')

let installing: ReturnType<typeof spawn> | null = null

function progress(p: CompanionInstallProgress): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('companion-install:progress', p)
}

/** Full Xcode is needed; the command line tools alone can't build iPhone apps. */
async function xcodeProblem(): Promise<string | null> {
  if (process.platform !== 'darwin') return t('installerMain.needsMac')
  try {
    const { stdout } = await run('xcode-select', ['-p'])
    if (!stdout.includes('.app/')) return t('installerMain.installXcode')
    await run('xcodebuild', ['-version'])
    return null
  } catch {
    return t('installerMain.installXcode')
  }
}

/** Teams of the Apple IDs added in Xcode (Settings, Accounts). */
async function signingTeams(): Promise<SigningTeam[]> {
  if (!existsSync(XCODE_PREFS)) return []
  try {
    const { stdout } = await run('plutil', ['-extract', 'IDEProvisioningTeamByIdentifier', 'json', '-o', '-', XCODE_PREFS])
    const byAccount = JSON.parse(stdout) as Record<string, { teamID: string; teamName: string; isFreeProvisioningTeam: boolean; teamType: string }[]>
    const teams = new Map<string, SigningTeam>()
    for (const [account, list] of Object.entries(byAccount)) {
      for (const t of list) {
        if (!teams.has(t.teamID)) teams.set(t.teamID, { id: t.teamID, name: t.teamName, free: t.isFreeProvisioningTeam, type: t.teamType, account })
      }
    }
    return [...teams.values()]
  } catch {
    return []
  }
}

/** iPhones Xcode can reach (cable, or Wi-Fi once paired with Xcode). */
async function installTargets(): Promise<InstallTarget[]> {
  const out = join(app.getPath('temp'), `mirror-devices-${process.pid}.json`)
  try {
    await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', out])
    const json = JSON.parse(await readFile(out, 'utf8')) as {
      result: {
        devices: {
          deviceProperties: { name?: string; developerModeStatus?: string }
          hardwareProperties: { platform?: string; udid?: string; marketingName?: string }
          connectionProperties: { tunnelState?: string; transportType?: string }
        }[]
      }
    }
    return json.result.devices
      .filter((d) => d.hardwareProperties.platform === 'iOS' && d.hardwareProperties.udid && d.connectionProperties.transportType && d.connectionProperties.tunnelState !== 'unavailable')
      .map((d) => ({
        udid: d.hardwareProperties.udid!,
        name: d.deviceProperties.name ?? d.hardwareProperties.marketingName ?? 'iPhone',
        model: d.hardwareProperties.marketingName ?? null,
        wired: d.connectionProperties.transportType === 'wired',
        developerMode: d.deviceProperties.developerModeStatus !== 'disabled'
      }))
  } catch {
    return []
  } finally {
    void rm(out, { force: true })
  }
}

/** Installed provisioning profiles: Xcode 16+ and older locations. */
const PROFILE_DIRS = [
  join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
  join(homedir(), 'Library/MobileDevice/Provisioning Profiles')
]

/** Reads one value from a decoded profile (plutil key path, raw or json). */
async function profileValue(file: string, key: string, format: 'raw' | 'json'): Promise<string | null> {
  try {
    const { stdout } = await run('plutil', ['-extract', key, format, '-o', '-', file])
    return stdout.trim()
  } catch {
    return null
  }
}

async function provisioningProfiles(): Promise<ProvisioningProfile[]> {
  const out: ProvisioningProfile[] = []
  const tmp = join(app.getPath('temp'), `freeflect-profile-${process.pid}.plist`)
  const seen = new Set<string>()
  for (const dir of PROFILE_DIRS) {
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.filter((n) => n.endsWith('.mobileprovision'))) {
      try {
        // Profiles are signed (CMS); security decodes the plist inside.
        await run('security', ['cms', '-D', '-i', join(dir, name), '-o', tmp])
        const uuid = await profileValue(tmp, 'UUID', 'raw')
        if (!uuid || seen.has(uuid)) continue
        seen.add(uuid)
        const appIdFull = (await profileValue(tmp, 'Entitlements.application-identifier', 'raw')) ?? ''
        const teamId = JSON.parse((await profileValue(tmp, 'TeamIdentifier', 'json')) ?? '[]')[0] ?? appIdFull.split('.')[0] ?? ''
        const platforms = (await profileValue(tmp, 'Platform', 'json')) ?? '[]'
        if (!platforms.includes('iOS')) continue
        const allDevices = (await profileValue(tmp, 'ProvisionsAllDevices', 'raw')) === 'true'
        const devices = JSON.parse((await profileValue(tmp, 'ProvisionedDevices', 'json')) ?? '[]') as string[]
        // App Store profiles list no devices and can never install on one.
        if (!allDevices && devices.length === 0) continue
        out.push({
          uuid,
          name: (await profileValue(tmp, 'Name', 'raw')) ?? name,
          teamId,
          teamName: (await profileValue(tmp, 'TeamName', 'raw')) ?? teamId,
          appId: appIdFull.slice(teamId.length + 1),
          expiresAt: Date.parse((await profileValue(tmp, 'ExpirationDate', 'raw')) ?? '') || 0,
          allDevices,
          devices,
          development: (await profileValue(tmp, 'Entitlements.get-task-allow', 'raw')) === 'true'
        })
      } catch {
        // Not a readable profile; skip it.
      }
    }
  }
  await rm(tmp, { force: true })
  return out.sort((a, b) => b.expiresAt - a.expiresAt)
}

const profileSigns = (p: ProvisioningProfile, bundleId: string) =>
  p.appId === '*' || p.appId === bundleId || (p.appId.endsWith('.*') && bundleId.startsWith(p.appId.slice(0, -1)))
const profileUsable = (p: ProvisioningProfile, udid: string) => p.expiresAt > Date.now() && (p.allDevices || p.devices.includes(udid))

/**
 * Which installed profile signs each of the three targets, for the profile
 * the user chose. Returns an error message when it can't work.
 */
function planProfiles(chosen: ProvisioningProfile, all: ProvisioningProfile[], udid: string) {
  if (chosen.expiresAt <= Date.now()) return { error: t('installerMain.profileExpired', { name: chosen.name }) }
  if (!profileUsable(chosen, udid)) return { error: t('installerMain.profileNoDevice', { name: chosen.name }) }
  // com.freeflect.ios when the profile covers it; otherwise the id the profile allows.
  const bundleId = profileSigns(chosen, BUNDLE_ID)
    ? BUNDLE_ID
    : chosen.appId.endsWith('.*')
      ? `${chosen.appId.slice(0, -1)}freeflect.ios`
      : chosen.appId
  const pick = (bundleId: string) => {
    if (profileSigns(chosen, bundleId)) return chosen
    const candidates = all.filter((p) => p.teamId === chosen.teamId && profileUsable(p, udid) && profileSigns(p, bundleId))
    // An exact match beats a wildcard.
    return candidates.find((p) => p.appId === bundleId) ?? candidates[0] ?? null
  }
  const ids = { app: bundleId, broadcast: `${bundleId}.broadcast`, share: `${bundleId}.share` }
  const plan = { app: pick(ids.app), broadcast: pick(ids.broadcast), share: pick(ids.share) }
  const missing = (Object.keys(ids) as (keyof typeof ids)[]).filter((k) => !plan[k]).map((k) => ids[k])
  if (missing.length) return { error: t('installerMain.profileMissing', { ids: missing.join(', ') }) }
  return { bundleId, app: plan.app!, broadcast: plan.broadcast!, share: plan.share! }
}

/** The iPhone app's bundle id; extensions add .broadcast and .share. */
const BUNDLE_ID = 'com.freeflect.ios'
/**
 * Apple keeps bundle ids unique across all accounts: when another team has
 * registered com.freeflect.ios, this team gets its own variant instead.
 */
const teamBundleId = (teamId: string) => `${BUNDLE_ID}.t${teamId.toLowerCase()}`
const ID_TAKEN = /not available|cannot be registered|is already in use|already exists|isn't available/i

/** Turns xcodebuild and devicectl errors into steps the user can take. */
function explain(output: string): string {
  const rules: [RegExp, string][] = [
    [/No Accounts|No account for team|sign in with your Apple ID|Unable to log in/i, t('installerMain.addAppleId')],
    [/Developer Mode/i, t('installerMain.developerMode')],
    [/No signing certificate|no identity found|valid signing identity|doesn't include signing certificate/i, t('installerMain.noCertificate')],
    [/doesn't include the currently selected device|not included in the provisioning profile/i, t('installerMain.profileNoDeviceShort')],
    [/locked|passcode/i, t('installerMain.unlock')],
    [/maximum number of apps|App ID limit|registered App IDs|too many/i, t('installerMain.appLimit')],
    [/not (been )?trusted|Trust this computer|pair/i, t('installerMain.trust')],
    [/no space|insufficient storage/i, t('installerMain.storage')],
    [/Could not find|not connected|unavailable/i, t('installerMain.unreachable')]
  ]
  for (const [pattern, message] of rules) if (pattern.test(output)) return message
  const line = output.split('\n').find((l) => /error:/i.test(l))
  return line ? line.replace(/^.*?error:\s*/i, '') : t('installerMain.buildFailed')
}

/** Runs a command, streaming its output to `onLine`; resolves with the whole log. */
function stream(cmd: string, args: string[], onLine: (line: string) => void): Promise<{ code: number; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    installing = child
    let log = ''
    let partial = ''
    const onData = (d: Buffer) => {
      const text = partial + d.toString()
      const lines = text.split('\n')
      partial = lines.pop() ?? ''
      for (const l of lines) onLine(l)
      log = (log + d.toString()).slice(-200_000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => resolve({ code: -1, log: log + String(e) }))
    child.on('exit', (code) => {
      installing = null
      resolve({ code: code ?? -1, log })
    })
  })
}

async function install(sourceRoot: string, signing: SigningChoice, udid: string): Promise<void> {
  const problem = await xcodeProblem()
  if (problem) return progress({ stage: 'error', message: problem })
  // The signing arguments for xcodebuild, from the user's choice.
  let signArgs: string[]
  let bundleId: string
  let label: string
  let record: Omit<CompanionInstall, 'deviceName' | 'installedAt'>
  if (signing.kind === 'team') {
    const team = (await signingTeams()).find((x) => x.id === signing.teamId)
    if (!team) return progress({ stage: 'error', message: t('installerMain.teamGone') })
    bundleId = BUNDLE_ID
    label = team.name
    signArgs = ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', `DEVELOPMENT_TEAM=${team.id}`, 'CODE_SIGN_STYLE=Automatic']
    record = { method: 'team', teamId: team.id, teamName: team.name, free: team.free, expiresAt: team.free ? Date.now() + FREE_PROFILE_DAYS * 24 * 60 * 60 * 1000 : null }
  } else {
    const all = await provisioningProfiles()
    const chosen = all.find((p) => p.uuid === signing.uuid)
    if (!chosen) return progress({ stage: 'error', message: t('installerMain.profileGone') })
    const plan = planProfiles(chosen, all, udid)
    if ('error' in plan) return progress({ stage: 'error', message: plan.error! })
    bundleId = plan.bundleId
    label = chosen.name
    signArgs = [
      'CODE_SIGN_STYLE=Manual',
      `DEVELOPMENT_TEAM=${chosen.teamId}`,
      `CODE_SIGN_IDENTITY=${chosen.development ? 'Apple Development' : 'Apple Distribution'}`,
      `FF_PROFILE_APP=${plan.app.uuid}`,
      `FF_PROFILE_BROADCAST=${plan.broadcast.uuid}`,
      `FF_PROFILE_SHARE=${plan.share.uuid}`
    ]
    record = { method: 'profile', teamId: chosen.teamId, teamName: chosen.name, free: false, expiresAt: Math.min(plan.app.expiresAt, plan.broadcast.expiresAt, plan.share.expiresAt) }
  }
  const target = (await installTargets()).find((d) => d.udid === udid)
  if (!target) return progress({ stage: 'error', message: t('installerMain.unreachable') })
  if (!target.developerMode) {
    return progress({ stage: 'error', message: t('installerMain.developerMode') })
  }

  progress({ stage: 'preparing', message: t('installer.preparing') })
  const src = join(workDir(), 'src')
  const derived = join(workDir(), 'derived')
  await rm(src, { recursive: true, force: true })
  await mkdir(src, { recursive: true })
  // A fresh, writable copy; files from a downloaded disk image can carry
  // extended attributes that make code signing fail, so those are cleared.
  await cp(join(sourceRoot, 'native'), join(src, 'native'), { recursive: true })
  await run('xattr', ['-cr', src]).catch(() => undefined)

  progress({ stage: 'building', message: t('installerMain.building', { team: label }) })
  const xcodebuild = (id: string) =>
    stream(
      'xcodebuild',
      [
        '-project', join(src, PROJECT, 'MirrorCompanion.xcodeproj'),
        '-scheme', 'MirrorCompanion',
        '-configuration', 'Release',
        '-destination', `id=${udid}`,
        '-derivedDataPath', derived,
        ...signArgs,
        `FF_BUNDLE_ID=${id}`,
        'build'
      ],
      (line) => {
        if (/^(SwiftCompile|CompileSwift)/.test(line)) progress({ stage: 'building', message: t('installerMain.compiling') })
        else if (/^CodeSign/.test(line)) progress({ stage: 'building', message: t('installerMain.signing') })
        else if (/Provisioning|profile/i.test(line) && !/error/i.test(line)) progress({ stage: 'building', message: t('installerMain.profile') })
      }
    )
  let build = await xcodebuild(bundleId)
  if (build.code !== 0 && signing.kind === 'team' && ID_TAKEN.test(build.log)) {
    bundleId = teamBundleId(record.teamId)
    progress({ stage: 'building', message: t('installerMain.idTaken', { id: bundleId }) })
    build = await xcodebuild(bundleId)
  }
  if (build.code !== 0) return progress({ stage: 'error', message: explain(build.log), log: build.log.slice(-8000) })

  progress({ stage: 'installing', message: t('installerMain.installing', { device: target.name }) })
  const appPath = join(derived, 'Build/Products/Release-iphoneos/MirrorCompanion.app')
  const installed = await stream('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, appPath], () => undefined)
  if (installed.code !== 0) return progress({ stage: 'error', message: explain(installed.log), log: installed.log.slice(-8000) })

  const installedRecord: CompanionInstall = { ...record, deviceName: target.name, installedAt: Date.now() }
  await writeFile(recordFile(), JSON.stringify(installedRecord, null, 2))

  // Opening it shows whether the iPhone still has to trust this developer.
  progress({ stage: 'launching', message: t('installerMain.opening') })
  const launched = await stream('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, bundleId], () => undefined)
  const untrusted = launched.code !== 0 && /trust|profile|security|denied|invalid code signature/i.test(launched.log)
  progress({ stage: 'done', message: t('installer.installedOn', { device: target.name }), needsTrust: untrusted || (launched.code !== 0 && record.free), install: installedRecord })
}

export function registerCompanionInstallerIpc(sourceRoot: string): void {
  ipcMain.handle('companion-install:info', async () => ({
    problem: await xcodeProblem(),
    teams: await signingTeams(),
    profiles: await provisioningProfiles(),
    devices: await installTargets(),
    last: await readFile(recordFile(), 'utf8').then((t) => JSON.parse(t) as CompanionInstall).catch(() => null),
    available: existsSync(join(sourceRoot, PROJECT, 'MirrorCompanion.xcodeproj'))
  }))
  ipcMain.handle('companion-install:start', async (_e, signing: SigningChoice, udid: string) => {
    if (installing) return
    try {
      await install(sourceRoot, signing, udid)
    } catch (e) {
      progress({ stage: 'error', message: explain(String(e)), log: String(e) })
    }
  })
  ipcMain.on('companion-install:cancel', () => {
    installing?.kill()
    installing = null
    progress({ stage: 'error', message: t('installerMain.cancelled') })
  })
}
