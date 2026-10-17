import { useCallback, useEffect, useState } from 'react'
import type { IosControlState } from '../../../shared-ipc'

/** Developer control (WebDriverAgent) for one iPhone; null serial = not an iPhone. */
export function useIosControl(serial: string | null) {
  const [available, setAvailable] = useState(false)
  const [state, setState] = useState<IosControlState>({ kind: 'off' })

  useEffect(() => {
    void window.mirror.iosControlAvailable().then(setAvailable)
  }, [])

  useEffect(() => {
    if (!serial) return setState({ kind: 'off' })
    let cancelled = false
    void window.mirror.getIosControlState(serial).then((s) => !cancelled && setState(s))
    const off = window.mirror.onIosControlState((from, s) => from === serial && setState(s))
    return () => {
      cancelled = true
      off()
    }
  }, [serial])

  const toggle = useCallback(() => {
    if (!serial) return
    if (state.kind === 'on' || state.kind === 'starting') window.mirror.stopIosControl(serial)
    // Failures arrive as an 'error' state.
    else void window.mirror.startIosControl(serial).catch(() => undefined)
  }, [serial, state.kind])

  return { available, state, on: state.kind === 'on', toggle }
}
