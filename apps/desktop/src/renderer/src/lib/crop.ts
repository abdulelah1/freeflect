import { useCallback, useEffect, useState } from 'react'

/** Part of the phone screen to show, as fractions (0..1) of the full frame. */
export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

export const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 }
const KEY = 'mirror.crop'
/** Smallest crop side, as a fraction of the screen. */
export const MIN_SIDE = 0.1

export const isFull = (c: Crop | null) => !c || (c.x <= 0 && c.y <= 0 && c.w >= 1 && c.h >= 1)

/** Normalized point inside the crop → normalized point on the full screen. */
export const uncrop = (c: Crop | null, p: { x: number; y: number }) => (c ? { x: c.x + p.x * c.w, y: c.y + p.y * c.h } : p)

/** Keeps a crop inside the frame and above the minimum size. */
export function clampCrop(c: Crop): Crop {
  const w = Math.min(1, Math.max(MIN_SIDE, c.w))
  const h = Math.min(1, Math.max(MIN_SIDE, c.h))
  return { x: Math.min(1 - w, Math.max(0, c.x)), y: Math.min(1 - h, Math.max(0, c.y)), w, h }
}

function readAll(): Record<string, Crop> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Crop>
  } catch {
    return {}
  }
}

/**
 * The crop for one phone, remembered per orientation: turning the phone
 * switches to that orientation's crop (or none).
 */
export function useCrop(serial: string | null, aspect: number | null) {
  const key = serial && aspect ? `${serial}:${aspect > 1 ? 'landscape' : 'portrait'}` : null
  const [crop, setCropState] = useState<Crop | null>(null)
  useEffect(() => setCropState(key ? (readAll()[key] ?? null) : null), [key])
  const setCrop = useCallback(
    (next: Crop | null) => {
      const value = next && !isFull(next) ? clampCrop(next) : null
      setCropState(value)
      if (!key) return
      const all = readAll()
      if (value) all[key] = value
      else delete all[key]
      try {
        localStorage.setItem(KEY, JSON.stringify(all))
      } catch {
        // Not remembered; still applies now.
      }
    },
    [key]
  )
  return { crop, setCrop }
}
