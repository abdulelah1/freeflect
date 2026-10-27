import { useCallback, useEffect, useRef, useState } from 'react'
import { isCompanionSerial, isIosSerial, QUALITY_PRESETS, type AndroidDevice, type QualityPreset, type UpdateInfo } from '../../shared-ipc'
import { HudStrip } from './components/HudStrip'
import { Sidebar, type Selection } from './components/Sidebar'
import { Stage, type Phase } from './components/Stage'
import { Toasts, type Toast } from './components/Toasts'
import { DevToolsPanel } from './components/DevToolsPanel'
import { SettingsView } from './components/SettingsView'
import { folderPhrase } from './lib/folderPhrase'
import { t } from './i18n'
import { useCrop } from './lib/crop'
import { FarmView } from './components/FarmView'
import { IosMediaPanel } from './components/IosMediaPanel'
import { FilesPanel } from './components/FilesPanel'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { WifiDialog } from './components/WifiDialog'
import { ConnectionDoctor } from './setup/ConnectionDoctor'
import { SetupWizard } from './setup/SetupWizard'
import { useAudioPlayback } from './audio/useAudioPlayback'
import { useGifRecorder } from './hooks/useGifRecorder'
import { useRecording } from './hooks/useRecording'
import { useVideoStream } from './video/useVideoStream'

const DEVICE_POLL_MS = 2000
const TOAST_MS = 4000
const QUALITY_KEY = 'mirror.quality'
const STATS_KEY = 'mirror.showStats'
/** Set once the user finishes or dismisses setup, so it never pops up again. */
const SETUP_SEEN_KEY = 'mirror.setupSeen'
/** '0' = keep sound on the phone; anything else = play it on the computer. */
const AUDIO_KEY = 'mirror.audio'
/** Last phone mirrored in the main window, started again on launch. */
const LAST_DEVICE_KEY = 'mirror.lastDevice'
/** Wi-Fi phones (ip:port) to reconnect to quietly while they are away. */
const WIFI_DEVICES_KEY = 'mirror.wifiDevices'
const RECONNECT_TIMEOUT_MS = 2 * 60 * 1000
const WIFI_RETRY_MS = 10_000

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not persisted; only affects the next launch.
  }
}

const stripIpc = (raw: string) => raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Plain-language messages for native error codes (see mirror_core::Error::code). */
function describeStartError(raw: string): Phase {
  const detail = stripIpc(raw)
  if (detail.includes('[device_unauthorized]')) {
    return { kind: 'error', title: t('errors.unauthorized.title'), body: t('errors.unauthorized.body'), detail }
  }
  if (detail.includes('[device_not_found]')) {
    return { kind: 'error', title: t('errors.notFound.title'), body: t('errors.notFound.body'), detail }
  }
  if (detail.includes('[not_streaming]')) {
    return { kind: 'error', title: t('errors.notStreaming.title'), body: t('errors.notStreaming.body'), detail }
  }
  return { kind: 'error', title: t('errors.startFailed.title'), body: t('errors.startFailed.body'), detail }
}

function loadQuality(): QualityPreset {
  try {
    const saved = localStorage.getItem(QUALITY_KEY)
    if (saved && saved in QUALITY_PRESETS) return saved as QualityPreset
  } catch {
    // Storage unavailable; use the default.
  }
  return 'max'
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Not persisted; only affects this session.
  }
}

function loadShowStats(): boolean {
  try {
    return localStorage.getItem(STATS_KEY) === '1'
  } catch {
    return false
  }
}

export function App() {
  const [devices, setDevices] = useState<AndroidDevice[] | null>(null)
  const [adbError, setAdbError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [deviceName, setDeviceName] = useState('Phone')
  const [fps, setFps] = useState(60)
  const [quality, setQuality] = useState<QualityPreset>(loadQuality)
  const [fullscreen, setFullscreen] = useState(false)
  // Full screen keeps the devices list and controls unless Settings says otherwise.
  const [hideChrome, setHideChrome] = useState(false)
  useEffect(() => {
    void window.mirror.getSettings().then((s) => setHideChrome(s.hideChromeInFullscreen))
  }, [])
  const immersive = fullscreen && hideChrome
  const [wifiOpen, setWifiOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  // Stream stats are a developer aid, hidden until asked for.
  const [showStats, setShowStats] = useState(loadShowStats)
  // The phone's own screen; it always comes back on when a session ends.
  const [screenOff, setScreenOff] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [doctorOpen, setDoctorOpen] = useState(false)
  /** Set when the Doctor is opened for a known kind of phone (from the setup guide). */
  const [doctorPlatform, setDoctorPlatform] = useState<'android' | 'ios' | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // One side panel at a time.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [packaged, setPackaged] = useState(true)
  useEffect(() => {
    void window.mirror.appInfo().then((info) => setPackaged(info.packaged))
  }, [])
  const [sidePanel, setSidePanel] = useState<'files' | 'devtools' | null>(null)
  const firstPoll = useRef(true)
  const recording = useRecording(
    selection?.kind === 'android' && phase.kind === 'live' ? selection.serial : null,
    deviceName
  )
  const streaming = phase.kind === 'starting' || phase.kind === 'live'
  const { container, stats, error, captureFrame, grabFrame } = useVideoStream(
    streaming,
    selection?.kind === 'android' ? selection.serial : undefined
  )
  const [audioOnComputer, setAudioOnComputer] = useState(() => {
    try {
      return localStorage.getItem(AUDIO_KEY) !== '0'
    } catch {
      return true
    }
  })
  useAudioPlayback(streaming && selection?.kind === 'android' && audioOnComputer)
  // Guards against a stale start resolving after the user switched device.
  const attempt = useRef(0)
  // Phone mirrored in this window (for stopping it), and phones with their own window.
  const mirroredSerial = useRef<string | null>(null)
  /** Phone we are waiting for after a disconnect. */
  const reconnectTarget = useRef<{ serial: string; model: string | null; until: number } | null>(null)
  const autoStarted = useRef(false)
  const [windowed, setWindowed] = useState<string[]>([])
  // Latest device list for callbacks created before the last poll.
  const devicesRef = useRef<AndroidDevice[] | null>(null)

  const dismissToast = useCallback((id: string) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])
  const showToast = useCallback(
    (toast: Toast, autoDismiss = true) => {
      setToasts((ts) => [...ts.filter((t) => t.id !== toast.id), toast].slice(-4))
      if (autoDismiss) setTimeout(() => dismissToast(toast.id), TOAST_MS)
    },
    [dismissToast]
  )
  const showUpdate = useCallback(
    (u: UpdateInfo) =>
      showToast(
        {
          id: 'update',
          tone: 'info',
          title: t('toast.updateAvailable', { app: t('app.name'), version: u.version }),
          body: t('toast.updateAvailableBody', { app: t('app.name') }),
          action: { label: t('toast.download'), onClick: () => window.mirror.openExternal(u.url) }
        },
        false
      ),
    [showToast]
  )

  const refreshDevices = useCallback(async () => {
    try {
      // iPhones are listed separately (macOS capture helper) and never block Android.
      const [android, ios] = await Promise.all([
        window.mirror.listAndroidDevices(),
        window.mirror.listIosDevices().catch(() => [])
      ])
      const list = [...android, ...ios]
      devicesRef.current = list
      setDevices(list)
      setAdbError(null)
      // First launch with no phone: open the setup guide once.
      if (firstPoll.current && list.length === 0 && !readFlag(SETUP_SEEN_KEY)) setSetupOpen(true)
      firstPoll.current = false
    } catch (e) {
      setAdbError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const id = setInterval(refreshDevices, DEVICE_POLL_MS)
    return () => clearInterval(id)
  }, [refreshDevices])

  useEffect(() => {
    const offs = [
      window.mirror.onMirrorClosed((serial) => {
        if (serial !== mirroredSerial.current) return
        mirroredSerial.current = null
        // Wait for the phone to come back instead of giving up.
        const model = devicesRef.current?.find((d) => d.serial === serial)?.model ?? null
        reconnectTarget.current = { serial, model, until: Date.now() + RECONNECT_TIMEOUT_MS }
        setPhase({ kind: 'reconnecting', name: model ?? t('common.yourPhone') })
      }),
      window.mirror.onDeviceWindowsChanged(setWindowed),
      window.mirror.onUpdateAvailable((u) => showUpdate(u)),
      window.mirror.onCompanionFile(({ name, path }) =>
        showToast(
          {
            id: `companion-file-${path}`,
            tone: 'success',
            title: t('toast.received', { name }),
            body: folderPhrase(path),
            action: { label: t('toast.showInFolder'), onClick: () => window.mirror.showInFolder(path) }
          },
          false
        )
      ),
      window.mirror.onClipboardFromPhone((text) =>
        showToast({ id: 'clipboard', tone: 'info', title: t('toast.copiedFromPhone'), body: text.slice(0, 120) })
      ),
      window.mirror.onFullscreenChange(setFullscreen),
      window.mirror.onSettingsChanged((s) => setHideChrome(s.hideChromeInFullscreen)),
      window.mirror.onRecordingFinished((_serial, { files, error }) => {
        if (files.length === 0) {
          showToast({ id: 'recording', tone: 'error', title: t('toast.recordingFailed'), body: error }, false)
          return
        }
        showToast(
          {
            id: 'recording',
            tone: 'success',
            title: t('toast.recordingSaved'),
            body:
              files.length > 1
                ? `${t('toast.recordingParts', { count: files.length })} ${folderPhrase(files[0]!)}`
                : folderPhrase(files[0]!),
            action: { label: t('toast.showInFolder'), onClick: () => window.mirror.showInFolder(files[0]!) }
          },
          false
        )
      }),
      window.mirror.onTransfer((tx) => {
        // install | pull | push, each with an active, done and failed message.
        const kind = tx.kind
        if (tx.state === 'active') {
          showToast(
            { id: `transfer-${tx.id}`, tone: 'info', title: t(`transfer.${kind}.active`, { name: tx.name }), progress: tx.total ? tx.sent / tx.total : 0 },
            false
          )
        } else if (tx.state === 'done') {
          showToast({
            id: `transfer-${tx.id}`,
            tone: 'success',
            title: t(`transfer.${kind}.done`, { name: tx.name }),
            body: kind === 'push' ? t('transfer.push.doneBody') : undefined,
            action:
              kind === 'pull' && tx.path
                ? { label: t('toast.showInFolder'), onClick: () => window.mirror.showInFolder(tx.path!) }
                : undefined
          })
        } else {
          showToast(
            {
              id: `transfer-${tx.id}`,
              tone: 'error',
              title: t(`transfer.${kind}.failed`, { name: tx.name }),
              body: tx.message?.replace(/^\[\w+\] /, '')
            },
            false
          )
        }
      })
    ]
    return () => offs.forEach((off) => off())
  }, [showToast])

  // A decoder error loses state; the next keyframe recovers it.
  useEffect(() => {
    if (error && selection?.kind === 'android') window.mirror.requestKeyframe(selection.serial)
  }, [error, selection])

  const stopAll = useCallback(async () => {
    attempt.current++
    setPhase({ kind: 'idle' })
    const serial = mirroredSerial.current
    mirroredSerial.current = null
    await Promise.all([serial ? window.mirror.stopMirror(serial) : null, window.mirror.stopFixtureStream()])
  }, [])

  const start = useCallback(
    async (target: Selection, preset: QualityPreset = quality, audio: boolean = audioOnComputer) => {
      // The farm view starts its own tile sessions.
      if (!target || target.kind === 'farm') return
      const id = ++attempt.current
      // Mount the canvas + decoder before packets start flowing.
      setPhase({ kind: 'starting' })
      setScreenOff(false)
      try {
        if (target.kind === 'fixture') {
          await window.mirror.startFixtureStream(fps)
          setDeviceName(t('sidebar.testStream'))
        } else {
          mirroredSerial.current = target.serial
          writeJson(LAST_DEVICE_KEY, target.serial)
          if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(target.serial)) {
            const known = readJson<string[]>(WIFI_DEVICES_KEY, [])
            if (!known.includes(target.serial)) writeJson(WIFI_DEVICES_KEY, [...known, target.serial].slice(-8))
          }
          const name = devicesRef.current?.find((d) => d.serial === target.serial)?.model ?? undefined
          const result = await window.mirror.startMirror(target.serial, {
            ...QUALITY_PRESETS[preset].options,
            audio,
            deviceName: name
          })
          setDeviceName(result.deviceName)
          if (audio && result.audio !== 'on') {
            showToast({ id: 'audio', tone: 'info', title: t('toast.soundOnPhone'), body: result.audio })
          }
        }
        if (attempt.current === id) setPhase({ kind: 'live' })
      } catch (e) {
        if (attempt.current === id) setPhase(describeStartError(e instanceof Error ? e.message : String(e)))
      }
    },
    [fps, quality, audioOnComputer, showToast]
  )

  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const windowedRef = useRef(windowed)
  windowedRef.current = windowed
  const select = useCallback(
    async (next: Selection) => {
      // A phone with its own window: bring that window forward instead.
      if (next?.kind === 'android' && windowedRef.current.includes(next.serial)) {
        window.mirror.focusDeviceWindow(next.serial)
        return
      }
      if (streamingRef.current) await stopAll()
      setSelection(next)
      setPhase({ kind: 'idle' })
      const device =
        next?.kind === 'android' ? devicesRef.current?.find((d) => d.serial === next.serial) : undefined
      if (device?.state === 'device') void start(next)
    },
    [start, stopAll]
  )

  const changeQuality = async (preset: QualityPreset) => {
    setQuality(preset)
    try {
      localStorage.setItem(QUALITY_KEY, preset)
    } catch {
      // Not persisted; still applies to this session.
    }
    if (selection?.kind === 'android' && streaming) {
      await stopAll()
      void start(selection, preset)
    }
  }

  // Shown part of the screen; screenshots and GIFs are cut to it too.
  const { crop, setCrop } = useCrop(
    selection?.kind === 'android' ? selection.serial : null,
    stats?.width ? stats.width / stats.height : null
  )
  const cropRef = useRef(crop)
  cropRef.current = crop
  const grabCropped = useCallback((width: number) => grabFrame(width, cropRef.current), [grabFrame])

  const gif = useGifRecorder(
    grabCropped,
    deviceName,
    useCallback(
      (path: string) =>
        showToast(
          {
            id: 'gif',
            tone: 'success',
            title: t('toast.gifSaved'),
            body: folderPhrase(path),
            action: { label: t('toast.showInFolder'), onClick: () => window.mirror.showInFolder(path) }
          },
          false
        ),
      [showToast]
    ),
    useCallback(
      (message: string) => showToast({ id: 'gif', tone: 'error', title: t('toast.gifFailed'), body: message }, false),
      [showToast]
    )
  )

  const toggleScreen = useCallback(() => {
    if (selection?.kind !== 'android') return
    const off = !screenOff
    window.mirror.setScreenPower(selection.serial, !off)
    setScreenOff(off)
  }, [selection, screenOff])

  const toggleAudio = async () => {
    const next = !audioOnComputer
    setAudioOnComputer(next)
    try {
      localStorage.setItem(AUDIO_KEY, next ? '1' : '0')
    } catch {
      // Not persisted; still applies to this session.
    }
    // Capturing sound is what silences the phone, so switching restarts it.
    if (selection?.kind === 'android' && streaming) {
      await stopAll()
      void start(selection, quality, next)
    }
  }

  const screenshot = useCallback(async () => {
    const png = await captureFrame(cropRef.current)
    if (!png) return
    try {
      const path = await window.mirror.saveScreenshot(png, deviceName)
      showToast({
        id: 'screenshot',
        tone: 'success',
        title: t('toast.screenshotSaved'),
        body: folderPhrase(path),
        action: { label: t('toast.showInFolder'), onClick: () => window.mirror.showInFolder(path) }
      })
    } catch (e) {
      showToast({ id: 'screenshot', tone: 'error', title: t('toast.screenshotFailed'), body: stripIpc(String(e)) })
    }
  }, [captureFrame, deviceName, showToast])

  const copyScreenshot = useCallback(async () => {
    const png = await captureFrame(cropRef.current)
    if (!png) return
    try {
      await window.mirror.copyScreenshot(png, deviceName)
      showToast({ id: 'screenshot', tone: 'success', title: t('toast.screenshotCopied'), body: t('toast.screenshotCopiedBody') })
    } catch (e) {
      showToast({ id: 'screenshot', tone: 'error', title: t('toast.copyFailed'), body: stripIpc(String(e)) })
    }
  }, [captureFrame, deviceName, showToast])

  const toggleStats = useCallback(() => {
    setShowStats((on) => {
      try {
        localStorage.setItem(STATS_KEY, on ? '0' : '1')
      } catch {
        // Not persisted; still applies to this session.
      }
      return !on
    })
  }, [])

  const hasFrames = !!stats && stats.fps > 0
  const openDeviceWindow = useCallback(() => {
    if (!hasFrames || !stats) return
    window.mirror.openDeviceWindow({
      aspect: stats.width / stats.height,
      name: deviceName,
      controllable: selection?.kind === 'android' && !isIosSerial(selection.serial),
      serial: selection?.kind === 'android' ? selection.serial : null,
      mode: 'popout'
    })
  }, [hasFrames, stats, deviceName, selection])

  useEffect(() => void window.mirror.listDeviceWindows().then(setWindowed), [])

  // On launch, mirror the last phone again if it is connected and ready.
  useEffect(() => {
    if (autoStarted.current || !devices || setupOpen) return
    autoStarted.current = true
    const last = readJson<string | null>(LAST_DEVICE_KEY, null)
    if (last && devices.some((d) => d.serial === last && d.state === 'device')) void select({ kind: 'android', serial: last })
  }, [devices, setupOpen, select])

  // After a disconnect, resume as soon as the phone is back (same serial, or
  // the same model on another connection, e.g. USB to Wi-Fi).
  useEffect(() => {
    const target = reconnectTarget.current
    if (phase.kind !== 'reconnecting' || !target || !devices) return
    if (Date.now() > target.until) {
      reconnectTarget.current = null
      setPhase({
        kind: 'error',
        title: t('errors.notBack.title'),
        body: t('errors.notBack.body')
      })
      return
    }
    const back =
      devices.find((d) => d.serial === target.serial && d.state === 'device') ??
      devices.find((d) => target.model !== null && d.model === target.model && d.state === 'device')
    if (back) {
      reconnectTarget.current = null
      setSelection({ kind: 'android', serial: back.serial })
      void start({ kind: 'android', serial: back.serial })
    }
  }, [devices, phase, start])

  // Remembered Wi-Fi phones drop off when the network blips; try to bring them back.
  useEffect(() => {
    const id = setInterval(() => {
      const present = new Set((devicesRef.current ?? []).map((d) => d.serial))
      for (const hostPort of readJson<string[]>(WIFI_DEVICES_KEY, [])) {
        if (!present.has(hostPort)) void window.mirror.connectWifi(hostPort)
      }
    }, WIFI_RETRY_MS)
    return () => clearInterval(id)
  }, [])

  /** Another phone in its own window; the selected live phone pops out instead. */
  const openOwnWindow = (device: AndroidDevice) => {
    if (selection?.kind === 'android' && selection.serial === device.serial && phase.kind === 'live') {
      openDeviceWindow()
      return
    }
    window.mirror.openDeviceWindow({
      aspect: 1080 / 2340,
      name: device.model ?? device.serial,
      controllable: !isIosSerial(device.serial),
      serial: device.serial,
      mode: 'extra'
    })
  }

  useEffect(
    () =>
      window.mirror.onMenuCommand((cmd) => {
        if (cmd === 'screenshot') void screenshot()
        else if (cmd === 'copy-screenshot') void copyScreenshot()
        else if (cmd === 'toggle-recording' && selection?.kind === 'android' && phase.kind === 'live') recording.toggle()
        else if (cmd === 'toggle-stats') toggleStats()
        else if (cmd === 'device-window') openDeviceWindow()
        else if (cmd === 'setup') setSetupOpen(true)
        else if (cmd === 'doctor') setDoctorOpen(true)
        else if (cmd === 'shortcuts') setShortcutsOpen(true)
        else if (cmd === 'settings') setSettingsOpen(true)
        else if (cmd === 'check-updates') {
          void window.mirror.checkForUpdates().then((u) =>
            u
              ? showUpdate(u)
              : showToast({ id: 'update', tone: 'info', title: t('toast.upToDate', { app: t('app.name') }), body: t('toast.upToDateBody') })
          )
        }
      }),
    [screenshot, copyScreenshot, toggleStats, openDeviceWindow, recording, selection, phase]
  )

  const onWifiConnected = useCallback(
    (serial: string) => {
      setWifiOpen(false)
      const body = isCompanionSerial(serial) ? t('toast.iphoneWifiBody') : t('toast.wifiConnectedBody')
      showToast({ id: 'wifi', tone: 'success', title: t('toast.wifiConnected'), body })
      void refreshDevices().then(() => void select({ kind: 'android', serial }))
    },
    [refreshDevices, select, showToast]
  )

  return (
    <div className="flex h-full">
      {!immersive && (
        <Sidebar
          devices={devices}
          adbError={adbError}
          selection={selection}
          onSelect={select}
          onRetry={refreshDevices}
          onAddWifi={() => setWifiOpen(true)}
          onSetup={() => setSetupOpen(true)}
          onOpenDoctor={() => setDoctorOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          showTestStream={!packaged}
          windowed={windowed}
          onOpenWindow={openOwnWindow}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {selection?.kind === 'farm' ? (
          <FarmView
            devices={(devices ?? []).filter((d) => d.state === 'device' && !windowed.includes(d.serial))}
            onOpenDevice={(serial) => void select({ kind: 'android', serial })}
            onToast={(title, body, tone = 'success') => showToast({ id: 'farm', tone, title, body })}
          />
        ) : (
        <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
        <Stage
          selection={selection}
          phase={phase}
          streaming={streaming}
          hasFrames={hasFrames}
          fullscreen={immersive}
          windowFullscreen={fullscreen}
          crop={crop}
          onCropChange={setCrop}
          videoRef={container}
          decodeError={error}
          aspect={stats?.width ? stats.width / stats.height : null}
          fps={fps}
          quality={quality}
          onFpsChange={setFps}
          onQualityChange={(q) => void changeQuality(q)}
          onStart={() => {
            // From the reconnecting screen this is "Stop waiting".
            if (phase.kind === 'reconnecting') {
              reconnectTarget.current = null
              setPhase({ kind: 'idle' })
              return
            }
            void start(selection)
          }}
          onStop={() => void stopAll()}
          onScreenshot={() => void screenshot()}
          onCopyScreenshot={() => void copyScreenshot()}
          onDropFiles={(paths) => selection?.kind === 'android' && window.mirror.sendFiles(selection.serial, paths)}
          showStats={showStats}
          onToggleStats={toggleStats}
          onOpenDeviceWindow={openDeviceWindow}
          onOpenDoctor={() => setDoctorOpen(true)}
          recording={recording}
          audioOnComputer={audioOnComputer}
          onToggleAudio={() => void toggleAudio()}
          screenOff={screenOff}
          onToggleScreen={toggleScreen}
          gif={gif}
          filesOpen={sidePanel === 'files'}
          onToggleFiles={() => setSidePanel((p) => (p === 'files' ? null : 'files'))}
          devToolsOpen={sidePanel === 'devtools'}
          onToggleDevTools={() => setSidePanel((p) => (p === 'devtools' ? null : 'devtools'))}
        />
        {!immersive && showStats && <HudStrip stats={stats} />}
        </div>
        {sidePanel && !immersive && selection?.kind === 'android' && phase.kind === 'live' &&
          (sidePanel === 'files' ? (
            isIosSerial(selection.serial) ? (
              <IosMediaPanel serial={selection.serial} onClose={() => setSidePanel(null)} />
            ) : (
              <FilesPanel serial={selection.serial} onClose={() => setSidePanel(null)} />
            )
          ) : (
            <DevToolsPanel serial={selection.serial} onClose={() => setSidePanel(null)} />
          ))}
        </div>
        )}
      </main>
      <Toasts toasts={toasts} onDismiss={dismissToast} />
      {setupOpen && (
        <SetupWizard
          onClose={() => {
            writeFlag(SETUP_SEEN_KEY, true)
            setSetupOpen(false)
          }}
          onComplete={(serial) => {
            writeFlag(SETUP_SEEN_KEY, true)
            setSetupOpen(false)
            void refreshDevices().then(() => void select({ kind: 'android', serial }))
          }}
          onOpenDoctor={(platform) => {
            setDoctorPlatform(platform)
            setDoctorOpen(true)
          }}
        />
      )}
      {doctorOpen && (
        <ConnectionDoctor
          serial={selection?.kind === 'android' ? selection.serial : null}
          initialPlatform={
            doctorPlatform ??
            (selection?.kind === 'android'
              ? isIosSerial(selection.serial)
                ? 'ios'
                : 'android'
              : (devices ?? []).length > 0 && (devices ?? []).every((d) => d.platform === 'ios')
                ? 'ios'
                : 'android')
          }
          onClose={() => {
            setDoctorOpen(false)
            setDoctorPlatform(null)
          }}
          onOpenSetup={() => {
            setDoctorOpen(false)
            setDoctorPlatform(null)
            setSetupOpen(true)
          }}
        />
      )}
      {settingsOpen && (
        <SettingsView onClose={() => setSettingsOpen(false)} audioOnComputer={audioOnComputer} onToggleAudio={() => void toggleAudio()} />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {wifiOpen && (
        <WifiDialog
          usbDevices={(devices ?? []).filter((d) => d.transport === 'usb' && d.state === 'device')}
          // iPhone first when the only phones around are iPhones.
          initialPlatform={(devices ?? []).length > 0 && (devices ?? []).every((d) => d.platform === 'ios') ? 'ios' : 'android'}
          onClose={() => setWifiOpen(false)}
          onConnected={onWifiConnected}
        />
      )}
    </div>
  )
}
