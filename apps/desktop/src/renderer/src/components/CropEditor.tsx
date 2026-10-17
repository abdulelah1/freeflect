import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clampCrop, FULL, MIN_SIDE, type Crop } from '../lib/crop'
import { useT } from '../i18n'

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; from: Crop }
  | { kind: 'corner'; corner: 'nw' | 'ne' | 'sw' | 'se'; from: Crop }
  | { kind: 'draw'; anchor: { x: number; y: number } }

interface Props {
  initial: Crop | null
  onApply(crop: Crop | null): void
  onCancel(): void
}

/**
 * Drawn over the full phone screen: drag inside the box to move it, drag a
 * corner to resize, or drag outside it to draw a new one.
 */
export function CropEditor({ initial, onApply, onCancel }: Props) {
  const [rect, setRect] = useState<Crop>(initial ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
  const area = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onApply(rect)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rect, onApply, onCancel])

  const point = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }

  const begin = (e: ReactPointerEvent, d: Drag) => {
    e.stopPropagation()
    e.preventDefault()
    area.current?.setPointerCapture(e.pointerId)
    drag.current = d
  }

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = point(e)
    if (d.kind === 'move') {
      setRect(clampCrop({ ...d.from, x: d.from.x + p.x - d.start.x, y: d.from.y + p.y - d.start.y }))
    } else if (d.kind === 'draw') {
      const x = Math.min(d.anchor.x, p.x)
      const y = Math.min(d.anchor.y, p.y)
      setRect(clampCrop({ x, y, w: Math.max(MIN_SIDE, Math.abs(p.x - d.anchor.x)), h: Math.max(MIN_SIDE, Math.abs(p.y - d.anchor.y)) }))
    } else {
      const { from, corner } = d
      // The opposite corner stays put.
      const fixedX = corner.endsWith('w') ? from.x + from.w : from.x
      const fixedY = corner.startsWith('n') ? from.y + from.h : from.y
      const x = corner.endsWith('w') ? Math.min(p.x, fixedX - MIN_SIDE) : fixedX
      const y = corner.startsWith('n') ? Math.min(p.y, fixedY - MIN_SIDE) : fixedY
      const w = corner.endsWith('w') ? fixedX - x : Math.max(MIN_SIDE, p.x - fixedX)
      const h = corner.startsWith('n') ? fixedY - y : Math.max(MIN_SIDE, p.y - fixedY)
      setRect(clampCrop({ x, y, w, h }))
    }
  }

  const pct = (v: number) => `${v * 100}%`
  // The buttons go where they cover less of the box.
  const barOnTop = rect.y > 1 - (rect.y + rect.h)
  return (
    <div className="absolute inset-0 z-10 select-none" role="group" aria-label={t('crop.label')}>
      <div
        ref={area}
        className="absolute inset-0 cursor-crosshair touch-none"
        onPointerDown={(e) => begin(e, { kind: 'draw', anchor: point(e) })}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
      >
        <div
          className="absolute cursor-move border-2 border-accent"
          style={{
            left: pct(rect.x),
            top: pct(rect.y),
            width: pct(rect.w),
            height: pct(rect.h),
            // Dims everything outside the box (the screen clips the shadow).
            boxShadow: '0 0 0 9999px oklch(0.15 0.01 260 / 0.62)'
          }}
          onPointerDown={(e) => begin(e, { kind: 'move', start: point(e), from: rect })}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span
              key={corner}
              onPointerDown={(e) => begin(e, { kind: 'corner', corner, from: rect })}
              className={`absolute size-3.5 rounded-[3px] border-2 border-white bg-accent ${
                corner === 'nw'
                  ? '-left-2 -top-2 cursor-nwse-resize'
                  : corner === 'ne'
                    ? '-right-2 -top-2 cursor-nesw-resize'
                    : corner === 'sw'
                      ? '-bottom-2 -left-2 cursor-nesw-resize'
                      : '-bottom-2 -right-2 cursor-nwse-resize'
              }`}
            />
          ))}
        </div>
      </div>
      <div
        className={`absolute inset-x-3 flex flex-col items-center gap-2 ${barOnTop ? 'top-3' : 'bottom-3'}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <p className="rounded-[var(--radius-control)] bg-[oklch(0.15_0.01_260/0.8)] px-2.5 py-1 text-center text-[11px] leading-snug text-white">
          {t('crop.note')}
        </p>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setRect(FULL)} className={overlayButton}>
            {t('crop.whole')}
          </button>
          <button type="button" onClick={onCancel} className={overlayButton}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onApply(rect)}
            className="rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 active:scale-[0.98]"
          >
            {t('crop.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayButton =
  'rounded-[var(--radius-control)] bg-[oklch(0.15_0.01_260/0.8)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[oklch(0.25_0.01_260/0.9)] active:scale-[0.98]'
