// Per-brand Android setup instructions. Paths follow each vendor's current
// Settings app (One UI, Pixel, HyperOS/MIUI, OxygenOS, ColorOS/realme UI,
// EMUI/MagicOS, Motorola). Menus vary slightly between versions, so every
// guide also says to search Settings when an item is not where we say.
// Menu names and texts are translation keys ("phoneMenu.*", "brands.*"):
// the phone shows its menus in its own language.

export type BrandId = 'samsung' | 'pixel' | 'xiaomi' | 'oneplus' | 'oppo' | 'huawei' | 'motorola' | 'other'

export interface BrandGuide {
  id: BrandId
  /** Brand names are proper nouns; only "Another brand" is a translation key. */
  name: string
  /** Settings path (phoneMenu keys) to the item that unlocks Developer options. */
  buildNumberPath: string[]
  /** What to tap seven times (phoneMenu key). */
  tapTarget: string
  developerOptionsPath: string[]
  /** Extra switches this brand needs for full control (brands.* keys). */
  extraSwitches?: { name: string; why: string }[]
  /** Brands whose USB connection must be set to file transfer for adb. */
  needsFileTransferMode?: boolean
}

export const BRANDS: BrandGuide[] = [
  {
    id: 'samsung',
    name: 'Samsung',
    buildNumberPath: ['settings', 'aboutPhone', 'softwareInfo'],
    tapTarget: 'buildNumber',
    developerOptionsPath: ['settings', 'developerOptions']
  },
  {
    id: 'pixel',
    name: 'Google Pixel',
    buildNumberPath: ['settings', 'aboutPhone'],
    tapTarget: 'buildNumber',
    developerOptionsPath: ['settings', 'system', 'developerOptions']
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi, Redmi, POCO',
    buildNumberPath: ['settings', 'aboutPhone'],
    tapTarget: 'osVersion',
    developerOptionsPath: ['settings', 'additionalSettings', 'developerOptions'],
    extraSwitches: [
      {
        name: 'brands.xiaomiSecurity',
        why: 'brands.xiaomiSecurityWhy'
      },
      { name: 'brands.installViaUsb', why: 'brands.installViaUsbWhy' }
    ]
  },
  {
    id: 'oneplus',
    name: 'OnePlus',
    buildNumberPath: ['settings', 'aboutDevice', 'version'],
    tapTarget: 'buildNumber',
    developerOptionsPath: ['settings', 'additionalSettings', 'developerOptions'],
    extraSwitches: [{ name: 'brands.permissionMonitoring', why: 'brands.permissionMonitoringWhy' }]
  },
  {
    id: 'oppo',
    name: 'OPPO, realme',
    buildNumberPath: ['settings', 'aboutDevice', 'version'],
    tapTarget: 'buildNumber',
    developerOptionsPath: ['settings', 'additionalSettings', 'developerOptions'],
    extraSwitches: [{ name: 'brands.permissionMonitoring', why: 'brands.permissionMonitoringWhy' }]
  },
  {
    id: 'huawei',
    name: 'Huawei, Honor',
    buildNumberPath: ['settings', 'aboutPhone'],
    tapTarget: 'buildNumber',
    developerOptionsPath: ['settings', 'systemUpdates', 'developerOptions'],
    extraSwitches: [{ name: 'brands.chargeOnly', why: 'brands.chargeOnlyWhy' }],
    needsFileTransferMode: true
  },
  {
    id: 'motorola',
    name: 'Motorola',
    buildNumberPath: ['settings', 'aboutPhone'],
    tapTarget: 'buildNumber',
    developerOptionsPath: ['settings', 'system', 'developerOptions']
  },
  {
    id: 'other',
    name: 'brands.other',
    buildNumberPath: ['settings', 'aboutPhone'],
    tapTarget: 'buildNumber',
    developerOptionsPath: ['settings', 'system', 'developerOptions']
  }
]

export const brandById = (id: BrandId | null) => BRANDS.find((b) => b.id === id) ?? BRANDS[BRANDS.length - 1]!

/** Maps `ro.product.manufacturer` to a guide, for phones already connected. */
export function brandFromManufacturer(manufacturer: string): BrandId {
  const m = manufacturer.toLowerCase()
  if (m.includes('samsung')) return 'samsung'
  if (m === 'google') return 'pixel'
  if (['xiaomi', 'redmi', 'poco'].includes(m)) return 'xiaomi'
  if (m.includes('oneplus')) return 'oneplus'
  if (m.includes('oppo') || m.includes('realme')) return 'oppo'
  if (m.includes('huawei') || m.includes('honor')) return 'huawei'
  if (m.includes('motorola')) return 'motorola'
  return 'other'
}
