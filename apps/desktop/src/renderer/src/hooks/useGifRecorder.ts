import { useCallback, useEffect, useRef, useState } from 'react'
import type { GifWorkerIn, GifWorkerOut } from '../video/gif.worker'
import type { GrabbedFrame } from '../video/useVideoStream'

const FPS = 10
const WIDTH = 360
const MAX_SECONDS = 30

/**
 * Captures the mirrored screen as an animated GIF: 10 fps, 360 px wide, up to
 * 30 s, encoded in a worker and saved to the recordings folder (Settings).
 */
export function useGifRecorder(
  grabFrame: (width: number) => Promise<GrabbedFrame | null>,
  deviceName: string,
  onSaved: (path: string) => void,
  onError: (message: string) => void
) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'encoding'>('idle')
  const [frames, setFrames] = useState(0)
  const worker = useRef<Worker | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const finish = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    const w = worker.current
    if (!w) return
    setPhase('encoding')
    w.onmessage = async (e: MessageEvent<GifWorkerOut>) => {
      w.terminate()
      worker.current = null
      try {
        if (e.data.frames === 0) throw new Error('No frames were captured')
        onSaved(await window.mirror.saveGif(e.data.gif, deviceName))
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setPhase('idle')
      }
    }
    w.postMessage({ type: 'finish' } satisfies GifWorkerIn)
  }, [deviceName, onSaved, onError])

  const start = useCallback(() => {
    const w = new Worker(new URL('../video/gif.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    setFrames(0)
    setPhase('recording')
    let count = 0
    let busy = false
    timer.current = setInterval(async () => {
      if (busy) return // Skip a tick rather than queue up behind a slow grab.
      busy = true
      const frame = await grabFrame(WIDTH)
      busy = false
      if (!frame || worker.current !== w) return
      w.postMessage(
        { type: 'frame', width: frame.width, height: frame.height, rgba: frame.rgba, delayMs: 1000 / FPS } satisfies GifWorkerIn,
        [frame.rgba]
      )
      setFrames(++count)
      if (count >= FPS * MAX_SECONDS) finish()
    }, 1000 / FPS)
  }, [grabFrame, finish])

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current)
      worker.current?.terminate()
    },
    []
  )

  const toggle = useCallback(() => {
    if (phase === 'idle') start()
    else if (phase === 'recording') finish()
  }, [phase, start, finish])

  const secs = Math.floor(frames / FPS)
  return { phase, elapsed: `0:${String(secs).padStart(2, '0')}`, toggle }
}
