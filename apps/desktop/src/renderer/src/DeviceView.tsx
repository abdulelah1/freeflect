import {
  AppWindowIcon,
  CameraIcon,
  CaretLeftIcon,
  ArrowsOutSimpleIcon,
  CheckIcon,
  CircleIcon,
  CopyIcon,
  CursorClickIcon,
  DeviceMobileIcon,
  DeviceMobileSlashIcon,
  PowerIcon,
  PushPinIcon,
  RecordIcon,
  StopCircleIcon,
  PushPinSlashIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SquareIcon
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { isCompanionSerial, isIosSerial, QUALITY_PRESETS, type KeyName, type QualityPreset } from '../../shared-ipc'
import { useAudioPlayback } from './audio/useAudioPlayback'
import { declinedMessage, withPermissions } from './components/PermissionGate'
import { useIosControl } from './hooks/useIosControl'
import { useT } from './i18n'
import { useRecording } from './hooks/useRecording'
import { usePhoneActions } from './input/phoneActions'
import { useShortcuts } from './input/shortcuts'
import { useInputCapture } from './input/useInputCapture'
import { useVideoStream } from './video/useVideoStream'

/** Keep in sync with main/deviceWindow.ts. */
const MARGIN = 16
const BEZEL = 9
/** Height change per arrow-key press on the resize grip. */
const RESIZE_STEP = 40

interface Props {
  name: string
  initialAspect: number
  controllable: boolean
  serial: string | null
  /** popout: shows the main window's running session. extra: runs its own. */
  mode: 'popout' | 'extra'
}

/** Quality chosen in the main window (same storage origin). */
function savedPreset(): QualityPreset {
  try {
    const saved = localStorage.getItem('mirror.quality')
    if (saved && saved in QUALITY_PRESETS) return saved as QualityPreset
  } catch {
    // Storage unavailable; use the default.
  }
  return 'max'
}

/** Phone-only window, opened from the main window ("Device window"). */
export function DeviceView({ name: initialName, initialAspect, controllable, serial, mode }: Props) {
  const t = useT()
  const { container, stats, captureFrame } = useVideoStream(true, serial ?? undefined)
  const screenRef = useRef<HTMLDivElement>(null)
  const [closed, setClosed] = useState(false)
  const [name, setName] = useState(initialName)
  const [startError, setStartError] = useState<string | null>(null)
  const [screenOff, setScreenOff] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [done, setDone] = useState<'saved' | 'copied' | null>(null)
  const live = controllable && !closed && serial !== null
  const shortcuts = useShortcuts()
  const toggleScreen = useCallback(() => {
    if (!serial) return
    setScreenOff((off) => {
      window.mirror.setScreenPower(serial, off)
      return !off
    })
  }, [serial])
  const runAction = usePhoneActions(serial, toggleScreen)
  // iPhones take input only while developer control (WebDriverAgent) is on.
  const ios = isIosSerial(serial)
  const iosControl = useIosControl(ios && !closed && !isCompanionSerial(serial) ? serial : null)
  const canInput = live || (ios && iosControl.on && !closed)
  useInputCapture(screenRef, canInput ? serial : null, shortcuts, runAction)
  // Sound and recording work for every phone, including view-only iPhones.
  const streamingPhone = !closed && serial !== null
  const recording = useRecording(streamingPhone ? serial : null, name)
  // A popped-out phone's sound follows its video here (main resends the config).
  // Extra windows start without sound so two phones don't play at once.
  useAudioPlayback(streamingPhone && mode === 'popout')

  const aspect = stats?.width ? stats.width / stats.height : initialAspect
  const sentAspect = useRef(initialAspect)
  useEffect(() => {
    // Rotation: resize the window to the new shape.
    if (Math.abs(aspect - sentAspect.current) / sentAspect.current > 0.01) {
      sentAspect.current = aspect
      window.mirror.setDeviceWindowAspect(aspect)
    }
  }, [aspect])

  useEffect(() => window.mirror.onMirrorClosed((s) => s === serial && setClosed(true)), [serial])

  useEffect(() => {
    if (!serial) return
    if (mode === 'extra') {
      // This window runs its own session; main stops it when the window closes.
      withPermissions(() =>
        window.mirror.startMirror(serial, { ...QUALITY_PRESETS[savedPreset()].options, audio: false, deviceName: initialName })
      )
        .then((r) => setName(r.deviceName))
        .catch((e: unknown) => {
          setStartError(declinedMessage(e) ?? String(e).replace(/^.*?\[\w+\] /, ''))
          setClosed(true)
        })
      return
    }
    // Popped out: take over the running session's stream. Ask for a keyframe
    // again shortly after, in case the first raced this window's decoder setup.
    window.mirror.attachMirror(serial)
    const retry = setTimeout(() => window.mirror.requestKeyframe(serial), 600)
    return () => clearTimeout(retry)
  }, [serial, mode])
  const flash = (what: 'saved' | 'copied') => {
    setDone(what)
    setTimeout(() => setDone(null), 1500)
  }
  const screenshot = async (mode: 'save' | 'copy') => {
    const png = await captureFrame()
    if (!png) return
    if (mode === 'save') await window.mirror.saveScreenshot(png, name)
    else await window.mirror.copyScreenshot(png, name)
    flash(mode === 'save' ? 'saved' : 'copied')
  }
  // Menu shortcuts reach this window too; keep the latest handler.
  const screenshotRef = useRef(screenshot)
  screenshotRef.current = screenshot
  const recordingRef = useRef(recording)
  recordingRef.current = recording

  useEffect(
    () =>
      window.mirror.onMenuCommand((cmd) => {
        if (cmd === 'device-window') window.mirror.closeDeviceWindow()
        else if (cmd === 'screenshot') void screenshotRef.current('save')
        else if (cmd === 'copy-screenshot') void screenshotRef.current('copy')
        else if (cmd === 'toggle-recording') recordingRef.current.toggle()
      }),
    []
  )

  const tap = (key: KeyName) => {
    if (!serial) return
    window.mirror.sendInput(serial, { type: 'key', key, down: true, modifiers: 0 })
    window.mirror.sendInput(serial, { type: 'key', key, down: false, modifiers: 0 })
  }
  const togglePin = async () => setPinned(await window.mirror.setAlwaysOnTop(!pinned))

  return (
    <div className="flex h-full" style={{ padding: MARGIN }}>
      <div className="relative min-w-0 flex-1" style={{ containerType: 'size' }}>
        <div className="absolute inset-0 grid place-items-center">
          <div
            className="phone drag rounded-[42px] bg-[var(--bezel)]"
            style={{ padding: BEZEL, boxShadow: '0 8px 24px oklch(0.1 0.01 260 / 0.45)' }}
          >
            <div
              ref={screenRef}
              tabIndex={canInput ? 0 : -1}
              aria-label={canInput ? t('device.screenLabel', { name }) : name}
              className="phone-screen no-drag relative overflow-hidden rounded-[33px] bg-[var(--bezel)]"
              style={{
                aspectRatio: aspect,
                height: `min(100cqh - ${2 * BEZEL}px, (100cqw - ${2 * BEZEL}px) / ${aspect})`,
                touchAction: 'none'
              }}
            >
              <div ref={container} className="h-full w-full" />
              {(closed || !stats?.fps) && (
                <div className="absolute inset-0 grid place-items-center bg-[var(--bezel)] p-6 text-center">
                  <div>
                    <p className="text-sm text-[oklch(0.85_0.01_260)]">
                      {startError ? t('errors.startFailed.title') : closed ? t('device.disconnected') : t('device.connecting')}
                    </p>
                    {startError && <p className="mt-1 text-xs text-[oklch(0.7_0.01_260)]">{startError}</p>}
                    {closed && (
                      <button
                        type="button"
                        onClick={() => window.mirror.closeDeviceWindow()}
                        className="mt-4 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
                      >
                        {mode === 'extra' ? t('device.closeWindow') : t('device.backToApp')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <nav
        aria-label={t('device.controls')}
        className="drag ms-3 flex w-12 shrink-0 flex-col items-center gap-1 self-center rounded-[var(--radius-panel)] border border-line bg-surface py-2 shadow-[0_6px_18px_oklch(0.1_0.01_260/0.3)]"
      >
        <ToolButton label={t('device.backToAppWindow')} onClick={() => window.mirror.closeDeviceWindow()}>
          <AppWindowIcon size={18} />
        </ToolButton>
        <ToolButton label={pinned ? t('device.unpin') : t('device.pin')} pressed={pinned} onClick={togglePin}>
          {pinned ? <PushPinSlashIcon size={18} /> : <PushPinIcon size={18} />}
        </ToolButton>
        <Divider />
        <ToolButton
          label={screenOff ? t('stage.screenOn') : t('device.screenOff')}
          pressed={screenOff}
          disabled={!live}
          onClick={toggleScreen}
        >
          {screenOff ? <DeviceMobileSlashIcon size={18} /> : <DeviceMobileIcon size={18} />}
        </ToolButton>
        {ios && !isCompanionSerial(serial) && iosControl.available && (
          <ToolButton
            label={
              iosControl.state.kind === 'error'
                ? t('iosControl.errorLabel', { message: iosControl.state.message })
                : iosControl.on
                  ? t('iosControl.onLabel')
                  : iosControl.state.kind === 'starting'
                    ? t('iosControl.startingLabel')
                    : t('iosControl.offLabel')
            }
            pressed={iosControl.on}
            onClick={iosControl.toggle}
          >
            <CursorClickIcon
              size={18}
              weight={iosControl.on ? 'fill' : 'regular'}
              className={iosControl.on ? 'text-accent' : iosControl.state.kind === 'starting' ? 'animate-pulse' : iosControl.state.kind === 'error' ? 'text-err' : undefined}
            />
          </ToolButton>
        )}
        <ToolButton label={t('device.power')} disabled={!canInput} onClick={() => tap('power')}>
          <PowerIcon size={18} />
        </ToolButton>
        <ToolButton label={t('device.volumeUp')} disabled={!canInput} onClick={() => tap('volume_up')}>
          <SpeakerHighIcon size={18} />
        </ToolButton>
        <ToolButton label={t('device.volumeDown')} disabled={!canInput} onClick={() => tap('volume_down')}>
          <SpeakerLowIcon size={18} />
        </ToolButton>
        <ToolButton label={t('stage.saveScreenshot')} disabled={!stats?.fps} onClick={() => void screenshot('save')}>
          {done === 'saved' ? <CheckIcon size={18} className="text-ok" /> : <CameraIcon size={18} />}
        </ToolButton>
        <ToolButton label={t('stage.copyScreenshot')} disabled={!stats?.fps} onClick={() => void screenshot('copy')}>
          {done === 'copied' ? <CheckIcon size={18} className="text-ok" /> : <CopyIcon size={18} />}
        </ToolButton>
        {streamingPhone && (
          <ToolButton
            label={recording.recording ? t('device.stopRecording', { elapsed: recording.elapsed }) : t('device.record')}
            pressed={recording.recording}
            disabled={!stats?.fps}
            onClick={recording.toggle}
          >
            {recording.recording ? (
              <StopCircleIcon size={18} weight="fill" className="text-err" />
            ) : (
              <RecordIcon size={18} weight="fill" className="text-err" />
            )}
          </ToolButton>
        )}
        <Divider />
        <ToolButton label={t('nav.back')} disabled={!controllable} onClick={() => tap('back')}>
          <CaretLeftIcon size={18} weight="bold" className="rtl:-scale-x-100" />
        </ToolButton>
        <ToolButton label={t('nav.home')} disabled={!canInput} onClick={() => tap('home')}>
          <CircleIcon size={16} weight="bold" />
        </ToolButton>
        <ToolButton label={t('nav.recents')} disabled={!controllable} onClick={() => tap('recents')}>
          <SquareIcon size={15} weight="bold" />
        </ToolButton>
        <Divider />
        <ResizeGrip />
      </nav>
    </div>
  )
}

function ToolButton(props: {
  label: string
  onClick(): void
  disabled?: boolean
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      className={`no-drag grid size-9 place-items-center rounded-[var(--radius-control)] transition-colors active:scale-[0.96] disabled:opacity-40 ${
        props.pressed ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-fg/8 hover:text-fg'
      }`}
    >
      {props.children}
    </button>
  )
}

/**
 * Transparent windows can't be resized from their edges, so this grip does it:
 * drag to resize (the phone keeps its shape), double-click to reset, or use
 * the arrow keys when focused.
 */
function ResizeGrip() {
  const t = useT()
  const drag = useRef<{ startY: number; startHeight: number } | null>(null)
  const frame = useRef(0)

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startY: e.screenY, startHeight: window.innerHeight }
  }
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    const height = d.startHeight + (e.screenY - d.startY)
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => window.mirror.resizeDeviceWindow(height))
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const grow = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    const shrink = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
    if (!grow && !shrink) return
    e.preventDefault()
    window.mirror.resizeDeviceWindow(window.innerHeight + (grow ? RESIZE_STEP : -RESIZE_STEP))
  }

  return (
    <button
      type="button"
      aria-label={t('device.resizeLabel')}
      title={t('device.resizeHint')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => window.mirror.resizeDeviceWindow(0)}
      onKeyDown={onKeyDown}
      className="no-drag grid size-9 cursor-ns-resize touch-none place-items-center rounded-[var(--radius-control)] text-muted hover:bg-fg/8 hover:text-fg"
    >
      <ArrowsOutSimpleIcon size={18} />
    </button>
  )
}

function Divider() {
  return <div aria-hidden className="my-1 h-px w-6 bg-line" />
}
