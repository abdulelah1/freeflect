import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CaretRightIcon,
  CheckCircleIcon,
  DeviceMobileIcon,
  HandTapIcon,
  LifebuoyIcon,
  PlugIcon,
  UsbIcon,
  WifiHighIcon,
  XIcon
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AndroidDevice, DeviceProps } from '../../../shared-ipc'
import { BrandLogo } from '../components/BrandLogo'
import { CompanionInstaller } from '../components/CompanionInstaller'
import { useT } from '../i18n'
import { Rich } from '../lib/Rich'
import { lang } from '../i18n'
import lockupAr from '../assets/brand/freeflect-lockup-ar.svg'
import lockupArDark from '../assets/brand/freeflect-lockup-ar-on-dark.svg'
import lockup from '../assets/brand/freeflect-lockup.svg'
import lockupDark from '../assets/brand/freeflect-lockup-on-dark.svg'
import { WifiPairPanel } from '../components/WifiPairPanel'
import { BRANDS, brandById, brandFromManufacturer, type BrandId } from './guides'

type Platform = 'android' | 'ios'
type Method = 'usb' | 'wifi'
type StepId =
  | 'platform'
  | 'method'
  | 'brand'
  | 'devOptions'
  | 'usbDebugging'
  | 'connect'
  | 'authorize'
  | 'wifiPair'
  | 'iosCable'
  | 'iosApp'
  | 'iosAllow'
  | 'iosBroadcast'
  | 'done'

const FLOWS: Record<`${Platform}-${Method}`, StepId[]> = {
  'android-usb': ['platform', 'method', 'brand', 'devOptions', 'usbDebugging', 'connect', 'authorize', 'done'],
  'android-wifi': ['platform', 'method', 'brand', 'devOptions', 'wifiPair', 'done'],
  'ios-usb': ['platform', 'method', 'iosCable', 'done'],
  'ios-wifi': ['platform', 'method', 'iosApp', 'iosAllow', 'iosBroadcast', 'done']
}
/** Steps that finish on their own when the phone is detected. */
const AUTO_STEPS: StepId[] = ['connect', 'authorize', 'wifiPair', 'iosCable', 'iosAllow', 'iosBroadcast']
/** Steps the user confirms with Continue. */
const CONTINUE_STEPS: StepId[] = ['devOptions', 'usbDebugging', 'iosApp', 'iosAllow']
/** Mirroring an iPhone over a cable uses macOS screen capture. */
const IS_MAC = navigator.userAgent.includes('Mac')
const POLL_MS = 1000

interface Props {
  onClose(): void
  /** Setup finished; start mirroring this device. */
  onComplete(serial: string): void
  onOpenDoctor(): void
}

export function SetupWizard({ onClose, onComplete, onOpenDoctor }: Props) {
  const t = useT()
  const [step, setStep] = useState<StepId>('platform')
  const [platform, setPlatform] = useState<Platform>('android')
  const [method, setMethod] = useState<Method>('usb')
  const [iosDevices, setIosDevices] = useState<AndroidDevice[]>([])
  /** Allowed iPhones when the Allow step opened; one more means the user allowed it. */
  const [allowedBefore, setAllowedBefore] = useState<number | null>(null)
  const [allowedNow, setAllowedNow] = useState(0)
  const [brand, setBrand] = useState<BrandId | null>(null)
  const [devices, setDevices] = useState<AndroidDevice[]>([])
  const [ready, setReady] = useState<{ serial: string; props: DeviceProps | null; name?: string } | null>(null)

  const flow = FLOWS[`${platform}-${method}`]
  const index = flow.indexOf(step)
  const go = (s: StepId) => {
    // Re-entering the Allow step measures from that moment again.
    if (s === 'iosAllow') setAllowedBefore(null)
    setStep(s)
  }
  const next = () => go(flow[Math.min(index + 1, flow.length - 1)]!)
  const back = () => go(flow[Math.max(index - 1, 0)]!)

  // Watch for the phone while the wizard is open.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      const [list, ios, allowed] = await Promise.all([
        window.mirror.listAndroidDevices().catch(() => []),
        window.mirror.listIosDevices().catch(() => []),
        window.mirror.listCompanionDevices().catch(() => [])
      ])
      if (!alive) return
      setDevices(list)
      setIosDevices(ios)
      setAllowedNow(allowed.length)
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const onTransport = devices.filter((d) => d.transport === method)
  const authorized = onTransport.find((d) => d.state === 'device')
  const waitingForAllow = onTransport.find((d) => d.state === 'unauthorized')

  const finish = useCallback(async (serial: string) => {
    const props = await window.mirror.deviceProps(serial).catch(() => null)
    if (props) setBrand((b) => b ?? brandFromManufacturer(props.manufacturer))
    setReady({ serial, props })
    setStep('done')
  }, [])

  // iPhone steps advance when the phone shows up where the step expects it.
  const iosCabled = iosDevices.find((d) => d.serial.startsWith('ios:'))
  const iosBroadcasting = iosDevices.find((d) => d.serial.startsWith('companion:'))
  useEffect(() => {
    if (platform !== 'ios') return
    if (step === 'iosCable' && iosCabled) {
      setReady({ serial: iosCabled.serial, props: null, name: iosCabled.model ?? t('setup.yourIphone') })
      setStep('done')
    } else if (step === 'iosAllow') {
      if (allowedBefore === null) setAllowedBefore(allowedNow)
      else if (allowedNow > allowedBefore) setStep('iosBroadcast')
    } else if (step === 'iosBroadcast' && iosBroadcasting) {
      setReady({ serial: iosBroadcasting.serial, props: null, name: iosBroadcasting.model ?? t('setup.yourIphone') })
      setStep('done')
    }
  }, [platform, step, iosCabled, iosBroadcasting, allowedBefore, allowedNow])

  // Advance on its own as soon as the phone reaches the state a step waits for.
  useEffect(() => {
    if (platform !== 'android' || step === 'done' || step === 'platform' || step === 'method') return
    if (authorized) void finish(authorized.serial)
    else if (method === 'usb' && waitingForAllow && step !== 'authorize') setStep('authorize')
  }, [platform, step, method, authorized, waitingForAllow, finish])

  const guide = brandById(brand)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-title"
      className="fixed inset-0 z-30 flex flex-col bg-bg"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <header className="drag flex h-12 shrink-0 items-center justify-between ps-20 pe-4">
        <Progress total={flow.length - 1} current={Math.min(index, flow.length - 1)} />
        <button
          type="button"
          onClick={onClose}
          className="no-drag inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-fg/8 hover:text-fg"
        >
          <XIcon size={14} />
          {t('setup.close')}
        </button>
      </header>

      <main className="flex min-h-0 flex-1 overflow-y-auto">
        <div key={step} className="step-enter mx-auto w-full max-w-[880px] px-8 py-10">
          {step === 'platform' && (
            <ChoiceStep title={t('setup.platform.title')} brand>
              <Choice
                icon={<BrandLogo brand="android" size={26} />}
                title={t('setup.platform.android')}
                body={t('setup.platform.androidBody')}
                onClick={() => {
                  setPlatform('android')
                  go('method')
                }}
              />
              <Choice
                icon={<BrandLogo brand="apple" size={26} />}
                title={t('common.iphone')}
                body={t('setup.platform.iphoneBody')}
                onClick={() => {
                  setPlatform('ios')
                  go('method')
                }}
              />
            </ChoiceStep>
          )}

          {step === 'method' && platform === 'ios' && (
            <ChoiceStep title={t('setup.method.iosTitle')}>
              <Choice
                icon={<UsbIcon size={26} />}
                title={t('setup.method.cableTitle')}
                body={
                  IS_MAC
                    ? t('setup.method.iosCable')
                    : t('setup.method.iosCableMacOnly')
                }
                disabled={!IS_MAC}
                onClick={() => {
                  setMethod('usb')
                  go('iosCable')
                }}
              />
              <Choice
                icon={<WifiHighIcon size={26} />}
                title={t('common.wifi')}
                body={t('setup.method.iosWifi')}
                onClick={() => {
                  setMethod('wifi')
                  go('iosApp')
                }}
              />
            </ChoiceStep>
          )}

          {step === 'method' && platform === 'android' && (
            <ChoiceStep title={t('setup.method.title')}>
              <Choice
                icon={<UsbIcon size={26} />}
                title={t('setup.method.cableTitle')}
                body={t('setup.method.cable')}
                onClick={() => {
                  setMethod('usb')
                  go('brand')
                }}
              />
              <Choice
                icon={<WifiHighIcon size={26} />}
                title={t('common.wifi')}
                body={t('setup.method.wifi')}
                onClick={() => {
                  setMethod('wifi')
                  go('brand')
                }}
              />
            </ChoiceStep>
          )}

          {step === 'brand' && (
            <ChoiceStep title={t('setup.brand.title')} wide>
              {BRANDS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => {
                    setBrand(b.id)
                    go('devOptions')
                  }}
                  className={`rounded-[var(--radius-panel)] border px-4 py-3.5 text-start text-sm font-medium transition-colors hover:border-accent hover:bg-accent-soft active:scale-[0.98] ${
                    brand === b.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
                  }`}
                >
                  {b.name.startsWith('brands.') ? t(b.name) : b.name}
                </button>
              ))}
            </ChoiceStep>
          )}

          {step === 'devOptions' && (
            <InstructionStep
              title={t('setup.devOptions.title')}
              status={<LiveStatus devices={onTransport} method={method} />}
              help={[
                t('setup.devOptions.help1', { item: t(`phoneMenu.${guide.tapTarget}`) }),
                t('setup.devOptions.help2'),
                t('setup.devOptions.help3')
              ]}
              onOpenDoctor={onOpenDoctor}
            >
              <ol className="grid gap-4">
                <Instruction n={1}>
                  {t('setup.open')} <Path parts={guide.buildNumberPath} />
                </Instruction>
                <Instruction n={2}>
                  <Rich text={t('setup.devOptions.tap', { item: t(`phoneMenu.${guide.tapTarget}`) })} />
                </Instruction>
              </ol>
            </InstructionStep>
          )}

          {step === 'usbDebugging' && (
            <InstructionStep
              title={t('setup.usbDebugging.title')}
              status={<LiveStatus devices={onTransport} method={method} />}
              help={[
                t('setup.usbDebugging.help1'),
                t('setup.usbDebugging.help2')
              ]}
              onOpenDoctor={onOpenDoctor}
            >
              <ol className="grid gap-4">
                <Instruction n={1}>
                  {t('setup.open')} <Path parts={guide.developerOptionsPath} />
                </Instruction>
                <Instruction n={2}>
                  <Rich text={t('setup.usbDebugging.turnOn')} />
                </Instruction>
                {guide.extraSwitches?.map((sw, i) => (
                  <Instruction key={sw.name} n={3 + i}>
                    <Rich text={t('setup.usbDebugging.also', { name: t(sw.name) })} />
                    <span className="mt-1 block text-[13px] text-muted">{t(sw.why)}</span>
                  </Instruction>
                ))}
              </ol>
            </InstructionStep>
          )}

          {step === 'connect' && (
            <InstructionStep
              title={t('setup.connect.title')}
              status={<LiveStatus devices={onTransport} method={method} />}
              help={[
                t('setup.connect.help1'),
                t('setup.connect.help2'),
                t('setup.connect.help3')
              ]}
              onOpenDoctor={onOpenDoctor}
            >
              <ol className="grid gap-4">
                <Instruction n={1}>{t('setup.connect.step1')}</Instruction>
                <Instruction n={2}>{t('setup.connect.step2')}</Instruction>
                {guide.needsFileTransferMode && (
                  <Instruction n={3}>
                    <Rich text={t('setup.connect.fileTransfer')} />
                  </Instruction>
                )}
              </ol>
            </InstructionStep>
          )}

          {step === 'authorize' && (
            <InstructionStep
              title={t('setup.authorize.title')}
              status={<LiveStatus devices={onTransport} method={method} />}
              help={[
                t('setup.authorize.help1'),
                t('setup.authorize.help2')
              ]}
              onOpenDoctor={onOpenDoctor}
            >
              <ol className="grid gap-4">
                <Instruction n={1}>{t('setup.authorize.step1')}</Instruction>
                <Instruction n={2}>
                  <Rich text={t('setup.authorize.step2')} />
                </Instruction>
                <Instruction n={3}>
                  <Rich text={t('setup.authorize.step3')} />
                </Instruction>
              </ol>
            </InstructionStep>
          )}

          {step === 'wifiPair' && (
            <div className="max-w-[640px]">
              <h1 id="setup-title" className="text-2xl font-semibold tracking-tight">
                {t('setup.wifiPair.title')}
              </h1>
              <p className="mt-2 text-sm text-muted">{t('setup.wifiPair.body')}</p>
              <div className="mt-8 rounded-[var(--radius-panel)] border border-line bg-surface p-6">
                <WifiPairPanel onConnected={(serial) => void finish(serial)} />
              </div>
              <HelpBox
                items={[
                  t('setup.wifiPair.help1'),
                  t('setup.wifiPair.help2')
                ]}
                onOpenDoctor={onOpenDoctor}
              />
            </div>
          )}

          {step === 'iosCable' && (
            <InstructionStep
              title={t('setup.iosCable.title')}
              status={<IosStatus found={iosCabled?.model ?? null} waiting={t('setup.iosCable.waiting')} />}
              help={[
                t('setup.iosCable.help1'),
                t('setup.iosCable.help2'),
                t('setup.iosCable.help3'),
                t('setup.iosCable.help4')
              ]}
              onOpenDoctor={onOpenDoctor}
            >
              <ol className="grid gap-4">
                <Instruction n={1}>{t('setup.iosCable.step1')}</Instruction>
                <Instruction n={2}>
                  <Rich text={t('setup.iosCable.step2')} />
                </Instruction>
                <Instruction n={3}>{t('setup.iosCable.step3')}</Instruction>
              </ol>
            </InstructionStep>
          )}

          {step === 'iosApp' && (
            <div className="max-w-[720px]">
              <h1 id="setup-title" className="text-2xl font-semibold tracking-tight">
                {t('setup.iosApp.title')}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {t('setup.iosApp.body')}
              </p>
              <div className="mt-8 rounded-[var(--radius-panel)] border border-line bg-surface p-6">
                <CompanionInstaller />
              </div>
              <HelpBox
                items={[
                  t('setup.iosApp.help1'),
                  t('setup.iosApp.help2'),
                  t('setup.iosApp.help3'),
                  t('setup.iosApp.help4')
                ]}
                onOpenDoctor={onOpenDoctor}
              />
            </div>
          )}

          {step === 'iosAllow' && (
            <InstructionStep
              title={t('setup.iosAllow.title')}
              status={
                <IosStatus
                  found={allowedBefore !== null && allowedNow > allowedBefore ? t('setup.iosAllow.allowed') : null}
                  waiting={t('setup.iosAllow.waiting')}
                />
              }
              help={[
                t('setup.iosAllow.help1'),
                t('setup.iosAllow.help2'),
                t('setup.iosAllow.help3')
              ]}
              onOpenDoctor={onOpenDoctor}
            >
              <ol className="grid gap-4">
                <Instruction n={1}>{t('setup.iosAllow.step1')}</Instruction>
                <Instruction n={2}>
                  <Rich text={t('setup.iosAllow.step2')} />
                </Instruction>
                <Instruction n={3}>{t('setup.iosAllow.step3')}</Instruction>
              </ol>
            </InstructionStep>
          )}

          {step === 'iosBroadcast' && (
            <InstructionStep
              title={t('setup.iosBroadcast.title')}
              status={<IosStatus found={iosBroadcasting?.model ?? null} waiting={t('setup.iosBroadcast.waiting')} />}
              help={[
                t('setup.iosBroadcast.help1'),
                t('setup.iosBroadcast.help2'),
                t('setup.iosBroadcast.help3')
              ]}
              onOpenDoctor={onOpenDoctor}
            >
              <ol className="grid gap-4">
                <Instruction n={1}>
                  <Rich text={t('setup.iosBroadcast.step1')} />
                </Instruction>
                <Instruction n={2}>
                  <Rich text={t('setup.iosBroadcast.step2')} />
                </Instruction>
              </ol>
            </InstructionStep>
          )}

          {step === 'done' && ready && platform === 'ios' && (
            <IosDone name={ready.name ?? t('setup.yourIphone')} cable={method === 'usb'} onStart={() => onComplete(ready.serial)} />
          )}

          {step === 'done' && ready && platform === 'android' && (
            <Done serial={ready.serial} props={ready.props} onStart={() => onComplete(ready.serial)} />
          )}
        </div>
      </main>

      {!['platform', 'done'].includes(step) && (
        <footer className="flex shrink-0 items-center justify-between border-t border-line px-8 py-4">
          <button
            type="button"
            onClick={back}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium text-muted hover:bg-fg/8 hover:text-fg"
          >
            <ArrowLeftIcon size={16} className="rtl:-scale-x-100" />
            {t('setup.back')}
          </button>
          {CONTINUE_STEPS.includes(step) && (
            <button
              type="button"
              onClick={next}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
            >
              {t('setup.continue')}
              <ArrowRightIcon size={16} className="rtl:-scale-x-100" />
            </button>
          )}
          {AUTO_STEPS.includes(step) && !CONTINUE_STEPS.includes(step) && (
            <span className="text-sm text-muted">{t('setup.waiting')}</span>
          )}
        </footer>
      )}
    </div>
  )
}

function Progress({ total, current }: { total: number; current: number }) {
  const t = useT()
  return (
    <div
      role="progressbar"
      aria-label={t('setup.progress')}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={current}
      className="flex items-center gap-1"
    >
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`h-1 w-6 rounded-full ${i < current ? 'bg-accent' : 'bg-fg/12'}`} />
      ))}
    </div>
  )
}

function ChoiceStep({ title, wide, brand, children }: { title: string; wide?: boolean; brand?: boolean; children: ReactNode }) {
  return (
    <div>
      {brand && <BrandLockup />}
      <h1 id="setup-title" className="text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      <div className={`mt-8 grid gap-3 ${wide ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2'}`}>{children}</div>
    </div>
  )
}

function Choice(props: { icon: ReactNode; title: string; body: string; onClick?(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="group flex items-start gap-4 rounded-[var(--radius-panel)] border border-line bg-surface p-5 text-start transition-colors hover:border-accent hover:bg-accent-soft active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-line disabled:hover:bg-surface"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-control)] bg-fg/6 text-fg group-hover:text-accent group-disabled:text-muted">
        {props.icon}
      </span>
      <span>
        <span className="block text-base font-medium">{props.title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-muted">{props.body}</span>
      </span>
    </button>
  )
}

function InstructionStep(props: {
  title: string
  status: ReactNode
  help: string[]
  onOpenDoctor(): void
  children: ReactNode
}) {
  return (
    <div className="grid gap-10 lg:grid-cols-[1.25fr_1fr]">
      <div>
        <h1 id="setup-title" className="text-2xl font-semibold tracking-tight">
          {props.title}
        </h1>
        <div className="mt-8 text-[15px] leading-relaxed">{props.children}</div>
        <HelpBox items={props.help} onOpenDoctor={props.onOpenDoctor} />
      </div>
      <div className="lg:pt-14">{props.status}</div>
    </div>
  )
}

function Instruction({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent"
      >
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  )
}

function Path({ parts }: { parts: string[] }) {
  const t = useT()
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1">
      {parts.map((p, i) => (
        <span key={p} className="inline-flex items-center gap-1">
          {i > 0 && <CaretRightIcon size={12} className="text-muted rtl:-scale-x-100" aria-label={t('setup.then')} />}
          <span className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-0.5 text-sm font-medium">
            {t(`phoneMenu.${p}`)}
          </span>
        </span>
      ))}
    </span>
  )
}

function HelpBox({ items, onOpenDoctor }: { items: string[]; onOpenDoctor(): void }) {
  const t = useT()
  return (
    <details className="mt-10 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3">
      <summary className="flex cursor-default items-center gap-2 text-sm font-medium">
        <LifebuoyIcon size={16} className="text-muted" />
        {t('setup.trouble')}
      </summary>
      <ul className="mt-3 grid gap-2 ps-6 text-[13px] leading-relaxed text-muted">
        {items.map((t) => (
          <li key={t} className="list-disc">
            {t}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onOpenDoctor}
        className="mt-3 ms-6 text-[13px] font-medium text-accent hover:underline"
      >
        {t('common.runDoctor')}
      </button>
    </details>
  )
}

/** Live view of what the computer currently sees. */
function LiveStatus({ devices, method }: { devices: AndroidDevice[]; method: Method }) {
  const t = useT()
  const authorized = devices.find((d) => d.state === 'device')
  const pending = devices.find((d) => d.state === 'unauthorized')
  const [icon, title, body] = authorized
    ? [<CheckCircleIcon key="ok" size={28} weight="fill" className="text-ok" />, t('setup.live.connected'), authorized.model ?? '']
    : pending
      ? [<HandTapIcon key="tap" size={28} className="text-warn" />, t('setup.live.found'), t('setup.live.foundBody')]
      : [
          <span key="wait" className="relative grid size-7 place-items-center">
            <span className="absolute inset-0 rounded-full bg-accent/25 motion-safe:animate-ping" />
            {method === 'usb' ? <PlugIcon size={22} className="relative text-accent" /> : <WifiHighIcon size={22} className="relative text-accent" />}
          </span>,
          t('setup.live.none'),
          method === 'usb' ? t('setup.live.noneUsb') : t('setup.live.noneWifi')
        ]
  return (
    <div role="status" className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5">{icon}</span>
        <div>
          <p className="text-sm font-medium">{title}</p>
          {body && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{body}</p>}
        </div>
      </div>
    </div>
  )
}

function Done({ serial, props, onStart }: { serial: string; props: DeviceProps | null; onStart(): void }) {
  const t = useT()
  const name = useMemo(() => {
    if (!props) return t('setup.yourPhone')
    const maker = props.manufacturer.charAt(0).toUpperCase() + props.manufacturer.slice(1)
    return `${maker} ${props.marketName || props.model}`
  }, [props, t])
  return (
    <div className="grid gap-10 lg:grid-cols-[1.25fr_1fr]">
      <div>
        <CheckCircleIcon size={40} weight="fill" className="text-ok" />
        <h1 id="setup-title" className="mt-4 text-2xl font-semibold tracking-tight">
          {t('setup.done.ready', { name })}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {props ? `${t('setup.done.android', { version: props.androidVersion })} ` : ''}{t('setup.done.nextTime')}
        </p>
        <button
          type="button"
          onClick={onStart}
          className="mt-8 inline-flex items-center gap-2 rounded-[var(--radius-control)] bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
        >
          <DeviceMobileIcon size={18} />
          {t('setup.done.start')}
        </button>
        <span className="sr-only">Device {serial}</span>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
        <p className="text-sm font-medium">{t('setup.done.goodToKnow')}</p>
        <ul className="mt-3 grid gap-2.5 text-[13px] leading-relaxed text-muted">
          <li>{t('setup.done.tip1')}</li>
          <li>{t('setup.done.tip2')}</li>
          <li>{t('setup.done.tip3')}</li>
        </ul>
      </div>
    </div>
  )
}

/** What the computer currently sees of the iPhone. */
function IosStatus({ found, waiting }: { found: string | null; waiting: string }) {
  const t = useT()
  return (
    <div role="status" className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5">
          {found ? (
            <CheckCircleIcon size={28} weight="fill" className="text-ok" />
          ) : (
            <span className="relative grid size-7 place-items-center">
              <span className="absolute inset-0 rounded-full bg-accent/25 motion-safe:animate-ping" />
              <BrandLogo brand="apple" size={18} className="relative text-accent" />
            </span>
          )}
        </span>
        <div>
          <p className="text-sm font-medium">{found ?? t('setup.iosStatus.none')}</p>
          {!found && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{waiting}</p>}
        </div>
      </div>
    </div>
  )
}

function IosDone({ name, cable, onStart }: { name: string; cable: boolean; onStart(): void }) {
  const t = useT()
  return (
    <div className="grid gap-10 lg:grid-cols-[1.25fr_1fr]">
      <div>
        <CheckCircleIcon size={40} weight="fill" className="text-ok" />
        <h1 id="setup-title" className="mt-4 text-2xl font-semibold tracking-tight">
          {t('setup.done.ready', { name })}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {cable ? t('setup.iosDone.nextCable') : t('setup.iosDone.nextWifi')}
        </p>
        <button
          type="button"
          onClick={onStart}
          className="mt-8 inline-flex items-center gap-2 rounded-[var(--radius-control)] bg-accent px-5 py-2.5 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
        >
          <DeviceMobileIcon size={18} />
          {t('setup.done.start')}
        </button>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
        <p className="text-sm font-medium">{t('setup.done.goodToKnow')}</p>
        <ul className="mt-3 grid gap-2.5 text-[13px] leading-relaxed text-muted">
          {cable ? (
            <>
              <li>{t('setup.iosDone.cable1')}</li>
              <li>{t('setup.iosDone.cable2')}</li>
              <li>{t('setup.iosDone.cable3')}</li>
            </>
          ) : (
            <>
              <li>{t('setup.iosDone.wifi1')}</li>
              <li>{t('setup.iosDone.wifi2')}</li>
              <li>{t('setup.iosDone.wifi3')}</li>
            </>
          )}
        </ul>
      </div>
    </div>
  )
}

/** The FreeFlect logo; Arabic layouts use the Arabic lockup (the mark leads on the right, never mirrored). */
function BrandLockup() {
  const arabic = lang() === 'ar'
  const [light, dark] = arabic ? [lockupAr, lockupArDark] : [lockup, lockupDark]
  return (
    <div className="mb-10">
      <img src={light} alt="FreeFlect" className="h-7 w-auto dark:hidden" />
      <img src={dark} alt="FreeFlect" className="hidden h-7 w-auto dark:block" />
    </div>
  )
}
