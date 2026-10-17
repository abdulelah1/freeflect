// Screenshots and drag-and-drop transfers to the phone.

import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, shell, type WebContents } from 'electron'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { COMPANION_PREFIX, isCompanionSerial, isIosSerial, type Transfer } from '../shared-ipc'
import { sendFileToCompanion } from './companion'
import { udidForSerial } from './iosDevices'
import { settings } from './settings'
import { native } from './native'

/** Copied screenshots stay on disk this long so they can still be pasted as files. */
const COPIED_SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000

let nextTransferId = 1
// Transfers run one at a time so progress is meaningful and adb isn't flooded.
let queue: Promise<void> = Promise.resolve()

export function registerFileIpc(getContents: () => WebContents | undefined): void {
  contentsRef = getContents
  ipcMain.handle('screenshot:save', async (_e, png: ArrayBuffer, deviceName: string) => {
    const dir = settings().screenshotsDir
    await mkdir(dir, { recursive: true })
    const path = join(dir, screenshotFileName(deviceName))
    await writeFile(path, Buffer.from(png))
    return path
  })

  // The image data pastes into apps like Notes; Finder only pastes files, so
  // the PNG is also written to a temp file and offered as a file reference.
  ipcMain.handle('screenshot:copy', async (_e, png: ArrayBuffer, deviceName: string) => {
    const dir = join(app.getPath('temp'), 'Mirror Screenshots')
    await mkdir(dir, { recursive: true })
    void removeOlderThan(dir, COPIED_SCREENSHOT_TTL_MS)
    const path = join(dir, screenshotFileName(deviceName))
    await writeFile(path, Buffer.from(png))
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([png], { type: 'image/png' }),
        [NATIVE_FILE_URL]: new Blob([pathToFileURL(path).href], { type: 'text/plain' })
      })
    ])
  })

  ipcMain.handle('gif:save', async (_e, gif: ArrayBuffer, deviceName: string) => {
    const dir = settings().recordingsDir
    await mkdir(dir, { recursive: true })
    const path = join(dir, timestampedName(deviceName, 'gif'))
    await writeFile(path, Buffer.from(gif))
    return path
  })

  ipcMain.on('shell:show-in-folder', (_e, path: string) => shell.showItemInFolder(path))

  ipcMain.handle('files:list', (_e, serial: string, path: string) => native.listPhoneDir(serial, path))
  ipcMain.handle('ios-files:media', async (_e, serial: string) => native.listIosMedia(await udidForSerial(serial, 'browse')))

  // Drag a phone file out to Finder/Explorer: startDrag needs a real local
  // file, so it is downloaded to a temp folder first (while the button is held).
  ipcMain.on('files:drag', async (e, serial: string, remote: string) => {
    if (!isPhonePath(remote)) return
    const dir = join(app.getPath('temp'), 'Mirror Drag')
    await mkdir(dir, { recursive: true })
    void removeOlderThan(dir, COPIED_SCREENSHOT_TTL_MS)
    const local = join(dir, basename(remote))
    try {
      await pull(serial, remote, local, () => {})
      const icon = await app.getFileIcon(local, { size: 'normal' })
      e.sender.startDrag({ file: local, icon })
    } catch {
      // The drag simply doesn't start; the Save button reports errors.
    }
  })

  ipcMain.on('files:save-as', async (e, serial: string, remote: string) => {
    if (!isPhonePath(remote)) return
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options = { defaultPath: join(app.getPath('downloads'), basename(remote)) }
    const { canceled, filePath } = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return
    queue = queue.then(() => download(serial, remote, filePath, (t) => getContents()?.send('files:transfer', t)))
  })

  ipcMain.handle('files:delete', async (_e, serial: string, remote: string) => {
    if (!isPhonePath(remote) || remote.split('/').filter(Boolean).length < 2) throw new Error('Not allowed')
    // Single-quoted for the device shell; the path comes from the window.
    await native.deviceShell(serial, `rm -rf '${remote.replaceAll("'", "'\\''")}'`)
  })

  ipcMain.on('files:send', (_e, serial: string, paths: string[]) => {
    for (const path of paths) {
      queue = queue.then(() => transfer(serial, path, (t) => getContents()?.send('files:transfer', t)))
    }
  })
}

/** Raw pasteboard type for a file reference (Finder pastes these as files). */
const NATIVE_FILE_URL =
  process.platform === 'darwin'
    ? 'electron application/osclipboard;format="public.file-url"'
    : 'text/uri-list'

function screenshotFileName(deviceName: string): string {
  return timestampedName(deviceName, 'png')
}

/** `<device> 2026-10-13 23.20.01.<ext>` in local time. */
export function timestampedName(deviceName: string, ext: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  // Local time; dots instead of colons, which are invalid in Windows paths.
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  const safeName = deviceName.replace(/[^\w\- ]+/g, '').trim() || 'Phone'
  return `${safeName} ${stamp}.${ext}`
}

async function removeOlderThan(dir: string, ageMs: number): Promise<void> {
  const cutoff = Date.now() - ageMs
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info && info.mtimeMs < cutoff) await rm(path, { force: true })
  }
}

/** Phone storage only: never let the window name system paths. */
const isPhonePath = (p: string) => /^\/(sdcard|storage|DCIM)\//.test(p) && !p.split('/').includes('..')

/** Downloads from an Android phone (adb) or an iPhone (AFC over USB). */
async function pull(serial: string, remote: string, local: string, onProgress: (p: { sent: number; total: number }) => void) {
  if (isIosSerial(serial)) await native.pullIosFile(await udidForSerial(serial, 'copy'), remote, local, onProgress)
  else await native.pullFile(serial, remote, local, onProgress)
}

async function download(serial: string, remote: string, local: string, report: (t: Transfer) => void): Promise<void> {
  const t: Transfer = { id: nextTransferId++, name: basename(remote), kind: 'pull', sent: 0, total: 0, state: 'active', path: local }
  report({ ...t })
  try {
    await pull(serial, remote, local, (p) => report({ ...t, sent: p.sent, total: p.total }))
    report({ ...t, state: 'done', sent: 1, total: 1 })
  } catch (e) {
    report({ ...t, state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

/** Installs an APK through the shared transfer queue (progress toasts). */
export function queueApkInstall(serial: string, path: string): void {
  queue = queue.then(() => transfer(serial, path, (t) => contentsRef?.()?.send('files:transfer', t)))
}

let contentsRef: (() => WebContents | undefined) | null = null

async function transfer(serial: string, path: string, report: (t: Transfer) => void): Promise<void> {
  const name = basename(path)
  const kind = extname(path).toLowerCase() === '.apk' ? 'install' : 'push'
  const t: Transfer = { id: nextTransferId++, name, kind, sent: 0, total: 0, state: 'active' }
  report({ ...t })
  const onProgress = (p: { sent: number; total: number }) => report({ ...t, sent: p.sent, total: p.total })
  try {
    if (isCompanionSerial(serial)) {
      // Into the companion app's documents (Files app, On My iPhone, FreeFlect).
      await sendFileToCompanion(serial.slice(COMPANION_PREFIX.length), path)
      report({ ...t, kind: 'push', state: 'done', sent: 1, total: 1 })
      return
    }
    if (kind === 'install') await native.installApk(serial, path, onProgress)
    else await native.pushFile(serial, path, `${settings().androidFolder.replace(/\/$/, '')}/${name}`, onProgress)
    report({ ...t, state: 'done', sent: 1, total: 1 })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    report({ ...t, state: 'error', message })
  }
}
