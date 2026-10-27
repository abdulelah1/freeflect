// Types shared by main, preload and renderer. Kept dependency-free.

/** Serial prefix of iPhones/iPads in the device list. */
export const IOS_PREFIX = 'ios:'
/** Serial prefix of iPhones streaming through the companion app (Wi-Fi). */
export const COMPANION_PREFIX = 'companion:'
export const isIosSerial = (serial: string | null | undefined) =>
  !!serial && (serial.startsWith(IOS_PREFIX) || serial.startsWith(COMPANION_PREFIX))
export const isCompanionSerial = (serial: string | null | undefined) => !!serial?.startsWith(COMPANION_PREFIX)

/** A phone in the device list (Android via adb, or an iPhone over USB). */
export interface AndroidDevice {
  serial: string
  state: 'device' | 'unauthorized' | 'offline' | 'other'
  model?: string | null
  transport: 'usb' | 'wifi'
  platform?: 'android' | 'ios'
}

export interface VideoPacket {
  data: Uint8Array
  ptsUs: number
  keyframe: boolean
  codec?: string | null
  /** The stream restarted (rotation); reset the decoder first. */
  discontinuity: boolean
  sentAtMs: number
}

/** Mirrors `mirror_core::input::modifiers`. */
export const Modifier = { Shift: 1, Ctrl: 2, Alt: 4, Meta: 8 } as const

export type KeyName = 'home' | 'back' | 'recents' | 'volume_up' | 'volume_down' | 'power' | { code: string }

/** JSON shape of `mirror_core::InputEvent`. Coordinates are normalized 0..1. */
export type InputEvent =
  | { type: 'pointer'; action: 'down' | 'move' | 'up'; x: number; y: number; pointer_id: number; pressure: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; key: KeyName; down: boolean; modifiers: number }
  | { type: 'text'; text: string }

export interface AppSettings {
  /** Saved screenshots (default: a FreeFlect folder on the Desktop). */
  screenshotsDir: string
  /** Screen recordings and GIFs. */
  recordingsDir: string
  /** Files and photos sent from the FreeFlect iPhone app. */
  receivedFilesDir: string
  /** Where files dropped on an Android phone go. */
  androidFolder: string
  /** Full screen shows only the phone; otherwise the devices list and controls stay. */
  hideChromeInFullscreen: boolean
  /** Keep the computer's and the phone's clipboards in sync. */
  clipboardSync: boolean
  /** Let the FreeFlect iPhone app find and connect to this computer. */
  companionEnabled: boolean
  /** How the iPhone app was last signed (remembered, never chosen for the user). */
  companionSigning: SigningChoice | null
  /** Look for new versions on the releases page. */
  checkForUpdates: boolean
  /** A language code from src/locales, or "system" for the system's language. */
  language: string
}

export interface LanguageState {
  code: string
  dir: 'ltr' | 'rtl'
}

/** A team from an Apple ID added in Xcode. */
export interface SigningTeam {
  id: string
  name: string
  /** Free (personal) teams get apps that expire after 7 days. */
  free: boolean
  type: string
  account: string
}

/** An installed provisioning profile (from the Apple Developer site or Xcode). */
export interface ProvisioningProfile {
  uuid: string
  name: string
  teamId: string
  teamName: string
  /** Bundle id it signs, without the team prefix: "*", "com.you.*" or an exact id. */
  appId: string
  expiresAt: number
  /** Enterprise profiles run on any device; others list device UDIDs. */
  allDevices: boolean
  devices: string[]
  /** Development (Apple Development certificate) or ad hoc/enterprise (Apple Distribution). */
  development: boolean
}

/** Signing the iPhone app: a team of an Apple ID in Xcode, or a provisioning profile. */
export type SigningChoice = { kind: 'team'; teamId: string } | { kind: 'profile'; uuid: string }

export interface InstallTarget {
  udid: string
  name: string
  model: string | null
  /** Connected with a cable (otherwise over Wi-Fi). */
  wired: boolean
  developerMode: boolean
}

/** What the pairing window shows: scan the QR code, or type the code on the phone. */
export interface CompanionPairing {
  qrSvg: string
  /** `XXXX-XXXX` */
  code: string
  expiresInSecs: number
  desktopName: string
}

export interface CompanionInstall {
  method: 'team' | 'profile'
  teamId: string
  /** Team name, or the profile's name. */
  teamName: string
  free: boolean
  deviceName: string
  installedAt: number
  /** When a free team's app stops opening; null for paid teams. */
  expiresAt: number | null
}

export type CompanionInstallProgress =
  | { stage: 'preparing' | 'building' | 'installing' | 'launching'; message: string }
  | { stage: 'done'; message: string; needsTrust: boolean; install: CompanionInstall }
  | { stage: 'error'; message: string; log?: string }

export interface UpdateInfo {
  version: string
  url: string
  notes: string
}
export type FolderSetting = 'screenshotsDir' | 'recordingsDir' | 'receivedFilesDir'

/** Developer control of an iPhone through WebDriverAgent. */
export type IosControlState = { kind: 'off' } | { kind: 'starting' } | { kind: 'on' } | { kind: 'error'; message: string }

export interface MirrorOptions {
  /** Long-side cap in pixels; 0 = native. */
  maxSize?: number
  bitRate?: number
  maxFps?: number
  /** Play the phone's sound on the computer (silences the phone's speaker). */
  audio?: boolean
  /** Display name, used for iPhones (adb reports Android names itself). */
  deviceName?: string
}

export interface AudioPacket {
  data: Uint8Array
  ptsUs: number
  /** AAC AudioSpecificConfig (decoder description) rather than a frame. */
  config: boolean
}

export type QualityPreset = 'low-latency' | 'balanced' | 'max'

export const QUALITY_PRESETS: Record<QualityPreset, { label: string; options: MirrorOptions }> = {
  'low-latency': { label: 'Low latency', options: { maxSize: 1280, bitRate: 4_000_000, maxFps: 60 } },
  balanced: { label: 'Balanced', options: { maxSize: 1920, bitRate: 8_000_000 } },
  max: { label: 'Max quality', options: { maxSize: 0, bitRate: 16_000_000 } }
}

export interface PhoneFile {
  name: string
  isDir: boolean
  size: number
  modifiedMs: number
}

export type AppAction = 'launch' | 'stop' | 'clear' | 'uninstall'

export interface DeviceStats {
  /** Since the previous poll; null on the first one. */
  cpuPercent: number | null
  memoryUsedPercent: number | null
  memoryTotalMb: number | null
  batteryPercent: number | null
  batteryTempC: number | null
}

export interface Transfer {
  id: number
  name: string
  /** push/install: to the phone. pull: from the phone (Save as). */
  kind: 'install' | 'push' | 'pull'
  /** Local file for pulls (Show in folder). */
  path?: string
  sent: number
  total: number
  state: 'active' | 'done' | 'error'
  message?: string
}

export type WifiPairStatus =
  | { state: 'waiting' }
  | { state: 'pairing' }
  | { state: 'connected'; serial: string }
  | { state: 'error'; message: string }

export type MenuCommand =
  | 'screenshot'
  | 'copy-screenshot'
  | 'toggle-recording'
  | 'device-window'
  | 'toggle-stats'
  | 'setup'
  | 'doctor'
  | 'shortcuts'
  | 'settings'
  | 'check-updates'

export interface RecordingResult {
  /** More than one file when the phone rotated during the recording. */
  files: string[]
  error?: string
}

export type DoctorCheckId = 'adb' | 'device' | 'authorized' | 'network' | 'brand' | 'stream'

export interface DoctorResult {
  id: DoctorCheckId
  status: 'pass' | 'warn' | 'fail' | 'skip'
  title: string
  detail?: string
  /** One-click fix the UI can offer. */
  fix?: 'start-adb' | 'open-setup'
  /** Technical detail for the diagnostic report. */
  raw?: string
}

export interface DeviceProps {
  manufacturer: string
  model: string
  marketName: string
  androidVersion: string
  sdk: number
}

export interface AppInfo {
  version: string
  nativeVersion: string
  platform: string
  electron: string
  adbPath: string
  /** Installed app (not a development build). */
  packaged: boolean
}

export type SystemAction = 'notifications' | 'quick-settings' | 'collapse-panels'

export interface DeviceWindowParams {
  aspect: number
  name: string
  controllable: boolean
  /** Null for the test stream. */
  serial: string | null
  /** popout: the main window's phone moves here. extra: another phone, own session. */
  mode: 'popout' | 'extra'
}

export interface MirrorApi {
  nativeVersion(): Promise<string>
  listAndroidDevices(): Promise<AndroidDevice[]>
  /** iPhones/iPads connected by USB and trusted (macOS). */
  listIosDevices(): Promise<AndroidDevice[]>
  /** The app's language when the window loaded (read synchronously, so the first frame is right). */
  initialLanguage: LanguageState
  onLanguageChanged(cb: (l: LanguageState) => void): () => void
  getSettings(): Promise<AppSettings>
  getDefaultSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Shows a folder picker; resolves with the settings (unchanged if cancelled). */
  chooseSettingsFolder(key: FolderSetting): Promise<AppSettings>
  onSettingsChanged(cb: (s: AppSettings) => void): () => void
  /** Opens a configured folder in Finder or Explorer (created if missing). */
  openSettingsFolder(key: FolderSetting): Promise<void>
  /** iPhones paired with this computer for the FreeFlect iPhone app. */
  listCompanionDevices(): Promise<{ deviceId: string; name: string }[]>
  forgetCompanionDevice(deviceId: string): Promise<void>
  /** What is needed to install the iPhone app from this computer. */
  companionInstallInfo(): Promise<{
    problem: string | null
    teams: SigningTeam[]
    profiles: ProvisioningProfile[]
    devices: InstallTarget[]
    last: CompanionInstall | null
    available: boolean
  }>
  installCompanion(signing: SigningChoice, udid: string): Promise<void>
  cancelCompanionInstall(): void
  onCompanionInstallProgress(cb: (p: CompanionInstallProgress) => void): () => void
  /** A newer version is on the releases page. */
  onUpdateAvailable(cb: (u: UpdateInfo) => void): () => void
  checkForUpdates(): Promise<UpdateInfo | null>
  openExternal(url: string): void
  /** Whether a WebDriverAgent build for iPhones is on this Mac. */
  iosControlAvailable(): Promise<boolean>
  startIosControl(serial: string): Promise<void>
  stopIosControl(serial: string): void
  getIosControlState(serial: string): Promise<IosControlState>
  onIosControlState(cb: (serial: string, state: IosControlState) => void): () => void
  /** Opens the pairing window (and allows the iPhone app if it wasn't). */
  startCompanionPairing(): Promise<CompanionPairing>
  cancelCompanionPairing(): Promise<void>
  onCompanionPaired(cb: (phone: { deviceId: string; name: string }) => void): () => void
  /** The pairing window closed: `paired`, `expired` or `attempts` (too many wrong codes). */
  onCompanionPairingClosed(cb: (reason: string) => void): () => void
  onCompanionFile(cb: (file: { name: string; path: string }) => void): () => void
  /** Starts mirroring; rejects with a message prefixed by an error code, e.g. `[device_unauthorized]`. */
  startMirror(serial: string, options?: MirrorOptions): Promise<{ deviceName: string; audio: string }>
  /** `serial` is undefined for the test stream. */
  onAudioPacket(cb: (packet: AudioPacket, serial?: string) => void): () => void
  stopMirror(serial: string): Promise<void>
  /** Shows an already running session in this window (popped-out phone). */
  attachMirror(serial: string): void
  sendInput(serial: string, event: InputEvent): void
  /** Pastes the desktop clipboard into the focused field on the phone. */
  pasteToPhone(serial: string): void
  requestKeyframe(serial: string): void
  /** Turns the phone's own screen off or on; mirroring continues. */
  setScreenPower(serial: string, on: boolean): void
  /** Opens the notification shade or quick settings on the phone. */
  systemAction(serial: string, action: SystemAction): void
  onMirrorClosed(cb: (serial: string) => void): () => void
  onClipboardFromPhone(cb: (text: string) => void): () => void

  saveScreenshot(png: ArrayBuffer, deviceName: string): Promise<string>
  /** Copies as image data (Notes, Messages) and as a file (Finder). */
  copyScreenshot(png: ArrayBuffer, deviceName: string): Promise<void>
  /** Saves an animated GIF to the recordings folder; returns the path. */
  saveGif(gif: ArrayBuffer, deviceName: string): Promise<string>
  showInFolder(path: string): void

  /** Absolute path of a dropped file (Electron's File.path replacement). */
  pathForFile(file: File): string
  sendFiles(serial: string, paths: string[]): void
  onTransfer(cb: (t: Transfer) => void): () => void
  listPhoneDir(serial: string, path: string): Promise<PhoneFile[]>
  /** iPhone camera roll over USB, newest first (path is an AFC path). */
  listIosMedia(serial: string): Promise<{ path: string; name: string; size: number; modifiedMs: number; video: boolean }[]>
  /** Call from dragstart (after preventDefault): drags the phone file out of the app. */
  dragPhoneFile(serial: string, remotePath: string): void
  savePhoneFile(serial: string, remotePath: string): void
  deletePhoneFile(serial: string, remotePath: string): Promise<void>

  /** Streams logcat to this window (replaces any previous stream). */
  startLogcat(serial: string): Promise<void>
  stopLogcat(): void
  onLogcat(cb: (serial: string, lines: string[]) => void): () => void
  listApps(serial: string): Promise<string[]>
  appAction(serial: string, pkg: string, action: AppAction): Promise<void>
  /** Opens a file dialog and installs the chosen APKs on each phone (progress via onTransfer). */
  installApkDialog(serials: string | string[]): Promise<void>
  /** Opens an http(s) link on each phone. */
  openUrlOnPhones(serials: string[], url: string): Promise<void>
  deviceStats(serial: string): Promise<DeviceStats>
  /** Save dialog for a log export; returns the path or null if cancelled. */
  saveLog(text: string): Promise<string | null>

  toggleFullscreen(): void
  onFullscreenChange(cb: (fullscreen: boolean) => void): () => void
  onMenuCommand(cb: (command: MenuCommand) => void): () => void

  /** Opens a phone-only window (see DeviceWindowParams.mode). */
  openDeviceWindow(params: DeviceWindowParams): void
  focusDeviceWindow(serial: string): void
  /** Serials (or 'fixture') that currently have a device window. */
  listDeviceWindows(): Promise<string[]>
  onDeviceWindowsChanged(cb: (keys: string[]) => void): () => void
  closeDeviceWindow(): void
  setDeviceWindowAspect(aspect: number): void
  /** Resizes the device window to `height` px (0 = default size), keeping the phone's shape. */
  resizeDeviceWindow(height: number): void
  setAlwaysOnTop(on: boolean): Promise<boolean>

  /** Starts QR pairing; returns the QR code as SVG markup. */
  startQrPairing(): Promise<string>
  cancelQrPairing(): void
  onQrPairStatus(cb: (status: WifiPairStatus) => void): () => void
  pairWithCode(hostPort: string, code: string): Promise<string>
  switchToWifi(serial: string): Promise<string>
  /** Turns legacy Wi-Fi debugging back off on a plugged-in phone (closes its open port 5555). */
  turnOffWifiDebugging(serial: string): Promise<void>
  /** `adb connect host:port`; resolves false instead of throwing. */
  connectWifi(hostPort: string): Promise<boolean>

  /** Records the mirrored screen to MP4 (the recordings folder). */
  startRecording(serial: string, deviceName: string): Promise<void>
  stopRecording(serial: string): void
  /** Start time (ms) of the phone's current recording, or null. */
  getRecordingState(serial: string): Promise<number | null>
  onRecordingState(cb: (serial: string, since: number | null) => void): () => void
  onRecordingFinished(cb: (serial: string, result: RecordingResult) => void): () => void

  deviceProps(serial: string): Promise<DeviceProps>
  runDoctorCheck(id: DoctorCheckId, serial: string | null): Promise<DoctorResult>
  startAdb(): Promise<void>
  appInfo(): Promise<AppInfo>
  writeClipboardText(text: string): Promise<void>

  /** Dev harness: replay the bundled H.264 fixture as if it came from a phone. */
  startFixtureStream(fps: number): Promise<void>
  stopFixtureStream(): Promise<void>
  /** `serial` is undefined for the test stream. */
  onVideoPacket(cb: (packet: VideoPacket, serial?: string) => void): () => void
}
