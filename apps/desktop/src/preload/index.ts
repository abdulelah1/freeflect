import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSettings, AudioPacket, LanguageState, CompanionInstallProgress, UpdateInfo, IosControlState, MenuCommand, MirrorApi, RecordingResult, Transfer, VideoPacket, WifiPairStatus, PermissionKind } from '../shared-ipc'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: MirrorApi = {
  nativeVersion: () => ipcRenderer.invoke('native:version'),
  listAndroidDevices: () => ipcRenderer.invoke('android:devices'),
  listIosDevices: () => ipcRenderer.invoke('ios:devices'),
  initialLanguage: ipcRenderer.sendSync('i18n:get-sync') as LanguageState,
  onLanguageChanged: (cb) => subscribe<[LanguageState]>('i18n:changed', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getDefaultSettings: () => ipcRenderer.invoke('settings:defaults'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseSettingsFolder: (key) => ipcRenderer.invoke('settings:choose-folder', key),
  onSettingsChanged: (cb) => subscribe<[AppSettings]>('settings:changed', cb),
  openSettingsFolder: (key) => ipcRenderer.invoke('settings:open-folder', key),
  listCompanionDevices: () => ipcRenderer.invoke('companion:devices'),
  forgetCompanionDevice: (deviceId) => ipcRenderer.invoke('companion:forget', deviceId),
  companionInstallInfo: () => ipcRenderer.invoke('companion-install:info'),
  installCompanion: (signing, udid) => ipcRenderer.invoke('companion-install:start', signing, udid),
  cancelCompanionInstall: () => ipcRenderer.send('companion-install:cancel'),
  onCompanionInstallProgress: (cb) => subscribe<[CompanionInstallProgress]>('companion-install:progress', cb),
  onUpdateAvailable: (cb) => subscribe<[UpdateInfo]>('update:available', cb),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  iosControlAvailable: () => ipcRenderer.invoke('ios-control:available'),
  startIosControl: (serial) => ipcRenderer.invoke('ios-control:start', serial),
  stopIosControl: (serial) => ipcRenderer.send('ios-control:stop', serial),
  getIosControlState: (serial) => ipcRenderer.invoke('ios-control:get-state', serial),
  onIosControlState: (cb) => subscribe<[string, IosControlState]>('ios-control:state', cb),
  startCompanionPairing: () => ipcRenderer.invoke('companion:pair-start'),
  cancelCompanionPairing: () => ipcRenderer.invoke('companion:pair-cancel'),
  onCompanionPaired: (cb) => subscribe<[{ deviceId: string; name: string }]>('companion:paired', cb),
  onCompanionPairingClosed: (cb) => subscribe<[string]>('companion:pairing-closed', cb),
  onCompanionFile: (cb) => subscribe<[{ name: string; path: string }]>('companion:file', cb),
  startMirror: (serial, options) => ipcRenderer.invoke('mirror:start', serial, options),
  stopMirror: (serial) => ipcRenderer.invoke('mirror:stop', serial),
  attachMirror: (serial) => ipcRenderer.send('mirror:attach', serial),
  onAudioPacket: (cb) => subscribe<[AudioPacket, string | undefined]>('audio:packet', cb),
  // Fire-and-forget: input is high-frequency and needs no reply.
  sendInput: (serial, event) => ipcRenderer.send('mirror:input', serial, event),
  pasteToPhone: (serial) => ipcRenderer.send('mirror:paste', serial),
  requestKeyframe: (serial) => ipcRenderer.send('mirror:keyframe', serial),
  setScreenPower: (serial, on) => ipcRenderer.send('mirror:screen-power', serial, on),
  systemAction: (serial, action) => ipcRenderer.send('mirror:system-action', serial, action),
  onMirrorClosed: (cb) => subscribe<[string]>('mirror:closed', cb),
  onClipboardFromPhone: (cb) => subscribe<[string]>('clipboard:from-phone', cb),

  saveScreenshot: (png, deviceName) => ipcRenderer.invoke('screenshot:save', png, deviceName),
  copyScreenshot: (png, deviceName) => ipcRenderer.invoke('screenshot:copy', png, deviceName),
  saveGif: (gif, deviceName) => ipcRenderer.invoke('gif:save', gif, deviceName),
  showInFolder: (path) => ipcRenderer.send('shell:show-in-folder', path),

  pathForFile: (file) => webUtils.getPathForFile(file),
  sendFiles: (serial, paths) => ipcRenderer.send('files:send', serial, paths),
  onTransfer: (cb) => subscribe<[Transfer]>('files:transfer', cb),
  listPhoneDir: (serial, path) => ipcRenderer.invoke('files:list', serial, path),
  listIosMedia: (serial) => ipcRenderer.invoke('ios-files:media', serial),
  dragPhoneFile: (serial, remotePath) => ipcRenderer.send('files:drag', serial, remotePath),
  savePhoneFile: (serial, remotePath) => ipcRenderer.send('files:save-as', serial, remotePath),
  deletePhoneFile: (serial, remotePath) => ipcRenderer.invoke('files:delete', serial, remotePath),

  startLogcat: (serial) => ipcRenderer.invoke('dev:logcat-start', serial),
  stopLogcat: () => ipcRenderer.send('dev:logcat-stop'),
  onLogcat: (cb) => subscribe<[string, string[]]>('dev:logcat', cb),
  listApps: (serial) => ipcRenderer.invoke('dev:apps', serial),
  appAction: (serial, pkg, action) => ipcRenderer.invoke('dev:app-action', serial, pkg, action),
  installApkDialog: (serials) => ipcRenderer.invoke('dev:install', serials),
  openUrlOnPhones: (serials, url) => ipcRenderer.invoke('farm:open-url', serials, url),
  deviceStats: (serial) => ipcRenderer.invoke('dev:stats', serial),
  saveLog: (text) => ipcRenderer.invoke('dev:save-log', text),

  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  onFullscreenChange: (cb) => subscribe<[boolean]>('window:fullscreen', cb),
  onMenuCommand: (cb) => subscribe<[MenuCommand]>('menu:command', cb),

  openDeviceWindow: (params) => ipcRenderer.send('device-window:open', params),
  focusDeviceWindow: (serial) => ipcRenderer.send('device-window:focus', serial),
  listDeviceWindows: () => ipcRenderer.invoke('device-windows:list'),
  onDeviceWindowsChanged: (cb) => subscribe<[string[]]>('device-windows:changed', cb),
  closeDeviceWindow: () => ipcRenderer.send('device-window:close'),
  setDeviceWindowAspect: (aspect) => ipcRenderer.send('device-window:aspect', aspect),
  resizeDeviceWindow: (height) => ipcRenderer.send('device-window:resize', height),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('device-window:always-on-top', on),

  startQrPairing: () => ipcRenderer.invoke('wifi:qr-start'),
  cancelQrPairing: () => ipcRenderer.send('wifi:qr-cancel'),
  onQrPairStatus: (cb) => subscribe<[WifiPairStatus]>('wifi:qr-status', cb),
  pairWithCode: (hostPort, code) => ipcRenderer.invoke('wifi:pair', hostPort, code),
  switchToWifi: (serial) => ipcRenderer.invoke('wifi:enable', serial),
  turnOffWifiDebugging: (serial) => ipcRenderer.invoke('wifi:disable', serial),
  connectWifi: (hostPort) => ipcRenderer.invoke('wifi:connect', hostPort),

  startRecording: (serial, deviceName) => ipcRenderer.invoke('record:start', serial, deviceName),
  stopRecording: (serial) => ipcRenderer.send('record:stop', serial),
  getRecordingState: (serial) => ipcRenderer.invoke('record:get-state', serial),
  onRecordingState: (cb) => subscribe<[string, number | null]>('record:state', cb),
  onRecordingFinished: (cb) => subscribe<[string, RecordingResult]>('record:finished', cb),

  deviceProps: (serial) => ipcRenderer.invoke('android:props', serial),
  runDoctorCheck: (id, serial) => ipcRenderer.invoke('doctor:check', id, serial),
  startAdb: () => ipcRenderer.invoke('doctor:start-adb'),
  applyDoctorFix: (fix) => ipcRenderer.invoke('doctor:fix', fix),
  mediaAccessStatus: (kind) => ipcRenderer.invoke('permissions:status', kind),
  requestMediaAccess: (kind) => ipcRenderer.invoke('permissions:request', kind),
  onPermissionExplain: (cb) => subscribe<[number, PermissionKind]>('permission:explain', cb),
  answerPermission: (id, ok) => ipcRenderer.send('permission:answer', id, ok),
  appInfo: () => ipcRenderer.invoke('app:info'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),

  startFixtureStream: (fps) => ipcRenderer.invoke('fixture:start', fps),
  stopFixtureStream: () => ipcRenderer.invoke('fixture:stop'),
  onVideoPacket: (cb) => subscribe<[VideoPacket, string | undefined]>('video:packet', cb)
}

contextBridge.exposeInMainWorld('mirror', api)
