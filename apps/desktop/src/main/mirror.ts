// Mirroring sessions (one per phone), input forwarding, recording and
// two-way clipboard sync.
//
// Each phone's video, audio and events go to the window that owns it: the
// main window for the selected phone, or a device window. A window becomes
// the owner when it starts a session or attaches to one.

import { app, BrowserWindow, clipboard, ipcMain, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { COMPANION_PREFIX, IOS_PREFIX, isCompanionSerial, isIosSerial, type AndroidDevice, type InputEvent, type MirrorOptions, type SystemAction } from '../shared-ipc'
import { attachCompanionScreen, companionDevices } from './companion'
import { timestampedName } from './files'
import { injectIos, stopAllIosControl, stopIosControl } from './iosControl'
import { settings } from './settings'
import { native, type AndroidMirror } from './native'

const CLIPBOARD_POLL_MS = 1000

/** Fixed phone commands the renderer may trigger by name. */
const SYSTEM_ACTIONS: Record<SystemAction, string> = {
  notifications: 'cmd statusbar expand-notifications',
  'quick-settings': 'cmd statusbar expand-settings',
  'collapse-panels': 'cmd statusbar collapse'
}
const PROBE_TIMEOUT_MS = 6000

/** What the desktop needs from a session, Android or iPhone. */
type MirrorHandle = Pick<
  AndroidMirror,
  | 'deviceName'
  | 'audioStatus'
  | 'inject'
  | 'requestKeyframe'
  | 'setClipboard'
  | 'setScreenPower'
  | 'startRecording'
  | 'stopRecording'
  | 'stop'
>

interface Session {
  mirror: MirrorHandle
  /** Start time of the current recording, or null. */
  recordingSince: number | null
  /** Last audio decoder config, resent to a window that starts decoding later. */
  lastAudioConfig: unknown
}

const sessions = new Map<string, Session>()
/** Window that receives each phone's video, audio and events. */
const owners = new Map<string, WebContents>()
// Bumped by every start/stop of a phone. A start that resolves after a newer
// request stops its own session, and packets from stale sessions are never
// forwarded: mixing two streams into one decoder corrupts the picture.
const generations = new Map<string, number>()
const bump = (serial: string) => {
  const gen = (generations.get(serial) ?? 0) + 1
  generations.set(serial, gen)
  return gen
}

let serverJarPath = ''
let iosHelperPath = ''
/**
 * iPhones come from one long-lived `ios-capture --watch` process: starting and
 * exiting a listing helper on every poll made a capture started right after
 * miss the device.
 */
let iosWatcher: ChildProcess | null = null
let iosDevicesSeen: AndroidDevice[] = []
let clipboardTimer: NodeJS.Timeout | null = null
// Last text seen on each side, so a sync never echoes back.
let lastFromPhone = ''
let lastDesktop = ''

/** Stable per install (profile folder), so each app only cleans up its own phone servers. */
let ownerId = ''
const owner = () =>
  (ownerId ||= createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 8))

function sendTo(serial: string, channel: string, ...args: unknown[]): void {
  const target = owners.get(serial)
  if (target && !target.isDestroyed()) target.send(channel, ...args)
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
}

/** Closes the recording of `serial` and reports the files to every window. */
function finishRecording(serial: string): void {
  const s = sessions.get(serial)
  if (!s || s.recordingSince === null) return
  s.recordingSince = null
  broadcast('record:state', serial, null)
  try {
    broadcast('record:finished', serial, { files: s.mirror.stopRecording() })
  } catch (e) {
    broadcast('record:finished', serial, { files: [], error: e instanceof Error ? e.message : String(e) })
  }
}

export function registerMirrorIpc(serverJar: string, iosHelper: string): void {
  serverJarPath = serverJar
  iosHelperPath = iosHelper

  ipcMain.handle('ios:devices', () => [...listIosDevices(), ...companionDevices()])

  ipcMain.handle('mirror:start', async (e, serial: string, options?: MirrorOptions) => {
    const gen = bump(serial)
    owners.set(serial, e.sender)
    await stopSession(serial)
    const isCurrent = () => generations.get(serial) === gen
    const onClosed = () => {
      if (!isCurrent()) return
      bump(serial)
      stopIosControl(serial)
      void stopSession(serial)
      broadcast('mirror:closed', serial)
    }
    const onAudio = (packet: { config: boolean }) => {
      if (!isCurrent()) return
      const s = sessions.get(serial)
      if (packet.config && s) s.lastAudioConfig = packet
      sendTo(serial, 'audio:packet', packet, serial)
    }
    const mirror: MirrorHandle = isCompanionSerial(serial)
      ? attachCompanionScreen(
          serial.slice(COMPANION_PREFIX.length),
          (packet) => isCurrent() && sendTo(serial, 'video:packet', packet, serial),
          // The phone always sends its sound (recordings keep it); play it only if asked.
          options?.audio ? onAudio : null
        )
      : isIosSerial(serial)
      ? await native.startIosMirror(
          iosHelperPath,
          serial.slice(IOS_PREFIX.length),
          options?.deviceName ?? 'iPhone',
          options?.bitRate ?? null,
          (packet) => isCurrent() && sendTo(serial, 'video:packet', packet, serial),
          onClosed,
          options?.audio ?? false,
          onAudio
        )
      : await native.startAndroidMirror(
      serial,
      serverJarPath,
      { ...options, owner: owner() },
      (packet) => isCurrent() && sendTo(serial, 'video:packet', packet, serial),
      onClosed,
      (text) => {
        if (!isCurrent() || !settings().clipboardSync) return
        lastFromPhone = text
        lastDesktop = text
        void clipboard.writeText(text)
        sendTo(serial, 'clipboard:from-phone', text)
      },
      onAudio
    )
    if (!isCurrent()) {
      await mirror.stop()
      throw new Error('[superseded] A newer mirroring request replaced this one')
    }
    sessions.set(serial, { mirror, recordingSince: null, lastAudioConfig: null })
    void startClipboardSync()
    return { deviceName: mirror.deviceName, audio: mirror.audioStatus }
  })

  ipcMain.handle('mirror:stop', (_e, serial: string) => stopMirror(serial))
  // A window that shows an already running session (a popped-out phone).
  ipcMain.on('mirror:attach', (e, serial: string) => {
    owners.set(serial, e.sender)
    primeOwner(serial)
  })
  ipcMain.on('mirror:input', (_e, serial: string, event: InputEvent) => {
    // iPhones with developer control on go through WebDriverAgent.
    if (isIosSerial(serial)) injectIos(serial, event)
    else sessions.get(serial)?.mirror.inject(JSON.stringify(event))
  })
  ipcMain.on('mirror:keyframe', (_e, serial: string) => sessions.get(serial)?.mirror.requestKeyframe())
  ipcMain.on('mirror:screen-power', (_e, serial: string, on: boolean) => sessions.get(serial)?.mirror.setScreenPower(on))
  ipcMain.on('mirror:system-action', (_e, serial: string, action: SystemAction) => {
    const command = SYSTEM_ACTIONS[action]
    if (command && sessions.has(serial)) void native.deviceShell(serial, command).catch(() => undefined)
  })
  ipcMain.on('mirror:paste', async (_e, serial: string) => {
    const text = await clipboard.readText()
    const s = sessions.get(serial)
    if (!text || !s) return
    lastDesktop = text
    s.mirror.setClipboard(text, true)
  })

  ipcMain.handle('record:start', async (_e, serial: string, deviceName: string) => {
    const s = sessions.get(serial)
    if (!s) throw new Error('Not mirroring')
    if (s.recordingSince !== null) return
    const dir = settings().recordingsDir
    await mkdir(dir, { recursive: true })
    s.mirror.startRecording(join(dir, timestampedName(deviceName, 'mp4')))
    s.recordingSince = Date.now()
    broadcast('record:state', serial, s.recordingSince)
  })
  ipcMain.on('record:stop', (_e, serial: string) => finishRecording(serial))
  ipcMain.handle('record:get-state', (_e, serial: string) => sessions.get(serial)?.recordingSince ?? null)
}

/** Hands `serial`'s stream to another window (pop-out and back). */
export function transferOwner(serial: string, to: WebContents): void {
  owners.set(serial, to)
  primeOwner(serial)
}

/** A window that just became the owner has fresh decoders: keyframe + audio config. */
function primeOwner(serial: string): void {
  const s = sessions.get(serial)
  if (!s) return
  s.mirror.requestKeyframe()
  if (s.lastAudioConfig) sendTo(serial, 'audio:packet', s.lastAudioConfig, serial)
}

export const isMirroring = (serial: string) => sessions.has(serial)

/** The name macOS gives a USB iPhone's screen (the phone's own name). */
export function iosCaptureName(serial: string): string | null {
  return iosDevicesSeen.find((d) => d.serial === serial)?.model ?? null
}

function listIosDevices(): AndroidDevice[] {
  if (process.platform !== 'darwin' || !existsSync(iosHelperPath)) return []
  if (!iosWatcher) startIosWatcher()
  return iosDevicesSeen
}

function startIosWatcher(): void {
  const child = spawn(iosHelperPath, ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'] })
  iosWatcher = child
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const found = JSON.parse(line) as { id: string; name: string }[]
        iosDevicesSeen = found.map((d) => ({ serial: IOS_PREFIX + d.id, state: 'device', model: d.name, transport: 'usb', platform: 'ios' }))
      } catch {
        // Ignore partial or unexpected lines.
      }
    }
  })
  child.on('exit', () => {
    if (iosWatcher !== child) return
    // The next device poll starts a new watcher.
    iosWatcher = null
    iosDevicesSeen = []
  })
}

/** Stops the iPhone watcher (app quitting). */
export function stopIosWatcher(): void {
  const child = iosWatcher
  iosWatcher = null
  child?.stdin?.end()
  child?.kill()
}

/**
 * Connection Doctor: checks that the phone can stream. Never disturbs a
 * running session; otherwise starts a short low-quality one.
 */
export async function probeStream(serial: string): Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }> {
  if (sessions.has(serial)) return { ok: true, alreadyRunning: true }
  let session: AndroidMirror | null = null
  try {
    let gotFrame: () => void = () => {}
    const firstFrame = new Promise<void>((resolve) => (gotFrame = resolve))
    session = await native.startAndroidMirror(
      serial,
      serverJarPath,
      { maxSize: 720, bitRate: 2_000_000, owner: owner() },
      () => gotFrame(),
      () => {},
      () => {},
      () => {}
    )
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), PROBE_TIMEOUT_MS))
    const outcome = await Promise.race([firstFrame, timeout])
    return outcome === 'timeout' ? { ok: false, error: 'No video within 6 seconds' } : { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await session?.stop()
  }
}

/**
 * Connection Doctor, iPhone over a cable: a short capture through macOS until
 * the first frame. Never disturbs a running session.
 */
export async function probeIosStream(serial: string): Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }> {
  if (sessions.has(serial)) return { ok: true, alreadyRunning: true }
  let session: Awaited<ReturnType<typeof native.startIosMirror>> | null = null
  try {
    let gotFrame: () => void = () => {}
    let closed: (reason: string) => void = () => {}
    const firstFrame = new Promise<void>((resolve) => (gotFrame = resolve))
    const ended = new Promise<string>((resolve) => (closed = resolve))
    session = await native.startIosMirror(iosHelperPath, serial.slice(IOS_PREFIX.length), 'iPhone', 2_000_000, () => gotFrame(), (reason) => closed(reason), false, () => {})
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), PROBE_TIMEOUT_MS))
    const outcome = await Promise.race([firstFrame.then(() => 'frame' as const), ended, timeout])
    if (outcome === 'frame') return { ok: true }
    return { ok: false, error: outcome === 'timeout' ? 'No video within 6 seconds' : outcome || 'The capture stopped' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await session?.stop()
  }
}

/** iPhones plugged in by cable, as macOS screen capture sees them. */
export const usbIphones = (): AndroidDevice[] => listIosDevices()
/** Whether the iPhone capture helper is part of this build. */
export const iosHelperAvailable = (): boolean => process.platform === 'darwin' && existsSync(iosHelperPath)

/** Desktop → phone: copy on the computer, paste on any mirrored phone. */
async function startClipboardSync(): Promise<void> {
  if (clipboardTimer) return
  lastDesktop = await clipboard.readText()
  // Mirroring may have stopped while the clipboard was being read.
  if (sessions.size === 0 || clipboardTimer) return
  clipboardTimer = setInterval(async () => {
    if (!settings().clipboardSync) return
    const text = await clipboard.readText()
    if (sessions.size === 0 || !text || text === lastDesktop || text === lastFromPhone) return
    lastDesktop = text
    for (const s of sessions.values()) s.mirror.setClipboard(text, false)
  }, CLIPBOARD_POLL_MS)
}

/** Stops `serial`'s session and cancels any start still in flight. */
export async function stopMirror(serial: string): Promise<void> {
  bump(serial)
  stopIosControl(serial)
  await stopSession(serial)
}

export async function stopAllMirrors(): Promise<void> {
  stopAllIosControl()
  await Promise.all([...sessions.keys()].map((serial) => stopMirror(serial)))
}

async function stopSession(serial: string): Promise<void> {
  const s = sessions.get(serial)
  if (!s) return
  // An unplugged phone or a stop still leaves a finished, playable file.
  finishRecording(serial)
  sessions.delete(serial)
  if (sessions.size === 0 && clipboardTimer) {
    clearInterval(clipboardTimer)
    clipboardTimer = null
  }
  await s.mirror.stop()
}
