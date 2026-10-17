import { useEffect, useRef } from 'react'

/** How far ahead of "now" audio is scheduled; absorbs network jitter. */
const TARGET_LATENCY_S = 0.08
/** More queued than this means we fell behind; drop and resync. */
const MAX_QUEUED_S = 0.3
const AAC_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000]

/**
 * Plays the phone's sound: AAC packets are decoded with WebCodecs and
 * scheduled back to back on a Web Audio clock with a small jitter buffer.
 */
export function useAudioPlayback(active: boolean, muted = false, serial?: string) {
  const gainRef = useRef<GainNode | null>(null)

  useEffect(() => {
    if (!active) return
    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    gainRef.current = gain
    let decoder: AudioDecoder | null = null
    let nextTime = 0

    const play = (data: AudioData) => {
      const buffer = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate)
      for (let ch = 0; ch < data.numberOfChannels; ch++) {
        const plane = new Float32Array(data.numberOfFrames)
        data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' })
        buffer.copyToChannel(plane, ch)
      }
      data.close()
      const now = ctx.currentTime
      // Underrun (late) or backlog (too far ahead): restart at the target latency.
      if (nextTime < now + 0.01 || nextTime > now + MAX_QUEUED_S) nextTime = now + TARGET_LATENCY_S
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      source.start(nextTime)
      nextTime += buffer.duration
    }

    const configure = (description: Uint8Array) => {
      // AudioSpecificConfig: 5 bits object type, 4 bits rate index, 4 bits channels.
      // Android sends 48 kHz stereo; iPhones send their own rate (often 44.1 kHz).
      const rateIndex = ((description[0]! & 0x07) << 1) | (description[1]! >> 7)
      const sampleRate = AAC_RATES[rateIndex] ?? 48_000
      const numberOfChannels = (description[1]! >> 3) & 0x0f || 2
      if (decoder && decoder.state !== 'closed') decoder.close()
      decoder = new AudioDecoder({
        output: play,
        error: () => {
          decoder = null
        }
      })
      decoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels, description })
    }

    const off = window.mirror.onAudioPacket((p, from) => {
      if (serial !== undefined && from !== serial) return
      if (p.config) return configure(p.data)
      if (decoder?.state !== 'configured') return
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.ptsUs, data: p.data }))
    })

    return () => {
      off()
      if (decoder && decoder.state !== 'closed') decoder.close()
      gainRef.current = null
      void ctx.close()
    }
  }, [active, serial])

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : 1
  }, [muted, active])
}
