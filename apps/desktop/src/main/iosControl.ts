// Developer control for iPhones: drives the phone through the user's own
// Appium WebDriverAgent build (Developer Mode, signed with their team).
// Off by default, shown on screen while on, and stopped with the mirror.
//
// WebDriverAgent runs as an XCTest on the phone (xcodebuild
// test-without-building) and serves HTTP on port 8100, reached through a
// usbmux tunnel: control needs the cable (iPhones on Wi-Fi are view only).

import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isCompanionSerial, type InputEvent, type IosControlState } from '../shared-ipc'
import { udidForSerial } from './iosDevices'
import { native } from './native'
import { t } from './i18n'

const WDA_PORT = 8100
const START_TIMEOUT_MS = 90_000
/** Shorter than this, with little movement, is a tap; longer is a long press. */
const LONG_PRESS_MS = 500
/** Movement below this (in points) still counts as a tap. */
const TAP_SLOP = 8
const SCROLL_SETTLE_MS = 120

interface Controller {
  process: ChildProcess
  forward: { stop(): void } | null
  base: string
  session: string
  size: { width: number; height: number }
  queue: Promise<unknown>
  pointer: { x: number; y: number; t: number; lastX: number; lastY: number } | null
  scroll: { x: number; y: number; dy: number; dx: number; timer: NodeJS.Timeout } | null
}

const controllers = new Map<string, Controller>()
const starting = new Map<string, ChildProcess>()

function broadcastState(serial: string, state: IosControlState): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ios-control:state', serial, state)
}

/** Newest WebDriverAgent test bundle built for a real iPhone (Appium's Xcode build). */
export function findWda(): string | null {
  if (process.env.MIRROR_WDA_XCTESTRUN) return process.env.MIRROR_WDA_XCTESTRUN
  const derived = join(homedir(), 'Library/Developer/Xcode/DerivedData')
  const found: { path: string; mtime: number }[] = []
  try {
    for (const dir of readdirSync(derived)) {
      if (!dir.startsWith('WebDriverAgent-')) continue
      const products = join(derived, dir, 'Build/Products')
      try {
        for (const f of readdirSync(products)) {
          if (f.startsWith('WebDriverAgentRunner_iphoneos') && f.endsWith('.xctestrun')) {
            const path = join(products, f)
            found.push({ path, mtime: statSync(path).mtimeMs })
          }
        }
      } catch {
        // No products in this build folder.
      }
    }
  } catch {
    return null
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null
}

async function wda(base: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000)
  })
  const json = (await res.json()) as { value?: any; sessionId?: string }
  if (!res.ok) throw new Error(json.value?.message ?? `WebDriverAgent answered ${res.status}`)
  return json
}

export async function startIosControl(serial: string): Promise<void> {
  if (controllers.has(serial) || starting.has(serial)) return
  const xctestrun = findWda()
  if (!xctestrun) throw new Error(`[ios_control] ${t('iosControlMain.notFound')}`)
  broadcastState(serial, { kind: 'starting' })
  let child: ChildProcess | null = null
  let forward: { stop(): void } | null = null
  try {
    if (isCompanionSerial(serial)) throw new Error(`[needs_cable] ${t('iosControl.needsCable')}`)
    const udid = await udidForSerial(serial, 'control')
    child = spawn('xcodebuild', ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${udid}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    starting.set(serial, child)
    await new Promise<string>((resolve, reject) => {
      let log = ''
      const timer = setTimeout(() => reject(new Error(`[ios_control] ${t('iosControlMain.timeout')}`)), START_TIMEOUT_MS)
      const onData = (d: Buffer) => {
        log = (log + d.toString()).slice(-20_000)
        const url = /ServerURLHere->(\S+)<-ServerURLHere/.exec(log)?.[1]
        if (url) {
          clearTimeout(timer)
          resolve(url)
        } else if (/Testing failed|\*\* TEST EXECUTE FAILED|Developer Mode/.test(log)) {
          clearTimeout(timer)
          const reason = /(Developer Mode[^\n]*|The developer[^\n]*trust[^\n]*|Testing failed:[^\n]*\n[^\n]*)/i.exec(log)?.[1]?.trim()
          reject(new Error(`[ios_control] ${reason ? t('iosControlMain.failedReason', { reason }) : t('iosControlMain.failed')}`))
        }
      }
      child!.stdout!.on('data', onData)
      child!.stderr!.on('data', onData)
      child!.on('exit', () => {
        clearTimeout(timer)
        reject(new Error(`[ios_control] ${t('iosControlMain.stoppedStarting')}`))
      })
    })
    const f = await native.forwardIosPort(udid, WDA_PORT)
    forward = f
    const base = `http://127.0.0.1:${f.port}`
    const created = await wda(base, 'POST', '/session', { capabilities: { alwaysMatch: {} } })
    const session = created.sessionId ?? created.value?.sessionId
    const size = (await wda(base, 'GET', `/session/${session}/window/size`)).value as { width: number; height: number }
    if (!starting.has(serial)) throw new Error('[superseded] Developer control was turned off')
    starting.delete(serial)
    const c: Controller = { process: child, forward, base, session, size, queue: Promise.resolve(), pointer: null, scroll: null }
    controllers.set(serial, c)
    child.on('exit', () => {
      if (controllers.get(serial) === c) {
        controllers.delete(serial)
        c.forward?.stop()
        broadcastState(serial, { kind: 'error', message: t('iosControlMain.stopped') })
      }
    })
    broadcastState(serial, { kind: 'on' })
  } catch (e) {
    starting.delete(serial)
    forward?.stop()
    child?.kill()
    const message = (e as Error).message.replace(/^\[\w+\]\s*/, '')
    broadcastState(serial, { kind: 'error', message })
    throw e
  }
}

export function stopIosControl(serial: string): void {
  starting.get(serial)?.kill()
  starting.delete(serial)
  const c = controllers.get(serial)
  if (!c) return
  controllers.delete(serial)
  c.forward?.stop()
  c.process.kill()
  broadcastState(serial, { kind: 'off' })
}

export function stopAllIosControl(): void {
  for (const serial of [...controllers.keys(), ...starting.keys()]) stopIosControl(serial)
}

export const iosControlActive = (serial: string) => controllers.has(serial)

/** Runs WebDriverAgent calls one at a time, in input order. */
function enqueue(c: Controller, path: string, body: unknown): void {
  c.queue = c.queue
    .then(() => wda(c.base, 'POST', `/session/${c.session}${path}`, body))
    .catch((e: unknown) => console.warn('[ios-control]', path, (e as Error).message))
}

/** Desktop input → WebDriverAgent gestures. Returns false when control is off. */
export function injectIos(serial: string, event: InputEvent): boolean {
  const c = controllers.get(serial)
  if (!c) return false
  const pt = (nx: number, ny: number) => ({ x: Math.round(nx * c.size.width), y: Math.round(ny * c.size.height) })
  switch (event.type) {
    case 'pointer': {
      const p = pt(event.x, event.y)
      if (event.action === 'down') c.pointer = { x: p.x, y: p.y, t: Date.now(), lastX: p.x, lastY: p.y }
      else if (event.action === 'move' && c.pointer) Object.assign(c.pointer, { lastX: p.x, lastY: p.y })
      else if (event.action === 'up' && c.pointer) {
        const start = c.pointer
        c.pointer = null
        const held = Date.now() - start.t
        if (Math.hypot(p.x - start.x, p.y - start.y) < TAP_SLOP) {
          if (held >= LONG_PRESS_MS) enqueue(c, '/wda/touchAndHold', { x: start.x, y: start.y, duration: held / 1000 })
          else enqueue(c, '/wda/tap', { x: start.x, y: start.y })
        } else {
          // Replays the drag with its real speed, so flings scroll like a finger.
          enqueue(c, '/actions', {
            actions: [
              {
                type: 'pointer',
                id: 'finger',
                parameters: { pointerType: 'touch' },
                actions: [
                  { type: 'pointerMove', duration: 0, x: start.x, y: start.y },
                  { type: 'pointerDown' },
                  { type: 'pointerMove', duration: Math.min(Math.max(held, 80), 1500), x: p.x, y: p.y },
                  { type: 'pointerUp' }
                ]
              }
            ]
          })
        }
      }
      return true
    }
    case 'scroll': {
      // Wheel ticks are gathered into one swipe once the wheel settles.
      const p = pt(event.x, event.y)
      if (c.scroll) clearTimeout(c.scroll.timer)
      const s = c.scroll ?? { x: p.x, y: p.y, dx: 0, dy: 0, timer: undefined as unknown as NodeJS.Timeout }
      s.dx += event.dx
      s.dy += event.dy
      s.timer = setTimeout(() => {
        c.scroll = null
        const dist = (v: number) => Math.max(-0.35, Math.min(0.35, v * 0.08))
        const toX = Math.round(s.x + dist(s.dx) * c.size.width)
        const toY = Math.round(s.y + dist(s.dy) * c.size.height)
        enqueue(c, '/wda/dragfromtoforduration', { fromX: s.x, fromY: s.y, toX, toY, duration: 0.05 })
      }, SCROLL_SETTLE_MS)
      c.scroll = s
      return true
    }
    case 'text':
      enqueue(c, '/wda/keys', { value: [event.text] })
      return true
    case 'key': {
      if (!event.down) return true
      const key = event.key
      if (key === 'home') enqueue(c, '/wda/pressButton', { name: 'home' })
      else if (key === 'volume_up') enqueue(c, '/wda/pressButton', { name: 'volumeUp' })
      else if (key === 'volume_down') enqueue(c, '/wda/pressButton', { name: 'volumeDown' })
      else if (key === 'power') enqueue(c, '/wda/lock', {})
      else if (typeof key === 'object') {
        const typed: Record<string, string> = { Backspace: '\b', Enter: '\n', NumpadEnter: '\n', Tab: '\t', Delete: '\u007f' }
        const value = typed[key.code]
        if (value) enqueue(c, '/wda/keys', { value: [value] })
      }
      return true
    }
  }
}

export function registerIosControlIpc(): void {
  ipcMain.handle('ios-control:available', () => findWda() !== null && process.platform === 'darwin')
  ipcMain.handle('ios-control:start', (_e, serial: string) => startIosControl(serial))
  ipcMain.on('ios-control:stop', (_e, serial: string) => stopIosControl(serial))
  ipcMain.handle('ios-control:get-state', (_e, serial: string): IosControlState =>
    controllers.has(serial) ? { kind: 'on' } : starting.has(serial) ? { kind: 'starting' } : { kind: 'off' }
  )
}
