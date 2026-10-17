// The iOS companion app: local-network server (native), device approval,
// wireless screen streams, clipboard and files from/to the phone.

import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { COMPANION_PREFIX, type AndroidDevice } from '../shared-ipc'
import { native } from './native'
import { onSettingsChange, settings } from './settings'
import { t } from './i18n'

type Server = import('@mirror/native').CompanionServer

let server: Server | null = null
/** Phones currently broadcasting their screen, by device id. */
const screens = new Map<string, string>()
/** Phones with the app open (can receive clipboard and files). */
const controls = new Map<string, string>()
/** Receives each phone's video and audio packets while a window shows it. */
const videoSinks = new Map<string, (packet: unknown) => void>()
const audioSinks = new Map<string, (packet: { config: boolean }) => void>()
/** Sent once per broadcast; replayed to a window that starts showing the phone later. */
const audioConfigs = new Map<string, { config: boolean }>()

const allowedFile = () => join(app.getPath('userData'), 'companion-devices.json')

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
}

type AllowedPhone = { deviceId: string; name: string }

async function loadAllowed(): Promise<AllowedPhone[]> {
  try {
    const saved = JSON.parse(await readFile(allowedFile(), 'utf8')) as (AllowedPhone | string)[]
    // Earlier versions stored ids only.
    return saved.map((p) => (typeof p === 'string' ? { deviceId: p, name: 'iPhone' } : p))
  } catch {
    return []
  }
}

const saveAllowed = (phones: AllowedPhone[]) => writeFile(allowedFile(), JSON.stringify(phones, null, 2))
const desktopName = () => `FreeFlect on ${hostname().replace(/\.local$/, '')}`
/** Names of phones waiting for approval, saved with the phone when allowed. */
const pendingNames = new Map<string, string>()

/** Starts the server if the setting allows it, and follows later changes. */
export async function startCompanion(mainWindow: () => BrowserWindow | null): Promise<void> {
  ipcMain.handle('companion:approve', async (_e, requestId: number, deviceId: string, allow: boolean) => {
    server?.approve(requestId, allow)
    const name = pendingNames.get(deviceId) ?? 'iPhone'
    pendingNames.delete(deviceId)
    if (allow) {
      const allowed = await loadAllowed()
      if (!allowed.some((p) => p.deviceId === deviceId)) await saveAllowed([...allowed, { deviceId, name }])
    }
  })
  ipcMain.handle('companion:info', () => ({ name: desktopName(), port: server?.port ?? 0 }))
  ipcMain.handle('companion:devices', () => loadAllowed())
  ipcMain.handle('companion:forget', async (_e, deviceId: string) => {
    server?.forget(deviceId)
    await saveAllowed((await loadAllowed()).filter((p) => p.deviceId !== deviceId))
  })
  onSettingsChange((s, previous) => {
    if (s.receivedFilesDir !== previous.receivedFilesDir) server?.setDownloadsDir(s.receivedFilesDir)
    if (s.companionEnabled !== previous.companionEnabled) {
      if (s.companionEnabled) void startServer(mainWindow).catch((e: unknown) => console.error('[companion] not started:', e))
      else stopServer()
    }
  })
  if (settings().companionEnabled) await startServer(mainWindow)
}

function stopServer(): void {
  server?.shutdown()
  server = null
  for (const id of screens.keys()) broadcast('mirror:closed', COMPANION_PREFIX + id)
  screens.clear()
  controls.clear()
}

async function startServer(mainWindow: () => BrowserWindow | null): Promise<void> {
  if (server) return
  server = await native.startCompanionServer(
    desktopName(),
    (await loadAllowed()).map((p) => p.deviceId),
    settings().receivedFilesDir,
    (e) => {
      switch (e.kind) {
        case 'approval':
          pendingNames.set(e.deviceId, e.name ?? 'iPhone')
          // The main window asks the user; the answer comes back over IPC.
          mainWindow()?.webContents.send('companion:approval', { requestId: e.requestId, name: e.name, deviceId: e.deviceId })
          break
        case 'screen-started':
          screens.set(e.deviceId, e.name ?? 'iPhone')
          break
        case 'screen-stopped':
          screens.delete(e.deviceId)
          audioConfigs.delete(e.deviceId)
          broadcast('mirror:closed', COMPANION_PREFIX + e.deviceId)
          break
        case 'control-connected':
          controls.set(e.deviceId, e.name ?? 'iPhone')
          break
        case 'control-disconnected':
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
