import {
  CameraIcon,
  ChartLineIcon,
  CopyIcon,
  DeviceMobileIcon,
  DeviceMobileSlashIcon,
  DeviceMobileSpeakerIcon,
  CodeIcon,
  FolderOpenIcon,
  GifIcon,
  CaretLeftIcon,
  CircleIcon,
  CornersInIcon,
  CropIcon,
  CornersOutIcon,
  DownloadSimpleIcon,
  PackageIcon,
  PlayIcon,
  RecordIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  SquareIcon,
  StopIcon
} from '@phosphor-icons/react'
import { useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react'
import { isCompanionSerial, isIosSerial, QUALITY_PRESETS, type KeyName, type QualityPreset } from '../../../shared-ipc'
import { useIosControl } from '../hooks/useIosControl'
import { usePhoneActions } from '../input/phoneActions'
import { IosControlBar } from './IosControlBar'
import { CropEditor } from './CropEditor'
import { useT } from '../i18n'
import type { Crop } from '../lib/crop'
import { useShortcuts } from '../input/shortcuts'
import { useInputCapture } from '../input/useInputCapture'
import type { Selection } from './Sidebar'

export type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'error'; title: string; body: string; detail?: string }
  /** The phone disconnected; waiting for it to come back. */
  | { kind: 'reconnecting'; name: string }

interface Props {
  selection: Selection
  phase: Phase
  /** Whether the video canvas is mounted (starting or live). */
  streaming: boolean
  hasFrames: boolean
  /** Only the phone is shown (full screen with "show only the phone" on). */
  fullscreen: boolean
  /** The window is in full screen (the controls may still be shown). */
  windowFullscreen: boolean
  /** Part of the phone screen shown, or null for all of it. */
  crop: Crop | null
  onCropChange(crop: Crop | null): void
  videoRef: RefObject<HTMLDivElement | null>
  decodeError: string | null
  /** Stream width / height; defaults to a common phone shape until known. */
  aspect: number | null
  fps: number
  quality: QualityPreset
  onFpsChange(fps: number): void
  onQualityChange(q: QualityPreset): void
  onStart(): void
  onStop(): void
  onScreenshot(): void
  onCopyScreenshot(): void
  onDropFiles(paths: string[]): void
  showStats: boolean
  onToggleStats(): void
  onOpenDeviceWindow(): void
  onOpenDoctor(): void
  recording: { recording: boolean; elapsed: string; toggle(): void }
  audioOnComputer: boolean
  onToggleAudio(): void
  screenOff: boolean
  onToggleScreen(): void
  gif: { phase: 'idle' | 'recording' | 'encoding'; elapsed: string; toggle(): void }
  filesOpen: boolean
  onToggleFiles(): void
  devToolsOpen: boolean
  onToggleDevTools(): void
}

/** Bezel padding on each side, in px. */
const BEZEL = 7
const MAX_PHONE_HEIGHT = 880

const controlButton =
  'no-drag inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-xs font-medium hover:bg-fg/5 active:scale-[0.98] disabled:opacity-50'
const iconButton =
  'no-drag grid size-8 place-items-center rounded-[var(--radius-control)] text-muted hover:bg-fg/8 hover:text-fg active:scale-[0.96] disabled:opacity-40'

export function Stage(props: Props) {
  const t = useT()
  const { selection, phase, streaming, hasFrames, fullscreen, videoRef, decodeError } = props
  const screenRef = useRef<HTMLDivElement>(null)
  // iPhones are view-only unless developer control (WebDriverAgent) is on.
  const isPhone = selection?.kind === 'android'
  const isIos = isPhone && isIosSerial(selection.serial)
  const isAndroid = isPhone && !isIos
  const live = phase.kind === 'live'
  const serial = selection?.kind === 'android' ? selection.serial : null
  const iosControl = useIosControl(isIos && live && !isCompanionSerial(serial) ? serial : null)
  const [croppingOpen, setCroppingOpen] = useState(false)
  const cropping = croppingOpen && live && hasFrames
  // While editing, the whole screen shows so the box can be placed anywhere.
  const viewCrop = cropping ? null : props.crop
  const controllable = live && (isAndroid || (isIos && iosControl.on))
  const shortcuts = useShortcuts()
  const runAction = usePhoneActions(serial, props.onToggleScreen)
  useInputCapture(screenRef, controllable && !cropping ? serial : null, shortcuts, runAction, viewCrop)

  const aspect = (props.aspect ?? 1080 / 2340) * (viewCrop ? viewCrop.w / viewCrop.h : 1)
  const cap = props.windowFullscreen ? '' : `, ${MAX_PHONE_HEIGHT - 2 * BEZEL}px`
  // Fit the screen inside the stage in both orientations (container query units).
  const screenHeight = `min(100cqh - ${2 * BEZEL}px, (100cqw - ${2 * BEZEL}px) / ${aspect}${cap})`

  return (
    <DropZone enabled={controllable || (live && isCompanionSerial(serial))} ios={isIos} onDropFiles={props.onDropFiles}>
      <section aria-label={t('stage.region')} className="group relative flex min-h-0 flex-1 flex-col bg-stage">
        {fullscreen ? (
          <button
            type="button"
            onClick={() => window.mirror.toggleFullscreen()}
            className={`${controlButton} absolute end-4 top-4 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100`}
          >
            <CornersInIcon size={14} />
            {t('stage.exitFullscreen')}
          </button>
        ) : (
          <header className="drag flex h-12 shrink-0 items-center justify-end gap-1.5 px-4">
            {selection?.kind === 'fixture' && <FixtureControls {...props} />}
            {isPhone && (live || phase.kind === 'starting') && (
              <label className="no-drag flex items-center gap-2 pe-1.5 text-xs text-muted">
                {t('stage.quality')}
                <select
                  value={props.quality}
                  onChange={(e) => props.onQualityChange(e.target.value as QualityPreset)}
                  className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-xs text-fg"
                >
                  {Object.keys(QUALITY_PRESETS).map((key) => (
                    <option key={key} value={key}>
                      {t(`quality.${key}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {streaming && (
              <>
                <button
                  type="button"
                  onClick={props.onScreenshot}
                  disabled={!hasFrames}
                  aria-label={t('stage.saveScreenshot')}
                  title={t('stage.saveScreenshotHint')}
                  className={iconButton}
                >
                  <CameraIcon size={18} />
                </button>
                <button
                  type="button"
                  onClick={props.onCopyScreenshot}
                  disabled={!hasFrames}
                  aria-label={t('stage.copyScreenshot')}
                  title={t('stage.copyScreenshotHint')}
                  className={iconButton}
                >
                  <CopyIcon size={18} />
                </button>
                {isPhone && (
                  <button
                    type="button"
                    onClick={() => setCroppingOpen((v) => !v)}
                    disabled={!live || !hasFrames}
                    aria-label={t('crop.label')}
                    aria-pressed={cropping || !!props.crop}
                    title={props.crop ? t('crop.change') : t('crop.start')}
                    className={`${iconButton} ${cropping || props.crop ? 'bg-accent-soft text-accent' : ''}`}
                  >
                    <CropIcon size={18} />
                  </button>
                )}
                {isPhone && (
                  <button
                    type="button"
                    onClick={props.onToggleFiles}
                    disabled={!live}
                    aria-label={t('stage.files')}
                    aria-pressed={props.filesOpen}
                    title={isIos ? t('stage.filesIos') : t('stage.filesAndroid')}
                    className={`${iconButton} ${props.filesOpen ? 'bg-accent-soft text-accent' : ''}`}
                  >
                    <FolderOpenIcon size={18} />
                  </button>
                )}
                {isAndroid && (
                  <button
                    type="button"
                    onClick={props.onToggleDevTools}
                    disabled={!live}
                    aria-label={t('stage.devtools')}
                    aria-pressed={props.devToolsOpen}
                    title={t('stage.devtoolsHint')}
                    className={`${iconButton} ${props.devToolsOpen ? 'bg-accent-soft text-accent' : ''}`}
                  >
                    <CodeIcon size={18} />
                  </button>
                )}
                {isAndroid && (
                  <button
                    type="button"
                    onClick={props.onToggleScreen}
                    disabled={!live}
                    aria-label={t('stage.screenOff')}
                    aria-pressed={props.screenOff}
                    title={props.screenOff ? t('stage.screenOn') : t('stage.screenOffHint')}
                    className={`${iconButton} ${props.screenOff ? 'bg-accent-soft text-accent' : ''}`}
                  >
                    {props.screenOff ? <DeviceMobileSlashIcon size={18} /> : <DeviceMobileIcon size={18} />}
                  </button>
                )}
                {isPhone && (
                  <button
                    type="button"
                    onClick={props.onToggleAudio}
                    aria-label={props.audioOnComputer ? t('stage.soundHere') : t('stage.soundPhone')}
                    aria-pressed={props.audioOnComputer}
                    title={
                      props.audioOnComputer ? t('stage.soundHereHint') : t('stage.soundPhoneHint')
                    }
                    className={iconButton}
                  >
                    {props.audioOnComputer ? <SpeakerHighIcon size={18} /> : <SpeakerSlashIcon size={18} />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={props.onOpenDeviceWindow}
                  disabled={!hasFrames}
                  aria-label={t('stage.deviceWindow')}
                  title={t('stage.deviceWindowHint')}
                  className={iconButton}
                >
                  <DeviceMobileSpeakerIcon size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => window.mirror.toggleFullscreen()}
                  aria-label={props.windowFullscreen ? t('stage.exitFullscreen') : t('stage.fullscreen')}
                  title={props.windowFullscreen ? t('stage.exitFullscreen') : t('stage.fullscreen')}
                  className={iconButton}
                >
                  {props.windowFullscreen ? <CornersInIcon size={18} /> : <CornersOutIcon size={18} />}
                </button>
                <button
                  type="button"
                  onClick={props.onToggleStats}
                  aria-label={t('stage.stats')}
                  aria-pressed={props.showStats}
                  title={t('stage.statsHint')}
                  className={`${iconButton} ${props.showStats ? 'bg-accent-soft text-accent' : ''}`}
                >
                  <ChartLineIcon size={18} />
                </button>
              </>
            )}
            {streaming && (
              <button
                type="button"
                onClick={props.gif.toggle}
                disabled={!hasFrames || props.gif.phase === 'encoding'}
                aria-pressed={props.gif.phase === 'recording'}
                title={t('stage.gifHint')}
                className={`${controlButton} ms-1.5 ${props.gif.phase === 'recording' ? 'border-err/50 text-err' : ''}`}
              >
                <GifIcon size={14} weight={props.gif.phase === 'recording' ? 'fill' : 'regular'} />
                {props.gif.phase === 'recording' ? (
                  <span className="font-mono tabular-nums">{props.gif.elapsed}</span>
                ) : props.gif.phase === 'encoding' ? (
                  t('stage.gifSaving')
                ) : (
                  t('stage.gif')
                )}
              </button>
            )}
            {isPhone && live && (
              <button
                type="button"
                onClick={props.recording.toggle}
                disabled={!hasFrames}
                aria-pressed={props.recording.recording}
                title={t('stage.recordHint')}
                className={`${controlButton} ms-1.5 ${props.recording.recording ? 'border-err/50 text-err' : ''}`}
              >
                {props.recording.recording ? (
                  <>
                    <span aria-hidden className="size-2 rounded-full bg-err motion-safe:animate-pulse" />
                    <span className="font-mono tabular-nums">{props.recording.elapsed}</span>
                    <span>{t('stage.stopRecording')}</span>
                  </>
                ) : (
                  <>
                    <RecordIcon size={14} weight="fill" className="text-err" />
                    {t('stage.record')}
                  </>
                )}
              </button>
            )}
            {isPhone && live && (
              <button type="button" onClick={props.onStop} className={`${controlButton} ms-1.5`}>
                <StopIcon size={14} weight="fill" />
                {t('stage.stopMirroring')}
              </button>
            )}
          </header>
        )}

        <div className={`flex min-h-0 flex-1 flex-col items-center gap-4 ${fullscreen ? 'p-4' : 'p-8 pt-2'}`}>
          {streaming ? (
            <>
              <div className="relative min-h-0 w-full flex-1" style={{ containerType: 'size' }}>
                <div className="absolute inset-0 grid place-items-center">
                  <div
                    className="phone rounded-[40px] bg-[var(--bezel)]"
                    style={{ padding: BEZEL, boxShadow: 'var(--phone-shadow)' }}
                  >
                    <div
                      ref={screenRef}
                      tabIndex={controllable ? 0 : -1}
                      aria-label={controllable ? t('stage.screenLabel') : undefined}
                      className="phone-screen relative overflow-hidden rounded-[33px] bg-[var(--bezel)]"
                      style={{ aspectRatio: aspect, height: screenHeight, touchAction: 'none' }}
                    >
                      <div
                        ref={videoRef}
                        className={viewCrop ? 'absolute' : 'h-full w-full'}
                        style={
                          viewCrop
                            ? {
                                width: `${100 / viewCrop.w}%`,
                                height: `${100 / viewCrop.h}%`,
                                left: `${(-viewCrop.x / viewCrop.w) * 100}%`,
                                top: `${(-viewCrop.y / viewCrop.h) * 100}%`
                              }
                            : undefined
                        }
                      />
                      {!hasFrames && <ScreenSkeleton />}
                      {cropping && (
                        <CropEditor
                          initial={props.crop}
                          onCancel={() => setCroppingOpen(false)}
                          onApply={(c) => {
                            props.onCropChange(c)
                            setCroppingOpen(false)
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
              {serial && !isIos && <NavBar serial={serial} enabled={controllable} />}
              {isIos && live && (
                <IosControlBar
                  available={iosControl.available}
                  state={iosControl.state}
                  companion={isCompanionSerial(serial)}
                  onToggle={iosControl.toggle}
                  onHome={() => runAction('home')}
                />
              )}
            </>
          ) : (
            <div className="grid flex-1 place-items-center">
              <EmptyStage selection={selection} phase={phase} onRetry={props.onStart} onOpenDoctor={props.onOpenDoctor} />
            </div>
          )}
        </div>

        {decodeError && (
          <p role="alert" className="mx-6 mb-3 text-center text-xs text-err">
            The video decoder stopped: {decodeError}. Asking the phone for a fresh frame.
          </p>
        )}
      </section>
    </DropZone>
  )
}

function DropZone({
  enabled,
  ios,
  onDropFiles,
  children
}: {
  enabled: boolean
  /** iPhone (companion app): files land in the FreeFlect app's folder. */
  ios: boolean
  onDropFiles(paths: string[]): void
  children: ReactNode
}) {
  const [drag, setDrag] = useState<{ apkOnly: boolean } | null>(null)
  // dragenter/dragleave fire for every child; count to know when we truly left.
  const depth = useRef(0)

  const t = useT()
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const onDragEnter = (e: DragEvent) => {
    if (!enabled || !hasFiles(e)) return
    depth.current++
    const items = [...e.dataTransfer.items]
    // File names are hidden during drag; MIME type identifies APKs.
    const apkOnly = items.length > 0 && items.every((i) => i.type === 'application/vnd.android.package-archive')
    setDrag({ apkOnly })
  }
  const onDragLeave = () => {
    if (--depth.current <= 0) {
      depth.current = 0
      setDrag(null)
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setDrag(null)
    if (!enabled) return
    const paths = [...e.dataTransfer.files].map((f) => window.mirror.pathForFile(f)).filter(Boolean)
    if (paths.length) onDropFiles(paths)
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => enabled && hasFiles(e) && e.preventDefault()}
      onDrop={onDrop}
    >
      {children}
      {drag && (
        <div className="pointer-events-none absolute inset-3 z-10 grid place-items-center rounded-[var(--radius-panel)] border-2 border-dashed border-accent bg-accent-soft backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 text-center">
            {drag.apkOnly ? (
              <PackageIcon size={32} className="text-accent" />
            ) : (
              <DownloadSimpleIcon size={32} className="text-accent" />
            )}
            <p className="text-base font-medium">{drag.apkOnly && !ios ? t('drop.install') : t('drop.send')}</p>
            <p className="text-sm text-muted">{ios ? t('drop.iosHint') : drag.apkOnly ? t('drop.apkHint') : t('drop.androidHint')}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function FixtureControls({ streaming, fps, onFpsChange, onStart, onStop }: Props) {
  const t = useT()
  return (
    <div className="no-drag flex items-center gap-2">
      <label htmlFor="fps" className="text-xs text-muted">
        {t('stage.frameRate')}
      </label>
      <select
        id="fps"
        value={fps}
        disabled={streaming}
        onChange={(e) => onFpsChange(Number(e.target.value))}
        className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-xs disabled:opacity-60"
      >
        <option value={30}>30 fps</option>
        <option value={60}>60 fps</option>
        <option value={120}>120 fps</option>
      </select>
      {streaming ? (
        <button type="button" onClick={onStop} className={controlButton}>
          <StopIcon size={14} weight="fill" />
          {t('stage.stop')}
        </button>
      ) : (
        <button
          type="button"
          onClick={onStart}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
        >
          <PlayIcon size={14} weight="fill" />
          {t('stage.start')}
        </button>
      )}
    </div>
  )
}

function NavBar({ serial, enabled }: { serial: string; enabled: boolean }) {
  const t = useT()
  const tap = (key: KeyName) => {
    window.mirror.sendInput(serial, { type: 'key', key, down: true, modifiers: 0 })
    window.mirror.sendInput(serial, { type: 'key', key, down: false, modifiers: 0 })
  }
  const button = (key: KeyName, label: string, icon: ReactNode) => (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => tap(key)}
      aria-label={label}
      title={label}
      className="grid size-10 place-items-center rounded-full text-muted transition-colors hover:bg-fg/8 hover:text-fg active:scale-[0.96] disabled:opacity-40"
    >
      {icon}
    </button>
  )
  return (
    <nav aria-label={t('nav.label')} className="flex shrink-0 items-center gap-6">
      {button('back', t('nav.backHint'), <CaretLeftIcon size={18} weight="bold" className="rtl:-scale-x-100" />)}
      {button('home', t('nav.home'), <CircleIcon size={16} weight="bold" />)}
      {button('recents', t('nav.recents'), <SquareIcon size={15} weight="bold" />)}
    </nav>
  )
}

function ScreenSkeleton() {
  const t = useT()
  return (
    <div className="absolute inset-0 grid place-items-center bg-[var(--bezel)]">
      <p className="text-sm text-[oklch(0.8_0.01_260)]">{t('stage.starting')}</p>
    </div>
  )
}

function EmptyStage({
  selection,
  phase,
  onRetry,
  onOpenDoctor
}: {
  selection: Selection
  phase: Phase
  onRetry(): void
  onOpenDoctor(): void
}) {
  const t = useT()
  if (phase.kind === 'reconnecting') {
    return (
      <div role="status" className="max-w-sm text-center">
        <span className="relative mx-auto grid size-10 place-items-center">
          <span className="absolute inset-0 rounded-full bg-accent/25 motion-safe:animate-ping" />
          <span className="relative size-3 rounded-full bg-accent" />
        </span>
        <p className="mt-4 text-base font-medium">{t('stage.reconnecting', { name: phase.name })}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">{t('stage.reconnectingBody')}</p>
        <button type="button" onClick={onRetry} className="mt-5 text-sm font-medium text-accent hover:underline">
          {t('stage.stopWaiting')}
        </button>
      </div>
    )
  }
  const retryButton = (
    <button
      type="button"
      onClick={onRetry}
      className="mt-5 rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
    >
      {t('common.tryAgain')}
    </button>
  )
  if (phase.kind === 'error') {
    return (
      <div role="alert" className="max-w-sm text-center">
        <p className="text-base font-medium">{phase.title}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">{phase.body}</p>
        <div className="flex items-center justify-center gap-4">
          {retryButton}
          <button type="button" onClick={onOpenDoctor} className="mt-5 text-sm font-medium text-accent hover:underline">
            {t('common.runDoctor')}
          </button>
        </div>
        {phase.detail && (
          <details className="mt-4 text-start text-xs text-muted">
            <summary className="cursor-default">{t('common.details')}</summary>
            <p className="mt-1 break-words font-mono">{phase.detail}</p>
          </details>
        )}
      </div>
    )
  }
  const [title, body] =
    selection?.kind === 'android'
      ? [t('stage.stopped'), t('stage.stoppedBody')]
      : selection?.kind === 'fixture'
        ? [t('stage.fixtureReady'), t('stage.fixtureReadyBody')]
        : [t('stage.pick'), t('stage.pickBody')]
  return (
    <div className="max-w-sm text-center">
      <p className="text-base font-medium">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      {selection?.kind === 'android' && retryButton}
    </div>
  )
}
