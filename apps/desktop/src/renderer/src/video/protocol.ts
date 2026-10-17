import type { Crop } from '../lib/crop'
export interface StreamStats {
  fps: number
  /** Native send → frame drawn, in ms (IPC + decode + draw). */
  latencyMs: number
  decodeMs: number
  bitrateMbps: number
  width: number
  height: number
  codec: string | null
  queue: number
  dropped: number
}

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas }
  | {
      type: 'packet'
      data: Uint8Array
      ptsUs: number
      keyframe: boolean
      codec: string | null
      discontinuity: boolean
      sentAtMs: number
    }
  | { type: 'reset' }
  /** PNG of the current frame, cut to `crop` (fractions of the frame) if given. */
  | { type: 'capture'; id: number; crop?: Crop | null }
  /** A downscaled RGBA copy of the current frame (GIF capture). */
  | { type: 'grab'; id: number; width: number; crop?: Crop | null }

export type FromWorker =
  | { type: 'stats'; stats: StreamStats }
  | { type: 'error'; message: string }
  | { type: 'capture'; id: number; png: ArrayBuffer | null }
  | { type: 'grab'; id: number; frame: { width: number; height: number; rgba: ArrayBuffer } | null }
