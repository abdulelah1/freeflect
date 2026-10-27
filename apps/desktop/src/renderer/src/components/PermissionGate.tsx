import { CameraIcon, KeyIcon, MicrophoneIcon, WifiHighIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MediaPermission, PermissionKind } from '../../../shared-ipc'
import { t, useT } from '../i18n'

// Before macOS asks for anything, FreeFlect says what it is about to ask and
// why, and waits for the user to agree. Mounted once per window.

type Request = { kind: PermissionKind; resolve(ok: boolean): void }
let enqueue: ((request: Request) => void) | null = null

/** Open explanations by kind: phones starting together share one. */
const open = new Map<PermissionKind, Promise<boolean>>()

/** Shows the explanation for `kind`; true when the user wants to go ahead. */
export function explainPermission(kind: PermissionKind): Promise<boolean> {
  const shown = open.get(kind)
  if (shown) return shown
  const answer = new Promise<boolean>((resolve) => (enqueue ? enqueue({ kind, resolve }) : resolve(false))).finally(() =>
    open.delete(kind)
  )
  open.set(kind, answer)
  return answer
}

const asking = new Map<MediaPermission, Promise<boolean>>()
/** One macOS prompt per kind, however many phones are waiting for it. */
function requestOnce(kind: MediaPermission): Promise<boolean> {
  const pending = asking.get(kind)
  if (pending) return pending
  const request = window.mirror.requestMediaAccess(kind).finally(() => asking.delete(kind))
  asking.set(kind, request)
  return request
}

/** The user chose not to let macOS ask; the message carries the kind. */
export const declinedPermission = (e: unknown): string | null =>
  /\[permission_declined\] (\w+)/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? null

/** What to show when the user said Not now, or null for other errors. */
export function declinedMessage(e: unknown): string | null {
  const kind = declinedPermission(e)
  return kind ? t(`permission.${kind}.declined`) : null
}

/**
 * Runs `start`. While macOS still has to ask about the camera or microphone,
 * the main process refuses with `[needs_permission]`: explain, ask macOS on
 * approval, and try again.
 */
export async function withPermissions<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await start()
    } catch (e) {
      const kind = /\[needs_permission\] (camera|microphone)/.exec(e instanceof Error ? e.message : String(e))?.[1] as MediaPermission | undefined
      if (!kind || attempt >= 2) throw e
      if (!(await explainPermission(kind))) throw new Error(`[permission_declined] ${kind}`)
      await requestOnce(kind)
    }
  }
}

/** Explains, then asks macOS, for each of `kinds` it hasn't asked about yet. */
export async function askMediaAccess(kinds: MediaPermission[]): Promise<void> {
  for (const kind of kinds) {
    if ((await window.mirror.mediaAccessStatus(kind)) !== 'not-determined') continue
    if (await explainPermission(kind)) await requestOnce(kind)
  }
}

const ICONS: Record<PermissionKind, ReactNode> = {
  camera: <CameraIcon size={28} />,
  microphone: <MicrophoneIcon size={28} />,
  pairing: <WifiHighIcon size={28} />,
  keychain: <KeyIcon size={28} />
}

export function PermissionGate() {
  const t = useT()
  const [queue, setQueue] = useState<Request[]>([])
  const notNowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    enqueue = (request) => setQueue((q) => [...q, request])
    // Explanations the main process needs (the keychain after an update).
    const off = window.mirror.onPermissionExplain((id, kind) => {
      void explainPermission(kind).then((ok) => window.mirror.answerPermission(id, ok))
    })
    return () => {
      enqueue = null
      off()
    }
  }, [])

  const current = queue[0]
  // Neither answer is preselected by Enter: focus starts on Not now.
  useEffect(() => notNowRef.current?.focus(), [current])
  if (!current) return null

  const answer = (ok: boolean) => {
    current.resolve(ok)
    setQueue((q) => q.slice(1))
  }
  const k = current.kind
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[oklch(0.1_0.01_260/0.45)] p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        aria-describedby="permission-body"
        onKeyDown={(e) => e.key === 'Escape' && answer(false)}
        className="w-full max-w-[440px] rounded-[var(--radius-panel)] border border-line bg-surface p-6"
      >
        <span className="text-accent">{ICONS[k]}</span>
        <h2 id="permission-title" className="mt-3 text-lg font-semibold tracking-tight">
          {t(`permission.${k}.title`)}
        </h2>
        <div id="permission-body" className="mt-3 grid gap-3 text-sm leading-relaxed">
          <section>
            <h3 className="font-medium">{t('permission.whyHeading')}</h3>
            <p className="mt-0.5 text-muted">{t(`permission.${k}.why`)}</p>
            <p className="mt-1.5 text-muted">{t(`permission.${k}.scope`)}</p>
          </section>
          <section>
            <h3 className="font-medium">{t('permission.nextHeading')}</h3>
            <p className="mt-0.5 text-muted">{t(`permission.${k}.next`)}</p>
          </section>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={notNowRef}
            type="button"
            onClick={() => answer(false)}
            className="rounded-[var(--radius-control)] px-4 py-2 text-sm font-medium text-muted hover:bg-fg/8 hover:text-fg"
          >
            {t('permission.notNow')}
          </button>
          <button
            type="button"
            onClick={() => answer(true)}
            className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
          >
            {t('permission.continue')}
          </button>
        </div>
      </div>
    </div>
  )
}
