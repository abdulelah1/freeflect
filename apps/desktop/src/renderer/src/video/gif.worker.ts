/// <reference lib="webworker" />
// Encodes captured frames into an animated GIF off the main thread.

import { GIFEncoder, applyPalette, quantize } from 'gifenc'

export type GifWorkerIn =
  | { type: 'frame'; width: number; height: number; rgba: ArrayBuffer; delayMs: number }
  | { type: 'finish' }
export type GifWorkerOut = { type: 'done'; gif: ArrayBuffer; frames: number }

const encoder = GIFEncoder()
let frames = 0

self.onmessage = (e: MessageEvent<GifWorkerIn>) => {
  const msg = e.data
  if (msg.type === 'frame') {
    const rgba = new Uint8ClampedArray(msg.rgba)
    // A palette per frame keeps colors right as the screen changes.
    const palette = quantize(rgba, 256)
    encoder.writeFrame(applyPalette(rgba, palette), msg.width, msg.height, { palette, delay: msg.delayMs })
    frames++
  } else {
    encoder.finish()
    const bytes = encoder.bytes()
    const gif = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    self.postMessage({ type: 'done', gif, frames } satisfies GifWorkerOut, [gif])
  }
}
