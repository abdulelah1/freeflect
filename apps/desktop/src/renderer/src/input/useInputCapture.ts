import { useEffect, useRef, type RefObject } from 'react'
import { Modifier, type InputEvent, type KeyName } from '../../../shared-ipc'
import { uncrop, type Crop } from '../lib/crop'
import { matchShortcut, type ShortcutAction, type Shortcuts } from './shortcuts'

const isMac = navigator.platform.toLowerCase().includes('mac')

function modifiersOf(e: KeyboardEvent): number {
  return (
    (e.shiftKey ? Modifier.Shift : 0) |
    (e.ctrlKey ? Modifier.Ctrl : 0) |
    (e.altKey ? Modifier.Alt : 0) |
    (e.metaKey ? Modifier.Meta : 0)
  )
}

/**
 * Turns pointer, wheel and keyboard events on `ref` into normalized device
 * input. The element must match the video's aspect ratio so its bounds map
 * 1:1 onto the phone screen (or onto `crop`, the part of it being shown).
 */
export function useInputCapture(
  ref: RefObject<HTMLElement | null>,
  /** One phone, or several to send the same input to all (device farm). */
  serial: string | string[] | null,
  shortcuts?: Shortcuts,
  onShortcut?: (action: ShortcutAction) => void,
  crop?: Crop | null
) {
  // Read through a ref so rebinding doesn't re-attach every listener.
  const shortcutRef = useRef({ shortcuts, onShortcut })
  shortcutRef.current = { shortcuts, onShortcut }
  const cropRef = useRef(crop)
  cropRef.current = crop
  useEffect(() => {
    const el = ref.current
    if (!el || !serial || serial.length === 0) return
    const targets = Array.isArray(serial) ? serial : [serial]
    const send = (event: InputEvent) => targets.forEach((s) => window.mirror.sendInput(s, event))

    const position = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      return uncrop(cropRef.current ?? null, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
    }
    const pointerId = (e: PointerEvent) => (e.pointerType === 'mouse' ? 0 : e.pointerId)
    const pressure = (e: PointerEvent) => (e.pointerType === 'mouse' ? 1 : e.pressure || 1)
    const tapKey = (key: KeyName) => {
      send({ type: 'key', key, down: true, modifiers: 0 })
      send({ type: 'key', key, down: false, modifiers: 0 })
    }

    const onPointerDown = (e: PointerEvent) => {
      el.focus()
      // Right click acts as Back, like a mouse on Android.
      if (e.button === 2) return tapKey('back')
      if (e.button !== 0) return
      el.setPointerCapture(e.pointerId)
      send({ type: 'pointer', action: 'down', ...position(e), pointer_id: pointerId(e), pressure: pressure(e) })
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!el.hasPointerCapture(e.pointerId)) return
      send({ type: 'pointer', action: 'move', ...position(e), pointer_id: pointerId(e), pressure: pressure(e) })
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!el.hasPointerCapture(e.pointerId)) return
      el.releasePointerCapture(e.pointerId)
      send({ type: 'pointer', action: 'up', ...position(e), pointer_id: pointerId(e), pressure: 0 })
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // One mouse-wheel notch is ~100px of delta and one Android scroll unit.
      send({ type: 'scroll', ...position(e), dx: -e.deltaX / 100, dy: -e.deltaY / 100 })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      // Phone shortcuts win over forwarding; their key-up is swallowed too.
      const { shortcuts: bound, onShortcut: run } = shortcutRef.current
      const action = bound && matchShortcut(bound, e)
      if (action && run) {
        e.preventDefault()
        if (e.type === 'keydown' && !e.repeat) run(action)
        return
      }
      const command = isMac ? e.metaKey : e.ctrlKey
      // Cmd/Ctrl+Shift combos are app shortcuts (screenshot); let the menu have them.
      if (command && e.shiftKey) return
      const down = e.type === 'keydown'
      // Paste the desktop clipboard into the phone.
      if (command && e.code === 'KeyV') {
        e.preventDefault()
        if (down) targets.forEach((s) => window.mirror.pasteToPhone(s))
        return
      }
      if (isMac && e.metaKey) {
        // Cmd+C/X/A/Z act on the phone as Ctrl shortcuts; other Cmd combos
        // (Cmd+Q, Cmd+Tab) stay with macOS.
        if (!['KeyC', 'KeyX', 'KeyA', 'KeyZ'].includes(e.code)) return
        e.preventDefault()
        send({ type: 'key', key: { code: e.code }, down, modifiers: Modifier.Ctrl })
        return
      }
      e.preventDefault()
      // Printable characters go as text so the desktop keyboard layout wins.
      const printable = e.key.length === 1 && !e.ctrlKey && (isMac || !e.altKey)
      if (printable) {
        if (down) send({ type: 'text', text: e.key })
        return
      }
      send({ type: 'key', key: { code: e.code }, down, modifiers: modifiersOf(e) })
    }
    const onComposition = (e: CompositionEvent) => {
      if (e.data) send({ type: 'text', text: e.data })
    }
    const onContextMenu = (e: Event) => e.preventDefault()

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('keydown', onKey)
    el.addEventListener('keyup', onKey)
    el.addEventListener('compositionend', onComposition)
    el.addEventListener('contextmenu', onContextMenu)
    el.focus()
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('keyup', onKey)
      el.removeEventListener('compositionend', onComposition)
      el.removeEventListener('contextmenu', onContextMenu)
    }
  }, [ref, Array.isArray(serial) ? serial.join() : serial])
}
