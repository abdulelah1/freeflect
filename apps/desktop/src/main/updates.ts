// New-version check against the GitHub Releases page. The app is signed
// ad hoc (not with Apple's Developer ID), so it can't replace itself: it
// tells the user and opens the release page to download the new DMG.

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateInfo } from '../shared-ipc'
import { settings } from './settings'

const DAY_MS = 24 * 60 * 60 * 1000

/** "owner/repo" from package.json ("mirror": { "releasesRepo" }); empty until the repo is linked. */
function releasesRepo(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { mirror?: { releasesRepo?: string } }
    return pkg.mirror?.releasesRepo?.trim() ?? ''
  } catch {
    return ''
  }
}

/** True when `a` is a newer x.y.z than `b`. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!
  return false
}

async function latest(): Promise<UpdateInfo | null> {
  const repo = releasesRepo()
  if (!repo) return null
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `FreeFlect/${app.getVersion()}` },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) return null
  const release = (await res.json()) as { tag_name: string; html_url: string; body?: string; draft?: boolean; prerelease?: boolean }
  if (release.draft || release.prerelease || !isNewer(release.tag_name, app.getVersion())) return null
  return { version: release.tag_name.replace(/^v/, ''), url: release.html_url, notes: (release.body ?? '').slice(0, 2000) }
}

export function startUpdateChecks(): void {
  ipcMain.handle('update:check', () => latest().catch(() => null))
  // Only release pages on GitHub open from the window.
  ipcMain.on('shell:open-external', (_e, url: string) => {
    if (/^https:\/\/github\.com\//.test(url)) void shell.openExternal(url)
  })
  const check = async () => {
    if (!settings().checkForUpdates || process.env.MIRROR_SMOKE) return
    const update = await latest().catch(() => null)
    if (update) for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:available', update)
  }
  setTimeout(() => void check(), 10_000)
  setInterval(() => void check(), DAY_MS)
}
