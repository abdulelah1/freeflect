// App settings, stored in the profile (settings.json) and shared with every
// window. The main process owns them because it writes the files.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, FolderSetting } from '../shared-ipc'

/** The app's folder on the Desktop, also used for its other default folders. */
export const APP_FOLDER = 'FreeFlect'
/** The app's folder name before it was renamed FreeFlect. */
const OLD_APP_FOLDER = 'Mirror'

export function defaultSettings(): AppSettings {
  // Smoke runs use a throwaway profile; keep their files out of the user's folders too.
  const smoke = process.env.MIRROR_SMOKE ? app.getPath('userData') : null
  return {
    screenshotsDir: join(smoke ?? app.getPath('desktop'), APP_FOLDER),
    recordingsDir: join(smoke ?? app.getPath('desktop'), APP_FOLDER),
    receivedFilesDir: join(smoke ?? app.getPath('downloads'), 'From iPhone'),
    androidFolder: '/sdcard/Download',
    hideChromeInFullscreen: false,
    clipboardSync: true,
    // Off until the user pairs an iPhone: nothing listens on the network before that.
    companionEnabled: false,
    companionSigning: null,
    checkForUpdates: true,
    language: 'system'
  }
}

const file = () => join(app.getPath('userData'), 'settings.json')
let current: AppSettings | null = null
const listeners: ((s: AppSettings, previous: AppSettings) => void)[] = []

export function settings(): AppSettings {
  if (!current) {
    let saved: Partial<AppSettings> = {}
    try {
      saved = JSON.parse(readFileSync(file(), 'utf8')) as Partial<AppSettings>
    } catch {
      // First run, or an unreadable file: defaults.
    }
    // Old defaults (Movies, and the folders named after the old app name)
    // follow the new ones; folders chosen on purpose stay.
    const oldDefaults = [
      join(app.getPath('videos'), APP_FOLDER),
      join(app.getPath('videos'), OLD_APP_FOLDER),
      join(app.getPath('desktop'), OLD_APP_FOLDER)
    ]
    if (saved.recordingsDir && oldDefaults.includes(saved.recordingsDir)) delete saved.recordingsDir
    if (saved.screenshotsDir && oldDefaults.includes(saved.screenshotsDir)) delete saved.screenshotsDir
    current = { ...defaultSettings(), ...saved }
  }
  return current
}

/** Called after every change with the new and previous values. */
export function onSettingsChange(cb: (s: AppSettings, previous: AppSettings) => void): void {
  listeners.push(cb)
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const previous = settings()
  const next = { ...previous, ...patch }
  // Android paths must stay in shared storage (no system folders).
  if (!/^\/(sdcard|storage)\//.test(next.androidFolder) || next.androidFolder.split('/').includes('..')) {
    next.androidFolder = previous.androidFolder
  }
  current = next
  await writeFile(file(), JSON.stringify(next, null, 2))
  for (const cb of listeners) cb(next, previous)
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', next)
  return next
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => settings())
  ipcMain.handle('settings:defaults', () => defaultSettings())
  // Only the configured folders can be opened from the window.
  ipcMain.handle('settings:open-folder', async (_e, key: FolderSetting) => {
    const dir = settings()[key]
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => updateSettings(patch))
  ipcMain.handle('settings:choose-folder', async (e, key: FolderSetting) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { defaultPath: settings()[key], properties: ['openDirectory', 'createDirectory'] as const }
    const result = win ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] }) : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || !result.filePaths[0]) return settings()
    return updateSettings({ [key]: result.filePaths[0] })
  })
}
