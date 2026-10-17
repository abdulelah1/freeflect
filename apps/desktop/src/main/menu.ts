import { Menu, type BrowserWindow, type WebContents } from 'electron'
import type { MenuCommand } from '../shared-ipc'
import { t } from './i18n'

/** App menu: standard roles plus device commands with shortcuts. */
export function installMenu(getContents: () => WebContents | undefined, mainWindow: () => BrowserWindow | null): void {
  const command = (name: MenuCommand) => () => getContents()?.send('menu:command', name)
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              role: 'appMenu' as const,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { label: t('menu.settingsEllipsis'), accelerator: 'CmdOrCtrl+,', click: command('settings') },
                { label: t('menu.checkUpdates'), click: command('check-updates') },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const }
              ]
            }
          ]
        : []),
      isMac
        ? { role: 'fileMenu' as const, label: t('menu.file') }
        : {
            label: t('menu.file'),
            submenu: [
              { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: command('settings') },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          },
      { role: 'editMenu', label: t('menu.edit') },
      {
        label: t('menu.device'),
        submenu: [
          { label: t('menu.saveScreenshot'), accelerator: 'CmdOrCtrl+Shift+S', click: command('screenshot') },
          { label: t('menu.copyScreenshot'), accelerator: 'CmdOrCtrl+Shift+C', click: command('copy-screenshot') },
          { label: t('menu.toggleRecording'), accelerator: 'CmdOrCtrl+Shift+R', click: command('toggle-recording') },
          { label: t('menu.deviceWindow'), accelerator: 'CmdOrCtrl+Shift+D', click: command('device-window') }
        ]
      },
      {
        label: t('menu.view'),
        submenu: [
          { role: 'togglefullscreen' },
          { label: t('menu.streamStats'), accelerator: 'CmdOrCtrl+Alt+S', click: command('toggle-stats') },
          { label: t('menu.shortcuts'), accelerator: 'CmdOrCtrl+/', click: command('shortcuts') },
          {
            label: t('menu.keepOnTop'),
            type: 'checkbox',
            click: (item) => mainWindow()?.setAlwaysOnTop(item.checked, 'floating')
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' }
        ]
      },
      { role: 'windowMenu', label: t('menu.window') },
      {
        role: 'help',
        label: t('menu.help'),
        submenu: [
          { label: t('menu.setup'), click: command('setup') },
          { label: t('doctor.title'), click: command('doctor') }
        ]
      }
    ])
  )
}
