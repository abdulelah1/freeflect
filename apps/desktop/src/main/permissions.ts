// macOS permission prompts are never the first thing the user sees: the
// window explains why FreeFlect needs access, and only after the user agrees
// does macOS ask.
//
// - Camera and microphone (an iPhone on a cable): starting the capture throws
//   `[needs_permission] camera|microphone` while macOS hasn't asked yet; the
//   window explains, then asks through `permissions:request` and retries.
// - Keychain (after an update) and the local network (pairing): explained in
//   the window before the code that makes macOS ask runs.

import { app, ipcMain, systemPreferences, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { MediaPermission, PermissionKind } from '../shared-ipc'

const run = promisify(execFile)

export function mediaStatus(kind: MediaPermission): string {
  return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus(kind) : 'granted'
}

/** Refuses to go on while macOS would still ask about `kinds`; the window explains, then asks. */
export function requireMediaDecided(kinds: MediaPermission[]): void {
  for (const kind of kinds) {
    if (mediaStatus(kind) === 'not-determined') throw new Error(`[needs_permission] ${kind}`)
  }
}

let adhoc: Promise<boolean> | null = null

/**
 * Ad hoc signed builds count as a new app to the keychain after every update,
 * so macOS asks again for the items an older build saved.
 */
export function isAdhocSigned(): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged) return Promise.resolve(false)
  adhoc ??= run('codesign', ['-dv', join(process.execPath, '../../..')])
    .then(({ stderr }) => /Signature=adhoc/.test(stderr))
    .catch(() => true)
  return adhoc
}

let nextRequest = 0
const answers = new Map<number, (ok: boolean) => void>()

/** Shows the explanation for `kind` in `win`; true when the user chose to go ahead. */
export async function explainInWindow(win: BrowserWindow | null, kind: PermissionKind): Promise<boolean> {
  if (!win || win.isDestroyed()) return false
  if (win.webContents.isLoading()) await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
  const id = ++nextRequest
  return new Promise((resolve) => {
    answers.set(id, resolve)
    win.webContents.send('permission:explain', id, kind)
    win.once('closed', () => {
      answers.delete(id)
      resolve(false)
    })
  })
}

export function registerPermissionIpc(): void {
  ipcMain.handle('permissions:status', (_e, kind: MediaPermission) => mediaStatus(kind))
  // Only after the window has explained it and the user agreed.
  ipcMain.handle('permissions:request', async (_e, kind: MediaPermission) => {
    if (kind !== 'camera' && kind !== 'microphone') return false
    if (process.platform !== 'darwin') return true
    return systemPreferences.askForMediaAccess(kind)
  })
  ipcMain.on('permission:answer', (_e, id: number, ok: boolean) => {
    answers.get(id)?.(!!ok)
    answers.delete(id)
  })
}
