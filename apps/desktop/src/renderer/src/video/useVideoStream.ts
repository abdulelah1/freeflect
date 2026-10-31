import { useCallback, useEffect, useRef, useState } from 'react'
import type { FromWorker, StreamStats, ToWorker } from './protocol'
import type { Crop } from '../lib/crop'
import { isIosSerial } from '../../../shared-ipc'

/** Cuts a crop (fractions of the image) out of a PNG. */
async function cropPng(png: ArrayBuffer, crop: Crop): Promise<ArrayBuffer> {
  const image = await createImageBitmap(new Blob([png], { type: 'image/png' }))
  const x = Math.round(crop.x * image.width)
  const y = Math.round(crop.y * image.height)
  const w = Math.max(1, Math.round(crop.w * image.width))
  const h = Math.max(1, Math.round(crop.h * image.height))
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.drawImage(image, x, y, w, h, 0, 0, w, h)
  image.close()
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
}

export interface GrabbedFrame {
  width: number
  height: number
  rgba: ArrayBuffer
}

/**
 * Mounts a canvas inside `container`, hands it to the decoder worker and
 * forwards every incoming video packet. The canvas is created imperatively
 * because `transferControlToOffscreen` may only be called once per element.
 */
/**
 * With `serial`, only that phone's packets are decoded (several streams can
 * share a window, e.g. the device farm grid).
 */
export function useVideoStream(active: boolean, serial?: string) {
  const container = useRef<HTMLDivElement>(null)
  const [stats, setStats] = useState<StreamStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const captures = useRef(new Map<number, (png: ArrayBuffer | null) => void>())
  const grabs = useRef(new Map<number, (frame: GrabbedFrame | null) => void>())

  useEffect(() => {
    const host = container.current
    if (!active || !host) return

    const canvas = document.createElement('canvas')
    canvas.className = 'block h-full w-full object-contain'
    host.appendChild(canvas)

    const worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })
    const send = (msg: ToWorker, transfer: Transferable[] = []) => worker.postMessage(msg, transfer)
    const offscreen = canvas.transferControlToOffscreen()
    send({ type: 'init', canvas: offscreen }, [offscreen])

    workerRef.current = worker
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data
      if (msg.type === 'stats') setStats(msg.stats)
      else if (msg.type === 'error') setError(msg.message)
      else if (msg.type === 'grab') {
        grabs.current.get(msg.id)?.(msg.frame)
        grabs.current.delete(msg.id)
      } else {
        captures.current.get(msg.id)?.(msg.png)
        captures.current.delete(msg.id)
      }
    }

    const unsubscribe = window.mirror.onVideoPacket((p, from) => {
      if (serial !== undefined && from !== serial) return
      const ownsBuffer = p.data.byteOffset === 0 && p.data.byteLength === p.data.buffer.byteLength
      const data = ownsBuffer ? p.data : p.data.slice()
      send(
        {
          type: 'packet',
          data,
          ptsUs: p.ptsUs,
          keyframe: p.keyframe,
          codec: p.codec ?? null,
          discontinuity: p.discontinuity,
          sentAtMs: p.sentAtMs
        },
        [data.buffer as ArrayBuffer]
      )
    })

    return () => {
      unsubscribe()
      workerRef.current = null
      for (const resolve of captures.current.values()) resolve(null)
      captures.current.clear()
      for (const resolve of grabs.current.values()) resolve(null)
      grabs.current.clear()
      worker.terminate()
      canvas.remove()
      setStats(null)
      setError(null)
    }
  }, [active, serial])

  /**
   * PNG screenshot at the phone's full resolution, or null when nothing is
   * showing. Android phones take it themselves, so a small or low-quality
   * mirror (the device farm's tiles) still gives a sharp screenshot; iPhones
   * stream at full size, so their frame is used.
   */
  const captureFrame = useCallback(
    async (crop?: Crop | null): Promise<ArrayBuffer | null> => {
      if (serial && !isIosSerial(serial)) {
        const full = await window.mirror.phoneScreenshot(serial).catch(() => null)
        if (full) return crop ? cropPng(full, crop) : full
      }
      const worker = workerRef.current
      if (!worker) return null
      const id = Math.random()
      return new Promise((resolve) => {
        captures.current.set(id, resolve)
        worker.postMessage({ type: 'capture', id, crop } satisfies ToWorker)
      })
    },
    [serial]
  )

  /** Current frame scaled to `width` px wide, as RGBA, for GIF capture. */
  const grabFrame = useCallback((width: number, crop?: Crop | null): Promise<GrabbedFrame | null> => {
    const worker = workerRef.current
    if (!worker) return Promise.resolve(null)
    const id = Math.random()
    return new Promise((resolve) => {
      grabs.current.set(id, resolve)
      worker.postMessage({ type: 'grab', id, width, crop } satisfies ToWorker)
    })
  }, [])

  return { container, stats, error, captureFrame, grabFrame }
}
