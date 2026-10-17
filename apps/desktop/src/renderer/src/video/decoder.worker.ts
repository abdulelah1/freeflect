/// <reference lib="webworker" />
// Decodes Annex-B H.264 access units with WebCodecs and paints them onto an
// OffscreenCanvas, off the main thread. Reports stats twice a second.

import type { FromWorker, StreamStats, ToWorker } from './protocol'
import type { Crop } from '../lib/crop'

const STATS_INTERVAL_MS = 500

let ctx: OffscreenCanvasRenderingContext2D | null = null
let decoder: VideoDecoder | null = null
let configuredCodec: string | null = null
let needKeyframe = true

const pending = new Map<number, { decodeStart: number; sentAtMs: number }>()
let window_ = freshWindow()

function freshWindow() {
  return { start: performance.now(), frames: 0, bytes: 0, decodeMs: 0, latencyMs: 0, dropped: 0 }
}

const post = (msg: FromWorker) => self.postMessage(msg)

function createDecoder(): VideoDecoder {
  return new VideoDecoder({
    output(frame) {
      const canvas = ctx?.canvas
      if (ctx && canvas) {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth
          canvas.height = frame.displayHeight
        }
        ctx.drawImage(frame, 0, 0)
      }
      const p = pending.get(frame.timestamp)
      if (p) {
        pending.delete(frame.timestamp)
        window_.decodeMs += performance.now() - p.decodeStart
        window_.latencyMs += Date.now() - p.sentAtMs
      }
      window_.frames++
      frame.close()
    },
    error(e) {
      post({ type: 'error', message: e.message })
      // The decoder is closed after an error; rebuild on the next keyframe.
      decoder = null
      configuredCodec = null
      needKeyframe = true
      pending.clear()
    }
  })
}

function resetDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close()
  decoder = null
  configuredCodec = null
  needKeyframe = true
  pending.clear()
}

function handlePacket(msg: Extract<ToWorker, { type: 'packet' }>) {
  // New encoder session (rotation): dimensions changed, start a fresh decoder.
  if (msg.discontinuity) resetDecoder()
  if (msg.codec && msg.codec !== configuredCodec) {
    decoder ??= createDecoder()
    decoder.configure({
      codec: msg.codec,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware'
    })
    configuredCodec = msg.codec
    needKeyframe = true
  }
  if (!decoder || !configuredCodec || (needKeyframe && !msg.keyframe)) {
    window_.dropped++
    return
  }
  needKeyframe = false
  pending.set(msg.ptsUs, { decodeStart: performance.now(), sentAtMs: msg.sentAtMs })
  decoder.decode(
    new EncodedVideoChunk({
      type: msg.keyframe ? 'key' : 'delta',
      timestamp: msg.ptsUs,
      data: msg.data
    })
  )
  window_.bytes += msg.data.byteLength
}

setInterval(() => {
  const elapsed = (performance.now() - window_.start) / 1000
  const canvas = ctx?.canvas
  const n = Math.max(window_.frames, 1)
  const stats: StreamStats = {
    fps: window_.frames / elapsed,
    latencyMs: window_.latencyMs / n,
    decodeMs: window_.decodeMs / n,
    bitrateMbps: (window_.bytes * 8) / elapsed / 1e6,
    width: canvas?.width ?? 0,
    height: canvas?.height ?? 0,
    codec: configuredCodec,
    queue: decoder?.decodeQueueSize ?? 0,
    dropped: window_.dropped
  }
  if (window_.frames > 0 || window_.dropped > 0) post({ type: 'stats', stats })
  window_ = freshWindow()
}, STATS_INTERVAL_MS)

/** Pixel rectangle of a crop (the whole frame without one). */
function region(canvas: OffscreenCanvas, crop: Crop | null | undefined) {
  if (!crop) return { x: 0, y: 0, w: canvas.width, h: canvas.height }
  const x = Math.round(crop.x * canvas.width)
  const y = Math.round(crop.y * canvas.height)
  return { x, y, w: Math.max(1, Math.round(crop.w * canvas.width)), h: Math.max(1, Math.round(crop.h * canvas.height)) }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  switch (msg.type) {
    case 'init':
      ctx = msg.canvas.getContext('2d', { alpha: false, desynchronized: true })
      break
    case 'packet':
      handlePacket(msg)
      break
    case 'reset':
      resetDecoder()
      break
    case 'grab': {
      const canvas = ctx?.canvas
      if (!canvas || canvas.width === 0) {
        post({ type: 'grab', id: msg.id, frame: null })
        break
      }
      const r = region(canvas, msg.crop)
      const width = Math.min(msg.width, r.w)
      const height = Math.round((r.h * width) / r.w)
      const small = new OffscreenCanvas(width, height)
      const sctx = small.getContext('2d', { willReadFrequently: true })!
      sctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, width, height)
      const rgba = sctx.getImageData(0, 0, width, height).data.buffer as ArrayBuffer
      self.postMessage({ type: 'grab', id: msg.id, frame: { width, height, rgba } } satisfies FromWorker, [rgba])
      break
    }
    case 'capture': {
      // The canvas holds the last decoded frame at the stream's native size.
      const canvas = ctx?.canvas
      if (!canvas || canvas.width === 0) {
        post({ type: 'capture', id: msg.id, png: null })
        break
      }
      let source: OffscreenCanvas = canvas
      if (msg.crop) {
        const r = region(canvas, msg.crop)
        source = new OffscreenCanvas(r.w, r.h)
        source.getContext('2d')!.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
      }
      void source.convertToBlob({ type: 'image/png' }).then(async (blob) => {
        const png = await blob.arrayBuffer()
        self.postMessage({ type: 'capture', id: msg.id, png } satisfies FromWorker, [png])
      })
      break
    }
  }
}
