// Device windows: frameless, transparent windows that show only a phone,
// like an emulator. Two kinds:
//   popout: the main window's phone moves into it (main hides, the session
//           keeps running and is handed over);
//   extra:  another phone, with its own session, next to the main window.

import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import type { DeviceWindowParams } from '../shared-ipc'
import { stopMirror, transferOwner } from './mirror'

/** Width of the side toolbar in the device window (keep in sync with DeviceView). */
const TOOLBAR_WIDTH = 64
/** Transparent margin around the bezel for its shadow (keep in sync with DeviceView). */
const MARGIN = 16
const MIN_HEIGHT = 360
/** Key for the test stream, which has no serial. */
export const FIXTURE_KEY = 'fixture'

interface DeviceWin {
  win: BrowserWindow
  params: DeviceWindowParams
  aspect: number
  defaultHeight: number
}

const windows = new Map<string, DeviceWin>()

const keyOf = (p: DeviceWindowParams) => p.serial ?? FIXTURE_KEY

function byContents(contents: WebContents): DeviceWin | undefined {
  return [...windows.values()].find((d) => d.win.webContents === contents)
}

/** Where the test stream's frames go: its popped-out window, or the main window. */
export function fixtureWindow(main: BrowserWindow | null): BrowserWindow | null {
  const d = windows.get(FIXTURE_KEY)
  return d && !d.win.isDestroyed() ? d.win : main
}

function sizeFor(aspect: number, height: number) {
  const screenHeight = height - 2 * MARGIN
  return { width: Math.round(screenHeight * aspect) + 2 * MARGIN + TOOLBAR_WIDTH, height: Math.round(height) }
}

function lockAspect(d: DeviceWin, aspect: number): void {
  d.aspect = aspect
  // Extra size (toolbar + margins) is excluded from the ratio; macOS only,
  // elsewhere the window is still resizable freely and the phone letterboxes.
  d.win.setAspectRatio(aspect, { width: TOOLBAR_WIDTH + 2 * MARGIN, height: 2 * MARGIN })
}

function broadcastOpen(): void {
  const keys = [...windows.keys()]
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('device-windows:changed', keys)
}

export function registerDeviceWindowIpc({ mainWindow, onFixtureSwitch }: {
  mainWindow: () => BrowserWindow | null
  onFixtureSwitch: () => void
}): void {
  ipcMain.on('device-window:open', (_e, params: DeviceWindowParams) => {
    const main = mainWindow()
    const key = keyOf(params)
    const existing = windows.get(key)
    if (existing) return existing.win.focus()
    if (!main) return

    const work = screen.getDisplayMatching(main.getBounds()).workArea
    const height = Math.min(work.height * 0.88, 960)
    const { width } = sizeFor(params.aspect, height)
    // Extra windows cascade so several phones don't stack exactly.
    const offset = params.mode === 'extra' ? 32 * windows.size : 0
    const win = new BrowserWindow({
      width,
      height: Math.round(height),
      x: Math.round(work.x + (work.width - width) / 2 + offset),
      y: Math.round(work.y + (work.height - height) / 2 + offset),
      minHeight: MIN_HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: true,
      fullscreenable: false,
      backgroundColor: '#00000000',
      title: params.name,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true
      }
    })
    const d: DeviceWin = { win, params, aspect: params.aspect, defaultHeight: height }
    windows.set(key, d)
    lockAspect(d, params.aspect)

    const query = new URLSearchParams({
      name: params.name,
      aspect: String(params.aspect),
      controllable: params.controllable ? '1' : '0',
      serial: params.serial ?? '',
      mode: params.mode
    })
    const hash = `device?${query}`
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })

    win.once('ready-to-show', () => {
      win.show()
      if (params.mode === 'popout') {
        main.hide()
        if (!params.serial) onFixtureSwitch()
      }
      broadcastOpen()
    })
    win.on('closed', () => {
      windows.delete(key)
      if (params.mode === 'popout') {
        main.show()
        // Hand the stream back to the main window's decoders.
        if (params.serial) transferOwner(params.serial, main.webContents)
        else onFixtureSwitch()
      } else if (params.serial) {
        void stopMirror(params.serial)
      }
      broadcastOpen()
    })
  })

  ipcMain.on('device-window:close', (e) => byContents(e.sender)?.win.close())
  ipcMain.on('device-window:focus', (_e, serial: string) => windows.get(serial)?.win.focus())
  ipcMain.handle('device-windows:list', () => [...windows.keys()])

  ipcMain.on('device-window:aspect', (e, aspect: number) => {
    const d = byContents(e.sender)
    if (!d) return
    // Rotation: keep the height, adapt the width, recenter horizontally.
    const b = d.win.getBounds()
    const { width, height } = sizeFor(aspect, b.height)
    lockAspect(d, aspect)
    d.win.setBounds({ x: Math.round(b.x + (b.width - width) / 2), y: b.y, width, height })
  })

  // Transparent windows can't be resized from their edges, so the renderer
  // drives resizing from a grip. Height 0 means "back to the default size".
  ipcMain.on('device-window:resize', (e, requested: number) => {
    const d = byContents(e.sender)
    if (!d) return
    const b = d.win.getBounds()
    const work = screen.getDisplayMatching(b).workArea
    const target = requested > 0 ? requested : d.defaultHeight
    const height = Math.round(Math.min(Math.max(target, MIN_HEIGHT), work.height))
    const size = sizeFor(d.aspect, height)
    d.win.setBounds({ x: b.x, y: b.y, width: size.width, height: size.height })
  })

  ipcMain.handle('device-window:always-on-top', (e, on: boolean) => {
    const d = byContents(e.sender)
    d?.win.setAlwaysOnTop(on, 'floating')
    return d?.win.isAlwaysOnTop() ?? false
  })
}
