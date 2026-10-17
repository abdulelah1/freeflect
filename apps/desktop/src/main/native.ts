import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

// The installed app carries the addon in Resources/native (no node_modules).
export const native = (
  app.isPackaged
    ? require(join(process.resourcesPath, 'native', `mirror-native.darwin-${process.arch}.node`))
    : require('@mirror/native')
) as typeof import('@mirror/native')
export type AndroidMirror = import('@mirror/native').AndroidMirror
