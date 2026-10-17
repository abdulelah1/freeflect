import { useCallback, useEffect, useState } from 'react'

/** A phone's recording state (owned by the main process) plus an elapsed label. */
export function useRecording(serial: string | null, deviceName: string) {
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setSince(null)
    if (!serial) return
    void window.mirror.getRecordingState(serial).then(setSince)
    return window.mirror.onRecordingState((s, value) => s === serial && setSince(value))
  }, [serial])

  useEffect(() => {
    if (since === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])

  const toggle = useCallback(() => {
    if (!serial) return
    if (since === null) void window.mirror.startRecording(serial, deviceName)
    else window.mirror.stopRecording(serial)
  }, [serial, since, deviceName])

  const secs = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000))
  const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return { recording: since !== null, elapsed, toggle }
}
