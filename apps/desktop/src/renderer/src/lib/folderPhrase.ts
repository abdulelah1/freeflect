import { t } from '../i18n'

/** "In Desktop, FreeFlect folder." for a file saved in ~/Desktop/FreeFlect. */
export function folderPhrase(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  const folder = parts.at(-2)
  const parent = parts.at(-3)
  if (!folder) return ''
  return parent ? t('toast.inFolder', { parent, folder }) : t('toast.inOneFolder', { folder })
}
