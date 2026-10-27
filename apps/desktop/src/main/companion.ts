// The iOS companion app: local-network server (native), pairing, wireless
// screen streams, clipboard and files from/to the phone.
//
// The server only runs while it is allowed in settings and there is a phone
// to serve: a paired one, or the pairing window. Phones pin this computer's
// certificate when they pair, so the identity is kept (key encrypted with the
// system keychain) and reused.

import { app, BrowserWindow, clipboard, ipcMain, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { COMPANION_PREFIX, type AndroidDevice, type CompanionPairing } from '../shared-ipc'
import { native } from './native'
import { onSettingsChange, settings, updateSettings } from './settings'
import { t } from './i18n'

type Server = import('@mirror/native').CompanionServer
type Identity = import('@mirror/native').CompanionIdentity

let server: Server | null = null
/** Phones currently broadcasting their screen, by device id. */
const screens = new Map<string, string>()
/** Phones with the app open (can receive clipboard and files). */
const controls = new Map<string, string>()
/** When each paired phone last had a connection open (ms), for the Connection Doctor. */
const lastSeen = new Map<string, number>()
/** Receives each phone's video and audio packets while a window shows it. */
const videoSinks = new Map<string, (packet: unknown) => void>()
const audioSinks = new Map<string, (packet: { config: boolean }) => void>()
/** Sent once per broadcast; replayed to a window that starts showing the phone later. */
const audioConfigs = new Map<string, { config: boolean }>()

const pairedFile = () => join(app.getPath('userData'), 'companion-devices.json')
const identityFile = () => join(app.getPath('userData'), 'companion-identity.json')

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
}

type PairedPhone = { deviceId: string; name: string; secretHash: string }

/** Phones paired with this computer; kept in memory once loaded. */
let paired: PairedPhone[] = []
let pairingOpen = false

async function loadPaired(): Promise<PairedPhone[]> {
  try {
    const saved = JSON.parse(await readFile(pairedFile(), 'utf8')) as Partial<PairedPhone>[]
    // Phones allowed before pairing existed have no secret: they pair again.
    return saved.filter((p): p is PairedPhone => typeof p.deviceId === 'string' && typeof p.secretHash === 'string')
  } catch {
    return []
  }
}

const savePaired = () => writeFile(pairedFile(), JSON.stringify(paired, null, 2), { mode: 0o600 })
const desktopName = () => `FreeFlect on ${hostname().replace(/\.local$/, '')}`

/** The saved identity, or a new one. The key is stored encrypted when the system allows it. */
async function loadIdentity(): Promise<Identity> {
  try {
    const saved = JSON.parse(await readFile(identityFile(), 'utf8')) as { certPem: string; key: string; encrypted: boolean }
    const keyPem = saved.encrypted ? safeStorage.decryptString(Buffer.from(saved.key, 'base64')) : saved.key
    return { certPem: saved.certPem, keyPem }
  } catch {
    // None yet, or unreadable: a new identity means every phone pairs again.
    const identity = native.generateCompanionIdentity()
    const encrypted = safeStorage.isEncryptionAvailable()
    const key = encrypted ? safeStorage.encryptString(identity.keyPem).toString('base64') : identity.keyPem
    await writeFile(identityFile(), JSON.stringify({ certPem: identity.certPem, key, encrypted }), { mode: 0o600 })
    if (paired.length) {
      paired = []
      await savePaired()
    }
    return identity
  }
}

let mainWindowRef: () => BrowserWindow | null = () => null

/** Starts the server if the setting allows it, and follows later changes. */
export async function startCompanion(mainWindow: () => BrowserWindow | null): Promise<void> {
  mainWindowRef = mainWindow
  paired = await loadPaired()
  ipcMain.handle('companion:info', () => ({ name: desktopName(), port: server?.port ?? 0 }))
  ipcMain.handle('companion:devices', () => paired.map(({ deviceId, name }) => ({ deviceId, name })))
  ipcMain.handle('companion:forget', async (_e, deviceId: string) => {
    server?.forget(deviceId)
    paired = paired.filter((p) => p.deviceId !== deviceId)
    await savePaired()
    syncServer()
  })
  ipcMain.handle('companion:pair-start', async (): Promise<CompanionPairing> => {
    // Pairing is the user saying yes to the iPhone app.
    if (!settings().companionEnabled) await updateSettings({ companionEnabled: true })
    pairingOpen = true
    const s = await startServer()
    const p = s.beginPairing()
    const qrSvg = await QRCode.toString(p.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    return { qrSvg, code: p.code, expiresInSecs: p.expiresInSecs, desktopName: desktopName() }
  })
  ipcMain.handle('companion:pair-cancel', () => {
    server?.endPairing()
    pairingOpen = false
    syncServer()
  })
  onSettingsChange((s, previous) => {
    if (s.receivedFilesDir !== previous.receivedFilesDir) server?.setDownloadsDir(s.receivedFilesDir)
    if (s.companionEnabled !== previous.companionEnabled) syncServer()
  })
  syncServer()
}

const serverWanted = () => settings().companionEnabled && (paired.length > 0 || pairingOpen)

/** Runs the server exactly while it is allowed and has a phone to serve. */
function syncServer(): void {
  const wanted = serverWanted()
  if (wanted && !server) void startServer().catch((e: unknown) => console.error('[companion] not started:', e))
  if (!wanted && server) stopServer()
}

function stopServer(): void {
  server?.shutdown()
  server = null
  pairingOpen = false
  for (const id of screens.keys()) broadcast('mirror:closed', COMPANION_PREFIX + id)
  screens.clear()
  controls.clear()
}

let starting: Promise<Server> | null = null

async function startServer(): Promise<Server> {
  if (server) return server
  starting ??= startNativeServer().finally(() => {
    starting = null
  })
  return starting
}

async function startNativeServer(): Promise<Server> {
  const identity = await loadIdentity()
  const s = await native.startCompanionServer(
    desktopName(),
    identity,
    paired.map(({ deviceId, secretHash }) => ({ deviceId, secretHash })),
    settings().receivedFilesDir,
    (e) => {
      switch (e.kind) {
        case 'paired': {
          const phone = { deviceId: e.deviceId, name: e.name || 'iPhone', secretHash: e.secretHash ?? '' }
          paired = [...paired.filter((p) => p.deviceId !== phone.deviceId), phone]
          void savePaired()
          broadcast('companion:paired', { deviceId: phone.deviceId, name: phone.name })
          break
        }
        case 'pairing-closed':
          pairingOpen = false
          mainWindowRef()?.webContents.send('companion:pairing-closed', e.reason ?? 'expired')
          syncServer()
          break
        case 'screen-started':
          lastSeen.set(e.deviceId, Date.now())
          screens.set(e.deviceId, e.name ?? 'iPhone')
          break
        case 'screen-stopped':
          lastSeen.set(e.deviceId, Date.now())
          screens.delete(e.deviceId)
          audioConfigs.delete(e.deviceId)
          broadcast('mirror:closed', COMPANION_PREFIX + e.deviceId)
          break
        case 'control-connected':
          lastSeen.set(e.deviceId, Date.now())
          controls.set(e.deviceId, e.name ?? 'iPhone')
          break
        case 'control-disconnected':
          lastSeen.set(e.deviceId, Date.now())
          controls.delete(e.deviceId)
          break
        case 'clipboard':
          if (e.text) void clipboard.writeText(e.text)
          broadcast('clipboard:from-phone', e.text ?? '')
          break
        case 'file':
          broadcast('companion:file', { name: e.name, path: e.path })
          break
      }
    },
    (packet) => videoSinks.get(packet.deviceId)?.(packet),
    (packet) => {
      if (packet.config) audioConfigs.set(packet.deviceId, packet)
      audioSinks.get(packet.deviceId)?.(packet)
    }
  )
  server = s
  // Unpaired or switched off while it was starting.
  if (!serverWanted()) stopServer()
  return s
}

/** Phones streaming their screen over Wi-Fi, for the device list. */
export function companionDevices(): AndroidDevice[] {
  return [...screens].map(([id, name]) => ({ serial: COMPANION_PREFIX + id, state: 'device', model: name, transport: 'wifi', platform: 'ios' }))
}

/** A session-like handle for a phone that is already streaming. */
export function attachCompanionScreen(
  deviceId: string,
  onPacket: (packet: unknown) => void,
  onAudio: ((packet: { config: boolean }) => void) | null
) {
  if (!screens.has(deviceId)) {
    throw new Error(`[not_streaming] ${t('errors.notStreaming.body')}`)
  }
  videoSinks.set(deviceId, onPacket)
  if (onAudio) {
    audioSinks.set(deviceId, onAudio)
    const config = audioConfigs.get(deviceId)
    if (config) onAudio(config)
  } else {
    audioSinks.delete(deviceId)
  }
  server?.requestKeyframe(deviceId)
  const name = screens.get(deviceId)!
  return {
    deviceName: name,
    audioStatus: onAudio ? 'on' : 'off',
    inject: () => false,
    setClipboard: (text: string) => {
      void server?.sendClipboard(deviceId, text).catch(() => undefined)
      return true
    },
    setScreenPower: () => false,
    requestKeyframe: () => server?.requestKeyframe(deviceId),
    startRecording: (path: string) => server?.startRecording(deviceId, path),
    stopRecording: () => server?.stopRecording(deviceId) ?? [],
    stop: async () => {
      videoSinks.delete(deviceId)
      audioSinks.delete(deviceId)
    }
  }
}

/** Sends a file into the companion app (needs the app open on the phone). */
export async function sendFileToCompanion(deviceId: string, path: string): Promise<void> {
  if (!server) throw new Error('Companion server is not running')
  await server.sendFile(deviceId, path)
}

export const companionAppOpen = (deviceId: string) => controls.has(deviceId)

/** The iPhone app link as the Connection Doctor sees it. */
export function companionStatus() {
  return {
    allowed: settings().companionEnabled,
    port: server?.port ?? null,
    fingerprint: server?.fingerprint ?? null,
    phones: paired.map(({ deviceId, name }) => ({
      deviceId,
      name,
      sharingScreen: screens.has(deviceId),
      appOpen: controls.has(deviceId),
      lastSeen: lastSeen.get(deviceId) ?? null
    }))
  }
}
