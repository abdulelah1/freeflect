import { siAndroid, siApple } from 'simple-icons'

const ICONS = { apple: siApple, android: siAndroid }

/**
 * Official Apple and Android marks (Simple Icons path data). Apple's mark is
 * single-color and follows the text color; Android's uses its brand green
 * unless `mono` is set.
 */
export function BrandLogo({ brand, size = 20, mono = false, className }: { brand: 'apple' | 'android'; size?: number; mono?: boolean; className?: string }) {
  const icon = ICONS[brand]
  const fill = brand === 'android' && !mono ? `#${icon.hex}` : 'currentColor'
  return (
    <svg role="img" aria-label={icon.title} viewBox="0 0 24 24" width={size} height={size} fill={fill} className={className}>
      <path d={icon.path} />
    </svg>
  )
}
