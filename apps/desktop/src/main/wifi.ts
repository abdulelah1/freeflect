// Wireless connection: QR pairing (Android 11+), pairing code, USB → Wi-Fi.
//
// Pairing itself is done by the ADB server: the phone scans a QR code that
// names an mDNS service and password, advertises `_adb-tls-pairing._tcp`
// under that name, and we ask adb to pair with it. adb then auto-connects
// to the phone's `_adb-tls-connect._tcp` service.

import { ipcMain, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import type { WifiPairStatus } from '../shared-ipc'
import { native } from './native'
import { t } from './i18n'

const POLL_MS = 1000
const QR_TIMEOUT_MS = 3 * 60 * 1000
const CONNECT_TIMEOUT_MS = 15_000
/** Android 11, the first with Wireless debugging (TLS pairing). */
const ANDROID_11_SDK = 30

let qrSession = 0

const randomToken = (len: number) =>
  randomBytes(len)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, len)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const hostOf = (address: string) => address.slice(0, address.lastIndexOf(':'))

export function registerWifiIpc(getContents: () => WebContents | undefined): void {
  const status = (s: WifiPairStatus) => getContents()?.send('wifi:qr-status', s)

  ipcMain.handle('wifi:qr-start', async () => {
    const session = ++qrSession
    const name = `mirror-${randomToken(6)}`
    const password = randomToken(10)
    const svg = await QRCode.toString(`WIFI:T:ADB;S:${name};P:${password};;`, { type: 'svg', margin: 1 })
    void waitForQrPairing(session, name, password, status)
    return svg
  })
  ipcMain.on('wifi:qr-cancel', () => {
    qrSession++
  })

  ipcMain.handle('wifi:pair', async (_e, hostPort: string, code: string) => {
    await native.pairDevice(hostPort.trim(), code.trim())
    return waitForConnection(hostOf(hostPort.trim()))
  })

  // Legacy `adb tcpip` is unencrypted on the network: only for phones without
  // Wireless debugging (Android 10 and earlier). Newer ones pair with TLS above.
  ipcMain.handle('wifi:enable', async (_e, serial: string) => {
    const props = await native.deviceProps(serial).catch(() => null)
    if (props && props.sdk >= ANDROID_11_SDK) throw new Error(`[use_pairing] ${t('wifiMain.usePairing')}`)
    return native.enableWifi(serial)
  })
  ipcMain.handle('wifi:disable', (_e, serial: string) => native.disableWifi(serial))
  // Quiet reconnect of a remembered Wi-Fi phone; failures are expected while it is away.
  ipcMain.handle('wifi:connect', (_e, hostPort: string) => native.connectDevice(hostPort).then(() => true, () => false))
}

async function waitForQrPairing(
  session: number,
  name: string,
  password: string,
  status: (s: WifiPairStatus) => void
): Promise<void> {
  status({ state: 'waiting' })
  const deadline = Date.now() + QR_TIMEOUT_MS
  try {
    while (session === qrSession && Date.now() < deadline) {
      const services = await native.mdnsServices()
      const pairing = services.find((s) => s.name === name && s.serviceType.includes('_adb-tls-pairing'))
      if (pairing) {
        status({ state: 'pairing' })
        await native.pairDevice(pairing.address, password)
        const serial = await waitForConnection(hostOf(pairing.address))
        if (session === qrSession) status({ state: 'connected', serial })
        return
      }
      await sleep(POLL_MS)
    }
    if (session === qrSession) {
      status({ state: 'error', message: t('wifiMain.expired') })
    }
  } catch (e) {
    if (session === qrSession) status({ state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

/** After pairing, waits for adb to list the phone, connecting manually if needed. */
async function waitForConnection(host: string): Promise<string> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const devices = await native.listAndroidDevices()
    const wifi = devices.find((d) => d.transport === 'wifi' && d.state === 'device' && d.serial.includes(host))
    if (wifi) return wifi.serial
    const services = await native.mdnsServices()
    const connect = services.find((s) => s.serviceType.includes('_adb-tls-connect') && s.address.startsWith(host))
    if (connect) {
      await native.connectDevice(connect.address).catch(() => undefined)
      const after = await native.listAndroidDevices()
      const match = after.find((d) => d.transport === 'wifi' && d.state === 'device')
      if (match) return match.serial
    }
    await sleep(POLL_MS)
  }
  throw new Error(t('wifiMain.noConnect'))
}
