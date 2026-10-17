// The adb tool: bundled with the app (Resources/platform-tools), or from an
// Android SDK during development. The app talks to the adb server over
// TCP and starts it when it isn't running.

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export function adbPath(): string {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const bundled = app.isPackaged ? [join(process.resourcesPath, 'platform-tools', exe)] : []
  const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  if (process.platform === 'darwin') sdkRoots.push(join(homedir(), 'Library/Android/sdk'))
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) sdkRoots.push(join(process.env.LOCALAPPDATA, 'Android/Sdk'))
  if (process.platform === 'linux') sdkRoots.push(join(homedir(), 'Android/Sdk'))
  const candidates = [
    ...bundled,
    ...sdkRoots.filter(Boolean).map((root) => join(root!, 'platform-tools', exe)),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb'
  ]
  return candidates.find((p) => existsSync(p)) ?? exe
}

const serverUp = () =>
  new Promise<boolean>((resolve) => {
    const s = connect(5037, '127.0.0.1')
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
    s.setTimeout(1000, () => {
      s.destroy()
      resolve(false)
    })
  })

let starting: Promise<void> | null = null

/** Starts the adb server if nothing listens on its port. */
export function ensureAdbServer(): Promise<void> {
  starting ??= (async () => {
    if (await serverUp()) return
    await run(adbPath(), ['start-server'], { timeout: 15_000 }).catch((e: unknown) => console.warn('[adb] start-server failed:', e))
  })().finally(() => {
    starting = null
  })
  return starting
}
