// Which USB iPhone a mirrored screen belongs to. macOS identifies an
// iPhone's screen by a capture id unrelated to its UDID, but names the
// capture device after the phone, so the two are matched by name.

import { isCompanionSerial } from '../shared-ipc'
import { iosCaptureName } from './mirror'
import { native } from './native'
import { t } from './i18n'

/** Curly and straight apostrophes differ between the two sources. */
const normalize = (name: string) => name.replace(/[‘’]/g, "'").trim().toLowerCase()

/** UDID of the USB iPhone shown as `serial`; `purpose` (browse, copy, control) completes the error messages. */
export async function udidForSerial(serial: string, purpose: 'browse' | 'copy' | 'control'): Promise<string> {
  const why = t(`iosDevices.purpose.${purpose}`)
  if (isCompanionSerial(serial)) {
    throw new Error(`[needs_cable] ${t('iosDevices.needsCable', { purpose: why })}`)
  }
  const phones = await native.listIosUsbDevicesNamed()
  if (phones.length === 0) throw new Error(`[needs_cable] ${t('iosDevices.needsCableUnlock', { purpose: why })}`)
  if (phones.length === 1) return phones[0]!.udid
  const name = iosCaptureName(serial)
  const matches = name ? phones.filter((p) => p.name && normalize(p.name) === normalize(name)) : []
  if (matches.length === 1) return matches[0]!.udid
  throw new Error(
    matches.length > 1
      ? `[same_name] ${t('iosDevices.sameName', { name: name ?? '' })}`
      : `[not_found] ${t('iosDevices.notFound')}`
  )
}
