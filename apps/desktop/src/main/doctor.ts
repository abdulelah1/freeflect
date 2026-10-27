// Connection Doctor: individual checks the renderer runs in order, plus the
// one-click fixes. Each check returns a plain-language result.

import { app, clipboard, ipcMain, shell, systemPreferences } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, networkInterfaces, release } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isIosSerial, type DoctorCheckId, type DoctorFix, type DoctorResult } from '../shared-ipc'
import { companionStatus } from './companion'
import { iosHelperAvailable, probeIosStream, probeStream, usbIphones } from './mirror'
import { native } from './native'
import { mediaStatus } from './permissions'
import { adbPath } from './adb'
import { currentLanguage, t } from './i18n'

const run = promisify(execFile)

/** adb is not always on PATH when the app is launched from Finder. */
const sameSubnet = (a: string, b: string) => a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.')

function desktopIPv4(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address)
}

async function check(id: DoctorCheckId, serial: string | null): Promise<DoctorResult> {
  if (id.startsWith('ios')) return checkIphone(id, serial)
  switch (id) {
    case 'adb': {
      try {
        await native.listAndroidDevices()
        return { id, status: 'pass', title: t('doctorMain.adbOk') }
      } catch (e) {
        return {
          id,
          status: 'fail',
          title: t('doctorMain.adbFail'),
          detail: t('doctorMain.adbFailDetail', { app: t('app.name') }),
          fix: 'start-adb',
          raw: String(e)
        }
      }
    }
    case 'device': {
      const devices = await native.listAndroidDevices().catch(() => [])
      if (devices.length === 0) {
        return {
          id,
          status: 'fail',
          title: t('doctorMain.noPhone'),
          detail: t('doctorMain.noPhoneDetail'),
          fix: 'open-setup'
        }
      }
      const names = devices.map((d) => d.model ?? d.serial).join(', ')
      return { id, status: 'pass', title: t('doctorMain.found', { names }) }
    }
    case 'authorized': {
      const devices = await native.listAndroidDevices().catch(() => [])
      const target = devices.find((d) => d.serial === serial) ?? devices[0]
      if (!target) return { id, status: 'skip', title: t('doctorMain.waitingPhone') }
      if (target.state === 'device') return { id, status: 'pass', title: t('doctorMain.allowed') }
      if (target.state === 'unauthorized') {
        return {
          id,
          status: 'fail',
          title: t('doctorMain.notAllowed'),
          detail: t('doctorMain.notAllowedDetail')
        }
      }
      return {
        id,
        status: 'fail',
        title: t('doctorMain.notResponding'),
        detail: t('doctorMain.notRespondingDetail')
      }
    }
    case 'network': {
      const devices = await native.listAndroidDevices().catch(() => [])
      const target = devices.find((d) => d.serial === serial) ?? devices[0]
      if (!target || target.transport !== 'wifi') return { id, status: 'skip', title: t('doctorMain.notWifi') }
      const phoneIp = target.serial.match(/^(\d+\.\d+\.\d+\.\d+):/)?.[1]
      if (!phoneIp) return { id, status: 'pass', title: t('toast.wifiConnected') }
      const mine = desktopIPv4()
      return mine.some((ip) => sameSubnet(ip, phoneIp))
        ? { id, status: 'pass', title: t('doctorMain.sameNetwork') }
        : {
            id,
            status: 'fail',
            title: t('doctorMain.differentNetworks'),
            detail: t('doctorMain.differentNetworksDetail', { phone: phoneIp, computer: mine.join(', ') || t('doctorMain.noNetwork') })
          }
    }
    case 'brand': {
      if (!serial) return { id, status: 'skip', title: t('doctorMain.waitingPhone') }
      const props = await native.deviceProps(serial).catch(() => null)
      if (!props) return { id, status: 'skip', title: t('doctorMain.noDetails') }
      const brand = props.manufacturer.toLowerCase()
      const label = `${props.manufacturer} ${props.marketName || props.model}, ${t('setup.done.android', { version: props.androidVersion }).replace(/\.$/, '')}`
      if (['xiaomi', 'redmi', 'poco'].includes(brand)) {
        return {
          id,
          status: 'warn',
          title: label,
          detail: t('doctorMain.xiaomi')
        }
      }
      if (['oppo', 'realme', 'oneplus'].includes(brand)) {
        return {
          id,
          status: 'warn',
          title: label,
          detail: t('doctorMain.oppo')
        }
      }
      return { id, status: 'pass', title: label, detail: t('doctorMain.brandOk') }
    }
    case 'stream': {
      if (!serial) return { id, status: 'skip', title: t('doctorMain.waitingPhone') }
      const result = await probeStream(serial)
      if (result.ok) {
        return { id, status: 'pass', title: result.alreadyRunning ? t('doctorMain.running') : t('doctorMain.captureOk') }
      }
      return {
        id,
        status: 'fail',
        title: t('doctorMain.captureFail'),
        detail: t('doctorMain.captureFailDetail'),
        raw: result.error
      }
    }
  }
  return { id, status: 'skip', title: '' }
}

/** Who macOS asks about the camera: FreeFlect, or in development the terminal that started it. */
function permissionHolder(): string {
  if (app.isPackaged) return t('app.name')
  const terminals: Record<string, string> = {
    Apple_Terminal: 'Terminal',
    'iTerm.app': 'iTerm',
    vscode: 'Visual Studio Code',
    WarpTerminal: 'Warp',
    ghostty: 'Ghostty'
  }
  return terminals[process.env.TERM_PROGRAM ?? ''] ?? t('doctorMain.ios.yourTerminal')
}

/** Interfaces that can reach phones on the same network, and VPN tunnels. */
function lanInterfaces(): { lan: string[]; vpn: string[] } {
  const lan: string[] = []
  const vpn: string[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (/^(utun|ipsec|ppp|tun|tap|wg)/.test(name)) vpn.push(name)
      else lan.push(a.address)
    }
  }
  return { lan, vpn: [...new Set(vpn)] }
}

/** The macOS application firewall: off, blocking everything, or blocking this app. */
async function firewall(): Promise<'off' | 'block-all' | 'app-blocked' | 'on'> {
  const tool = '/usr/libexec/ApplicationFirewall/socketfilterfw'
  if (process.platform !== 'darwin' || !existsSync(tool)) return 'off'
  const out = async (...args: string[]) => (await run(tool, args, { timeout: 5000 }).catch(() => ({ stdout: '' }))).stdout
  if (!/State = [12]/.test(await out('--getglobalstate'))) return 'off'
  if (/block all state set to enabled|blockall.*enabled/i.test(await out('--getblockall'))) return 'block-all'
  return /is blocked|blocked from/i.test(await out('--getappblocked', process.execPath)) ? 'app-blocked' : 'on'
}

/** Whether the companion server's Bonjour advert resolves, as an iPhone would see it. */
function advertResolves(fingerprint: string): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true)
  return new Promise((resolve) => {
    const child = spawn('dns-sd', ['-L', `FreeFlect-${fingerprint.slice(0, 12)}`, '_mirror-desk._tcp', 'local.'])
    let found = false
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('can be reached at')) {
        found = true
        child.kill()
      }
    })
    child.on('error', () => resolve(true))
    child.on('exit', () => resolve(found))
    setTimeout(() => child.kill(), 3000)
  })
}

function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  const rtf = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: 'auto' })
  return minutes < 60 ? rtf.format(-minutes, 'minute') : minutes < 48 * 60 ? rtf.format(-Math.round(minutes / 60), 'hour') : rtf.format(-Math.round(minutes / 1440), 'day')
}

async function checkIphone(id: DoctorCheckId, serial: string | null): Promise<DoctorResult> {
  const k = (key: string, vars?: Record<string, string | number>) => t(`doctorMain.ios.${key}`, vars)
  switch (id) {
    case 'iosCable': {
      if (process.platform !== 'darwin') return { id, status: 'skip', title: k('macOnly') }
      if (!iosHelperAvailable()) return { id, status: 'fail', title: k('helperMissing'), detail: k('helperMissingDetail') }
      const phones = usbIphones()
      // Over Wi-Fi a cable isn't needed, so this is a warning, not a failure.
      if (phones.length === 0) return { id, status: 'warn', title: k('noCable'), detail: k('noCableDetail') }
      return { id, status: 'pass', title: t('doctorMain.found', { names: phones.map((p) => p.model ?? 'iPhone').join(', ') }) }
    }
    case 'iosPermission': {
      if (process.platform !== 'darwin') return { id, status: 'skip', title: k('macOnly') }
      const who = permissionHolder()
      const viaTerminal = app.isPackaged ? '' : ` ${k('devHolder', { who })}`
      const camera = systemPreferences.getMediaAccessStatus('camera')
      const mic = systemPreferences.getMediaAccessStatus('microphone')
      if (camera === 'denied' || camera === 'restricted') {
        return { id, status: 'fail', title: k('cameraOff', { who }), detail: k('cameraOffDetail', { who }) + viaTerminal, fix: 'open-camera-settings', raw: `camera=${camera} microphone=${mic}` }
      }
      if (camera === 'not-determined') {
        return { id, status: 'warn', title: k('cameraAsk'), detail: k('cameraAskDetail', { who }) + viaTerminal, fix: 'ask-media', raw: `camera=${camera} microphone=${mic}` }
      }
      // The iPhone's sound stays on the iPhone unless moved here, so the microphone is optional.
      if (mic === 'denied' || mic === 'restricted') {
        return { id, status: 'pass', title: k('cameraOn', { who }), detail: k('micOffDetail', { who }) + viaTerminal, fix: 'open-microphone-settings', raw: `camera=${camera} microphone=${mic}` }
      }
      if (mic === 'not-determined') {
        return { id, status: 'pass', title: k('cameraOn', { who }), detail: k('micAskDetail') }
      }
      return { id, status: 'pass', title: k('bothOn', { who }) }
    }
    case 'iosCapture': {
      const target = serial && isIosSerial(serial) && serial.startsWith('ios:') ? serial : usbIphones()[0]?.serial
      if (!target) return { id, status: 'skip', title: k('noCableSkip') }
      // The test must not be what makes macOS ask: permission comes first, with an explanation.
      if (mediaStatus('camera') !== 'granted') return { id, status: 'skip', title: k('cameraFirst') }
      const result = await probeIosStream(target)
      if (result.ok) return { id, status: 'pass', title: result.alreadyRunning ? t('doctorMain.running') : t('doctorMain.captureOk') }
      return { id, status: 'fail', title: t('doctorMain.captureFail'), detail: k('captureFailDetail'), raw: result.error }
    }
    case 'iosLan': {
      const { lan, vpn } = lanInterfaces()
      if (lan.length === 0) return { id, status: 'fail', title: k('offline'), detail: k('offlineDetail') }
      const fw = await firewall()
      if (fw === 'block-all') return { id, status: 'fail', title: k('firewallAll'), detail: k('firewallAllDetail'), fix: 'open-firewall-settings' }
      if (fw === 'app-blocked') {
        return { id, status: 'fail', title: k('firewallApp', { app: t('app.name') }), detail: k('firewallAppDetail', { app: t('app.name') }), fix: 'open-firewall-settings' }
      }
      if (vpn.length > 0) return { id, status: 'warn', title: k('vpn'), detail: k('vpnDetail'), raw: `vpn interfaces: ${vpn.join(', ')}` }
      return { id, status: 'pass', title: k('online', { ips: lan.join(', ') }) }
    }
    case 'iosPaired': {
      const status = companionStatus()
      if (!status.allowed) return { id, status: 'fail', title: k('appOff'), detail: k('appOffDetail'), fix: 'pair-iphone' }
      if (status.phones.length === 0) return { id, status: 'fail', title: k('notPaired'), detail: k('notPairedDetail'), fix: 'pair-iphone' }
      return { id, status: 'pass', title: k('paired', { names: status.phones.map((p) => p.name).join(', ') }) }
    }
    case 'iosListening': {
      const status = companionStatus()
      if (status.port === null || status.fingerprint === null) return { id, status: 'fail', title: k('notListening'), detail: k('notListeningDetail') }
      if (!(await advertResolves(status.fingerprint))) {
        return { id, status: 'fail', title: k('notAdvertised'), detail: k('notAdvertisedDetail'), raw: `port ${status.port}` }
      }
      return { id, status: 'pass', title: k('listening'), raw: `port ${status.port}` }
    }
    case 'iosLink': {
      const phones = companionStatus().phones
      const live = phones.filter((p) => p.sharingScreen || p.appOpen)
      if (live.length > 0) {
        return { id, status: 'pass', title: live.map((p) => k(p.sharingScreen ? 'sharing' : 'appOpen', { name: p.name })).join(' ') }
      }
      const last = phones.filter((p) => p.lastSeen !== null).sort((a, b) => b.lastSeen! - a.lastSeen!)[0]
      const seen = last ? k('lastSeen', { name: last.name, when: ago(last.lastSeen!) }) : k('notSeen')
      return { id, status: 'warn', title: k('noLink'), detail: `${seen} ${k('noLinkDetail')}` }
    }
  }
  return { id, status: 'skip', title: '' }
}

/** System Settings pages for the fixes (macOS). */
const SETTINGS_PAGES: Partial<Record<DoctorFix, string>> = {
  'open-camera-settings': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  'open-microphone-settings': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  'open-firewall-settings': 'x-apple.systempreferences:com.apple.preference.security?Firewall'
}

async function applyFix(fix: DoctorFix): Promise<void> {
  // Only fixed pages: the window never names what to open. (Asking for camera
  // and microphone access goes through the window's explanation first.)
  const page = SETTINGS_PAGES[fix]
  if (page) await shell.openExternal(page)
}

export function registerDoctorIpc(): void {
  ipcMain.handle('doctor:fix', (_e, fix: DoctorFix) => applyFix(fix))
  ipcMain.handle('doctor:check', (_e, id: DoctorCheckId, serial: string | null) => check(id, serial))
  ipcMain.handle('doctor:start-adb', async () => {
    await run(adbPath(), ['start-server'], { timeout: 15_000 })
  })
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    nativeVersion: native.nativeVersion(),
    platform: `${process.platform} ${release()} (${process.arch})`,
    electron: process.versions.electron,
    adbPath: adbPath(),
    packaged: app.isPackaged
  }))
  ipcMain.handle('clipboard:write-text', (_e, text: string) => clipboard.writeText(text))
}
