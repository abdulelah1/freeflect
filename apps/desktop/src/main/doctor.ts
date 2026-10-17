// Connection Doctor: individual checks the renderer runs in order, plus the
// one-click fixes. Each check returns a plain-language result.

import { app, clipboard, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, networkInterfaces, release } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DoctorCheckId, DoctorResult } from '../shared-ipc'
import { probeStream } from './mirror'
import { native } from './native'
import { adbPath } from './adb'
import { t } from './i18n'

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
}

export function registerDoctorIpc(): void {
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
