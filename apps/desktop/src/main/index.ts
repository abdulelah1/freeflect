import { app, BrowserWindow, crashReporter, ipcMain, nativeTheme } from 'electron'
import { cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureAdbServer } from './adb'
import { registerCompanionInstallerIpc } from './companionInstaller'
import { fixtureWindow, registerDeviceWindowIpc } from './deviceWindow'
import { startUpdateChecks } from './updates'
import { startCompanion } from './companion'
import { onSettingsChange, registerSettingsIpc, settings } from './settings'
import { applyLanguage, onLanguageChange, registerI18nIpc } from './i18n'
import { registerDevToolsIpc } from './devtools'
import { registerDoctorIpc } from './doctor'
import { registerPermissionIpc } from './permissions'
import { registerFileIpc } from './files'
import { installMenu } from './menu'
import { registerIosControlIpc } from './iosControl'
import { registerMirrorIpc, stopAllMirrors, stopIosWatcher } from './mirror'
import { native } from './native'
import { runSmoke } from './smoke'
import { registerWifiIpc } from './wifi'

// Test runs get their own profile so they never share caches, storage or
// locks with a real session running at the same time.
if (process.env.MIRROR_SMOKE) app.setPath('userData', join(tmpdir(), `mirror-smoke-${process.pid}`))
// The app was called Mirror before; carry its profile (settings, allowed
// iPhones, window preferences) over once, before anything opens it.
if (!process.env.MIRROR_SMOKE) {
  const current = app.getPath('userData')
  // Installed builds used "Mirror"; development runs used the package name.
  const previous = ['Mirror', '@mirror/desktop'].map((name) => join(app.getPath('appData'), name)).find((dir) => dir !== current && existsSync(dir))
  if (previous && !existsSync(join(current, 'Local Storage'))) {
    try {
      cpSync(previous, current, { recursive: true, errorOnExist: false, force: false })
    } catch (e) {
      console.warn('[profile] could not copy the previous profile:', e)
    }
  }
}
// Smoke runs find buttons by their English labels.
if (process.env.MIRROR_SMOKE) process.env.MIRROR_LANG ??= 'en'

const REPO_ROOT = resolve(app.getAppPath(), '../..')
const FIXTURE = join(REPO_ROOT, 'fixtures/sample-1080p60.h264')
const IOS_HELPER = app.isPackaged
  ? join(process.resourcesPath, 'ios-capture')
  : join(REPO_ROOT, 'native/macos/build/ios-capture')
const SERVER_JAR = app.isPackaged
  ? join(process.resourcesPath, 'mirror-server.jar')
  : join(REPO_ROOT, 'android-server/build/mirror-server.jar')
/** Holds native/ios/MirrorCompanion (with its Xcode project) and native/shared. */
const COMPANION_SOURCE = app.isPackaged ? join(process.resourcesPath, 'companion') : REPO_ROOT

// One window per user: a second launch focuses the running app instead.
if (!process.env.MIRROR_SMOKE && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})
// Crash reports stay on this computer (Connection Doctor can include them).
crashReporter.start({ uploadToServer: false })

let win: BrowserWindow | null = null
let fixture: { stop(): void } | null = null
const contents = () => win?.webContents
/** Menu shortcuts act on whichever window (main or a device window) has focus. */
const focusedContents = () => (BrowserWindow.getFocusedWindow() ?? win)?.webContents

function createWindow(): void {
  const theme = process.env.MIRROR_THEME
  if (theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // Matches the renderer's --bg token so there is no flash on open.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#fafafb',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen', true))
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen', false))
  // Must be attached before loading so `did-finish-load` is not missed.
  if (process.env.MIRROR_SMOKE) runSmoke(win, process.env.MIRROR_SMOKE, stopAll)

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('native:version', () => native.nativeVersion())
ipcMain.handle('android:devices', async () => {
  try {
    return await native.listAndroidDevices()
  } catch {
    // The adb server isn't running (fresh Mac, or it was stopped): start it once and retry.
    await ensureAdbServer()
    return native.listAndroidDevices()
  }
})
ipcMain.handle('android:props', (_e, serial: string) => native.deviceProps(serial))
ipcMain.on('window:toggle-fullscreen', () => win?.setFullScreen(!win.isFullScreen()))

ipcMain.handle('fixture:start', async (_e, fps: number) => {
  await stopAll()
  fixture = native.streamH264File(FIXTURE, fps, true, (packet) => {
    // Frames still arrive while the window closes on quit.
    const target = fixtureWindow(win)
    if (target && !target.isDestroyed()) target.webContents.send('video:packet', packet)
  })
})
ipcMain.handle('fixture:stop', () => stopFixture())

registerSettingsIpc()
registerI18nIpc()
registerMirrorIpc(SERVER_JAR, IOS_HELPER)
registerIosControlIpc()
// The test stream repeats its headers every second, so a new window needs no priming.
registerDeviceWindowIpc({ mainWindow: () => win, onFixtureSwitch: () => {} })
registerFileIpc(contents)
registerWifiIpc(contents)
registerDoctorIpc()
registerPermissionIpc()
registerDevToolsIpc()
registerCompanionInstallerIpc(COMPANION_SOURCE)

function stopFixture(): void {
  fixture?.stop()
  fixture = null
}

// Native stream threads hold threadsafe functions that keep the process
// alive, so they must be stopped before quitting.
async function stopAll(): Promise<void> {
  stopFixture()
  await stopAllMirrors()
}

app.whenReady().then(() => {
  // Installed builds carry the icon in the bundle; development shows it in the Dock too.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(REPO_ROOT, 'apps/desktop/build/icon.png'))
  applyLanguage(settings().language)
  onSettingsChange((s, previous) => {
    if (s.language !== previous.language) applyLanguage(s.language)
  })
  // Menus are built with the app's language; rebuild them when it changes.
  onLanguageChange(() => installMenu(focusedContents, () => win))
  void ensureAdbServer()
  app.setAboutPanelOptions({ applicationName: 'FreeFlect', applicationVersion: app.getVersion(), copyright: 'See and control your phone on your computer.' })
  startUpdateChecks()
  installMenu(focusedContents, () => win)
  createWindow()
  // Wireless iPhone (companion app); failures only disable that feature.
  void startCompanion(() => win).catch((e: unknown) => console.error('[companion] not started:', e))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  stopIosWatcher()
  void stopAll()
})
app.on('window-all-closed', () => {
  void stopAll()
  if (process.platform !== 'darwin') app.quit()
})
