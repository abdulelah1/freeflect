import { CursorClickIcon, HouseIcon, PlugIcon, WarningIcon } from '@phosphor-icons/react'
import type { IosControlState } from '../../../shared-ipc'
import { useT } from '../i18n'

interface Props {
  available: boolean
  state: IosControlState
  companion: boolean
  onToggle(): void
  onHome(): void
}

/** Under an iPhone: view-only note, or the developer control switch and its status. */
export function IosControlBar({ available, state, companion, onToggle, onHome }: Props) {
  const t = useT()
  // Over Wi-Fi there is no switch: control goes through the cable.
  if (companion) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-1 text-center text-xs text-muted">
        <p className="inline-flex items-center gap-1.5">
          <PlugIcon size={13} />
          {t('iosControl.needsCable')}
        </p>
        <p>{t('iosControl.wifiViewOnly')}</p>
      </div>
    )
  }
  const viewOnly = t('iosControl.viewOnly')
  if (!available) {
    return (
      <p className="shrink-0 text-center text-xs text-muted">
        {viewOnly} {t('iosControl.needsWda')}
      </p>
    )
  }
  const on = state.kind === 'on'
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 text-xs" role="group" aria-label={t('iosControl.group')}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={onToggle}
        className={`no-drag inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border px-3 py-1.5 font-medium active:scale-[0.98] ${
          on ? 'border-accent bg-accent text-accent-fg hover:opacity-90' : 'border-line bg-surface hover:bg-fg/5'
        }`}
      >
        <CursorClickIcon size={14} weight={on ? 'fill' : 'regular'} />
        {on ? t('iosControl.on') : state.kind === 'starting' ? t('common.cancel') : t('iosControl.switch')}
      </button>
      {on && (
        <button
          type="button"
          onClick={onHome}
          aria-label={t('nav.home')}
          title={t('nav.home')}
          className="no-drag grid size-8 place-items-center rounded-[var(--radius-control)] border border-line bg-surface text-muted hover:bg-fg/5 hover:text-fg active:scale-[0.96]"
        >
          <HouseIcon size={14} />
        </button>
      )}
      <span className="text-muted" aria-live="polite">
        {state.kind === 'starting' && t('iosControl.starting')}
        {on && t('iosControl.active')}
        {state.kind === 'off' && viewOnly}
        {state.kind === 'error' && (
          <span className="inline-flex items-center gap-1 text-err">
            <WarningIcon size={13} />
            {state.message}
          </span>
        )}
      </span>
    </div>
  )
}
