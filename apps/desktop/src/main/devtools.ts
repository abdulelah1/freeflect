// Developer tools: live logcat, app management and device stats. Every phone
// command here is fixed; package names from the window are validated.

import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppAction, DeviceStats } from '../shared-ipc'
import { queueApkInstall } from './files'
import { native } from './native'

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/

const APP_COMMANDS: Record<AppAction, (pkg: string) => string> = {
  launch: (pkg) => `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`,
  stop: (pkg) => `am force-stop ${pkg}`,
  clear: (pkg) => `pm clear ${pkg}`,
  uninstall: (pkg) => `pm uninstall ${pkg}`
}

/** One logcat stream per window. */
const logStreams = new Map<WebContents, { stop(): void }>()
/** Previous /proc/stat sample per phone, for CPU usage between polls. */
const cpuSamples = new Map<string, { busy: number; total: number }>()

export function registerDevToolsIpc(): void {
  ipcMain.handle('dev:logcat-start', async (e, serial: string) => {
    stopLogs(e.sender)
    const stream = await native.streamShell(serial, 'logcat -v threadtime -T 500', (lines) => {
      if (!e.sender.isDestroyed()) e.sender.send('dev:logcat', serial, lines)
    })
    logStreams.set(e.sender, stream)
    e.sender.once('destroyed', () => stopLogs(e.sender))
  })
  ipcMain.on('dev:logcat-stop', (e) => stopLogs(e.sender))

  ipcMain.handle('dev:apps', async (_e, serial: string) => {
    const out = await native.deviceShell(serial, 'pm list packages -3')
    return out
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((p) => PACKAGE_RE.test(p))
      .sort()
  })

  ipcMain.handle('dev:app-action', async (_e, serial: string, pkg: string, action: AppAction) => {
    if (!PACKAGE_RE.test(pkg) || !(action in APP_COMMANDS)) throw new Error('Invalid app')
    const out = await native.deviceShell(serial, APP_COMMANDS[action](pkg))
    if (/Failure|Exception|Error/i.test(out) && !/Events injected/.test(out)) throw new Error(out.trim())
  })

  ipcMain.handle('farm:open-url', async (_e, serials: string[], url: string) => {
    // Only plain http(s) links, single-quoted for the device shell.
    if (!/^https?:\/\/[^\s'"\\]+$/.test(url)) throw new Error('Enter a link that starts with http:// or https://')
    await Promise.all(serials.map((s) => native.deviceShell(s, `am start -a android.intent.action.VIEW -d '${url}'`)))
  })

  ipcMain.handle('dev:install', async (e, target: string | string[]) => {
    const serials = Array.isArray(target) ? target : [target]
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options = { filters: [{ name: 'Android app', extensions: ['apk'] }], properties: ['openFile' as const, 'multiSelections' as const] }
    const { canceled, filePaths } = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (!canceled) for (const serial of serials) for (const path of filePaths) queueApkInstall(serial, path)
  })

  ipcMain.handle('dev:save-log', async (e, text: string) => {
    const owner = BrowserWindow.fromWebContents(e.sender)
    const options = { defaultPath: join(app.getPath('downloads'), `logcat ${new Date().toISOString().slice(0, 19).replaceAll(':', '.')}.txt`) }
    const { canceled, filePath } = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    await writeFile(filePath, text)
    return filePath
  })

  ipcMain.handle('dev:stats', async (_e, serial: string): Promise<DeviceStats> => {
    const out = await native.deviceShell(serial, 'head -1 /proc/stat; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; dumpsys battery | grep -E "^ +(level|temperature):"')
    const num = (re: RegExp) => Number(out.match(re)?.[1] ?? NaN)

    // cpu  user nice system idle iowait irq softirq steal
    const cpu = out.match(/^cpu\s+(.+)$/m)?.[1]?.trim().split(/\s+/).map(Number) ?? []
    let cpuPercent: number | null = null
    if (cpu.length >= 4) {
      const idle = cpu[3]! + (cpu[4] ?? 0)
      const total = cpu.reduce((a, b) => a + b, 0)
      const prev = cpuSamples.get(serial)
      cpuSamples.set(serial, { busy: total - idle, total })
      if (prev && total > prev.total) cpuPercent = (100 * (total - idle - prev.busy)) / (total - prev.total)
    }
    const memTotal = num(/MemTotal:\s+(\d+)/)
    const memAvailable = num(/MemAvailable:\s+(\d+)/)
    return {
      cpuPercent,
      memoryUsedPercent: memTotal ? (100 * (memTotal - memAvailable)) / memTotal : null,
      memoryTotalMb: memTotal ? Math.round(memTotal / 1024) : null,
      batteryPercent: Number.isFinite(num(/level:\s+(\d+)/)) ? num(/level:\s+(\d+)/) : null,
      // dumpsys reports tenths of a degree Celsius.
      batteryTempC: Number.isFinite(num(/temperature:\s+(\d+)/)) ? num(/temperature:\s+(\d+)/) / 10 : null
    }
  })
}

function stopLogs(contents: WebContents): void {
  logStreams.get(contents)?.stop()
  logStreams.delete(contents)
}
