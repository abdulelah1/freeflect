// Headless-ish smoke run for the decode spike and CI:
//   MIRROR_SMOKE=/path/out.png [MIRROR_SMOKE_TARGET=android] electron .
// Selects the test stream (or the first Android device), plays it, then
// saves a screenshot and the HUD numbers and quits. Exit code 1 if no frames
// were decoded.

import { app, BrowserWindow, clipboard } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLAY_MS = Number(process.env.MIRROR_SMOKE_MS ?? 6000)

const clickByText = (text: string) => `
  [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))?.click()
`

export function runSmoke(win: BrowserWindow, outPath: string, cleanup: () => Promise<void>): void {
  // Electron's default handler shows a modal dialog, which hangs unattended runs.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (e: unknown) => {
      console.error(`[smoke] ${event}: ${e instanceof Error ? e.stack : String(e)}`)
      app.exit(3)
    })
  }
  setTimeout(() => {
    console.error('[smoke] timed out')
    app.exit(2)
  }, 60_000 + PLAY_MS)
  const wc = win.webContents
  wc.once('did-finish-load', () => void steps().catch((e) => {
    console.error(`[smoke] failed: ${e instanceof Error ? e.message : String(e)}`)
    app.exit(1)
  }))
  const steps = async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await wait(500)
    if (process.env.MIRROR_SMOKE_TARGET === 'android') {
      await wc.executeJavaScript(`window.__audioPackets = 0; window.mirror.onAudioPacket(() => window.__audioPackets++); 0`)
      // Device list polls every 2 s; selecting a ready device auto-starts.
      await wait(2500)
      await wc.executeJavaScript(`document.querySelector('nav[aria-label="Devices"] li button')?.click()`)
      if (process.env.MIRROR_SMOKE_RECORD) {
        await wait(2500)
        await wc.executeJavaScript(`document.querySelector('button[title^="Record the screen"]')?.click()`)
        console.log('[smoke] recording started')
      }
      // Exercise the control path with a harmless key: open Recents.
      await wait(PLAY_MS / 2)
      await wc.executeJavaScript(`document.querySelector('[aria-label="Recent apps"]')?.click()`)
      await wait(800)
      await wc.executeJavaScript(`document.querySelector('[aria-label="Save screenshot"]')?.click()`)
      if (process.env.MIRROR_SMOKE_PUSH) {
        await wc.executeJavaScript(`(async () => {
          const [d] = (await window.mirror.listAndroidDevices()).filter(d => d.state === 'device')
          window.mirror.sendFiles(d.serial, [${JSON.stringify(process.env.MIRROR_SMOKE_PUSH)}])
        })()`)
      }
    } else {
      await wc.executeJavaScript(clickByText('Test stream'))
      await wait(200)
      await wc.executeJavaScript(clickByText('Start'))
    }
    await wait(PLAY_MS)
    if (process.env.MIRROR_SMOKE_RECORD) {
      await wc.executeJavaScript(`document.querySelector('[aria-label="Home"]')?.click()`)
      await wait(1500)
      await wc.executeJavaScript(`document.querySelector('button[title^="Record the screen"][aria-pressed="true"]')?.click()`)
      await wait(1500)
      console.log('[smoke] recording stopped')
    }

    // Stats are hidden by default; show them so they can be read.
    await wc.executeJavaScript(
      `document.querySelector('[aria-label="Stream stats"][aria-pressed="false"]')?.click()`
    )
    await wait(1200)
    const hud: Record<string, string> = await wc.executeJavaScript(`
      Object.fromEntries([...document.querySelectorAll('[aria-label="Stream statistics"] dt')]
        .map(dt => [dt.textContent, dt.nextElementSibling.textContent]))
    `)
    const shot = async (target: BrowserWindow, name: string) => {
      const path = outPath.replace(/\.png$/, `-${name}.png`)
      writeFileSync(path, (await target.webContents.capturePage()).toPNG())
      console.log(`[smoke] ${name}: ${path}`)
    }
    if (process.env.MIRROR_SMOKE_RECONNECT) {
      // Simulate a dropped connection by killing only this run's phone server.
      const owner = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 8)
      const serial = process.env.MIRROR_SMOKE_RECONNECT
      // `[o]wner` keeps pkill from matching the device shell that runs it.
      execFileSync('adb', ['-s', serial, 'shell', `pkill -f '[o]wner=${owner}'`])
      await wait(1500)
      const during: string = await wc.executeJavaScript(`document.querySelector('section[aria-label="Phone screen"]').innerText`)
      console.log(`[smoke] reconnect: after kill shows "${during.split('\n').find((l) => l.includes('Reconnecting')) ?? during.slice(0, 60)}"`)
      await wait(9000)
      const back: boolean = await wc.executeJavaScript(`!!document.querySelector('[aria-label="Stop mirroring"], button[title^="Record the screen"]')`)
      console.log(`[smoke] reconnect: mirroring resumed=${back}`)
    }
    if (process.env.MIRROR_SMOKE_FILES) {
      const serial = process.env.MIRROR_SMOKE_FILES
      execFileSync('adb', ['-s', serial, 'shell', 'echo drag-test > /sdcard/Download/mirror-drag-test.txt'])
      await wc.executeJavaScript(`document.querySelector('[aria-label="Phone files"]')?.click()`)
      await wait(1200)
      await wc.executeJavaScript(`[...document.querySelectorAll('aside[aria-label="Phone files"] button')].find(b => b.textContent === 'Download')?.click()`)
      await wait(1200)
      await shot(win, 'files')
      const listed: boolean = await wc.executeJavaScript(`document.querySelector('aside[aria-label="Phone files"]').innerText.includes('mirror-drag-test.txt')`)
      await wc.executeJavaScript(`window.mirror.dragPhoneFile(${JSON.stringify(serial)}, '/sdcard/Download/mirror-drag-test.txt'); 0`)
      await wait(1500)
      const { existsSync, readFileSync } = await import('node:fs')
      const pulled = join(app.getPath('temp'), 'Mirror Drag', 'mirror-drag-test.txt')
      console.log(`[smoke] files: listed=${listed} drag-pulled=${existsSync(pulled) && readFileSync(pulled, 'utf8').trim() === 'drag-test'}`)
      await wc.executeJavaScript(`window.mirror.deletePhoneFile(${JSON.stringify(serial)}, '/sdcard/Download/mirror-drag-test.txt')`)
      const left = execFileSync('adb', ['-s', serial, 'shell', 'ls /sdcard/Download/mirror-drag-test.txt 2>&1 || true']).toString()
      console.log(`[smoke] files: deleted=${left.includes('No such file')}`)
    }
    if (process.env.MIRROR_SMOKE_DEVTOOLS) {
      const panel = `document.querySelector('aside[aria-label="Developer tools"]')`
      await wc.executeJavaScript(`document.querySelector('[aria-label="Developer tools"]')?.click()`)
      await wait(3000)
      const logRows: number = await wc.executeJavaScript(`${panel}.querySelectorAll('.font-mono > div').length`)
      await wc.executeJavaScript(`[...${panel}.querySelectorAll('[role=tab]')].find(b => b.textContent === 'Apps').click()`)
      await wait(2500)
      const apps: number = await wc.executeJavaScript(`${panel}.querySelectorAll('ul li span.font-mono').length`)
      await wc.executeJavaScript(`[...${panel}.querySelectorAll('[role=tab]')].find(b => b.textContent === 'Device').click()`)
      await wait(4500)
      const device: string = await wc.executeJavaScript(`${panel}.innerText.replace(/\\s+/g, ' ')`)
      await shot(win, 'devtools-device')
      console.log(`[smoke] devtools: log rows=${logRows} apps=${apps} device="${device.replace(/^.*?Device /, '')}"`)
    }
    if (process.env.MIRROR_SMOKE_FARM) {
      await wc.executeJavaScript(clickByText('All devices'))
      await wait(9000)
      const tiles: { name: string; live: boolean }[] = await wc.executeJavaScript(`
        [...document.querySelectorAll('section[aria-label="All devices"] li')].map(li => ({
          name: li.querySelector('button')?.textContent ?? '',
          live: !/Connecting|Couldn't/.test(li.innerText)
        }))`)
      await wc.executeJavaScript(clickByText('Control all'))
      await wait(300)
      await wc.executeJavaScript(`document.querySelector('[aria-label="Home on all"]')?.click()`)
      await wait(1500)
      const emuFocus = execFileSync('adb', ['-s', process.env.MIRROR_SMOKE_FARM, 'shell', 'dumpsys window | grep -m1 mCurrentFocus']).toString().trim()
      await shot(win, 'farm')
      console.log(`[smoke] farm: tiles=${JSON.stringify(tiles)} emulator focus after Home on all: ${emuFocus.includes('Launcher') || emuFocus.includes('launcher')}`)
    }
    if (process.env.MIRROR_SMOKE_IOS) {
      // Select the first iPhone in the device list (listed by the capture helper).
      await wc.executeJavaScript(`[...document.querySelectorAll('nav[aria-label="Devices"] li button')].find(b => b.querySelector('svg') && /iPhone|iPad/.test(b.textContent))?.click()`)
      await wait(10_000)
      const iosHud: Record<string, string> = await wc.executeJavaScript(`
        Object.fromEntries([...document.querySelectorAll('[aria-label="Stream statistics"] dt')]
          .map(dt => [dt.textContent, dt.nextElementSibling.textContent]))
      `)
      const note: boolean = await wc.executeJavaScript(`document.body.innerText.includes('Viewing only')`)
      await shot(win, 'ios')
      console.log(`[smoke] ios: hud=${JSON.stringify(iosHud)} view-only note=${note}`)
      if (process.env.MIRROR_SMOKE_IOS_FILES) {
        await wc.executeJavaScript(`document.querySelector('[aria-label="Phone files"]')?.click()`)
        await wait(3000)
        const panel = `document.querySelector('aside[aria-label="iPhone photos and videos"]')`
        const count: number = await wc.executeJavaScript(`${panel}?.querySelectorAll('li').length ?? -1`)
        const first: string = await wc.executeJavaScript(`${panel}?.querySelector('li [draggable] .truncate')?.textContent ?? ''`)
        const selected: string = await wc.executeJavaScript(`window.mirror.listIosDevices().then((l) => l.find((d) => d.serial.startsWith('ios:'))?.serial ?? '')`)
        const items: { path: string; name: string; size: number }[] = await wc.executeJavaScript(`window.mirror.listIosMedia(${JSON.stringify(selected)})`)
        const item = items.find((i) => i.name === first)
        const { existsSync, statSync } = await import('node:fs')
        // Trigger the same drag-out download the panel uses.
        if (item) await wc.executeJavaScript(`window.mirror.dragPhoneFile(${JSON.stringify(selected)}, ${JSON.stringify(item.path)}); 0`)
        await wait(2500)
        const pulled = item ? join(app.getPath('temp'), 'Mirror Drag', item.name) : ''
        console.log(`[smoke] ios files: panel items=${count} drag-pulled=${!!item && existsSync(pulled) && statSync(pulled).size === item.size}`)
      }
    }
    if (process.env.MIRROR_SMOKE_IOS_CONTROL) {
      // Developer control end to end: start WebDriverAgent, send a harmless
      // volume up then down (no net change on the phone), turn it off.
      const states: string[] = []
      await wc.executeJavaScript(`window.__iosStates = []; window.mirror.onIosControlState((s, st) => window.__iosStates.push(st.kind + (st.message ? ': ' + st.message : ''))); 0`)
      const available: boolean = await wc.executeJavaScript('window.mirror.iosControlAvailable()')
      const t0 = Date.now()
      const started: string = await wc.executeJavaScript(`window.mirror.startIosControl('ios:smoke').then(() => 'ok', (e) => e.message)`)
      const startMs = Date.now() - t0
      await wc.executeJavaScript(`
        for (const key of ['volume_up', 'volume_down']) {
          window.mirror.sendInput('ios:smoke', { type: 'key', key, down: true, modifiers: 0 })
          window.mirror.sendInput('ios:smoke', { type: 'key', key, down: false, modifiers: 0 })
        }; 0`)
      await wait(3000)
      await wc.executeJavaScript(`window.mirror.stopIosControl('ios:smoke'); 0`)
      await wait(500)
      states.push(...((await wc.executeJavaScript('window.__iosStates')) as string[]))
      console.log(`[smoke] ios control: available=${available} start=${started} in ${startMs}ms states=${JSON.stringify(states)}`)
    }
    if (process.env.MIRROR_SMOKE_GIF) {
      const gifButton = `document.querySelector('button[title^="Capture an animated GIF"]')?.click()`
      await wc.executeJavaScript(gifButton)
      await wait(3000)
      await wc.executeJavaScript(gifButton)
      await wait(3000)
      console.log('[smoke] gif: capture stopped')
    }
    if (process.env.MIRROR_SMOKE_SHORTCUTS) {
      wc.send('menu:command', 'shortcuts')
      await wait(600)
      await shot(win, 'shortcuts')
      await wc.executeJavaScript(`document.querySelector('[aria-labelledby="shortcuts-title"] [aria-label="Close"]')?.click()`)
    }
    if (process.env.MIRROR_SMOKE_MULTI) {
      const extraSerial = process.env.MIRROR_SMOKE_MULTI
      await wc.executeJavaScript(
        `window.mirror.openDeviceWindow({ aspect: 1080 / 2400, name: 'Second phone', controllable: true, serial: ${JSON.stringify(extraSerial)}, mode: 'extra' }); 0`
      )
      await wait(6000)
      const extra = BrowserWindow.getAllWindows().find((w) => w !== win)
      if (extra) {
        await shot(extra, 'multi-extra')
        const extraLive: boolean = await extra.webContents.executeJavaScript(
          `!/Connecting|Couldn't|disconnected/.test(document.body.innerText)`
        )
        const mainHud: Record<string, string> = await wc.executeJavaScript(`
          Object.fromEntries([...document.querySelectorAll('[aria-label="Stream statistics"] dt')]
            .map(dt => [dt.textContent, dt.nextElementSibling.textContent]))
        `)
        console.log(`[smoke] multi: extra window live=${extraLive}, main window visible=${win.isVisible()} fps=${mainHud['Frame rate']}`)
        await shot(win, 'multi-main')
        extra.close()
        await wait(1500)
        console.log(`[smoke] multi: extra window closed, windows left=${BrowserWindow.getAllWindows().length}`)
      } else {
        console.log('[smoke] multi: extra window did not open')
      }
    }
    if (process.env.MIRROR_SMOKE_DEVICE_WINDOW) {
      await wc.executeJavaScript(`document.querySelector('[aria-label="Device window"]')?.click()`)
      await wait(3000)
      const device = BrowserWindow.getAllWindows().find((w) => w !== win)
      if (device) {
        const devicePath = outPath.replace(/\.png$/, '-device.png')
        writeFileSync(devicePath, (await device.webContents.capturePage()).toPNG())
        const showing: boolean = await device.webContents.executeJavaScript(
          `!document.body.innerText.includes('Connecting to your phone')`
        )
        console.log(`[smoke] device window: ${devicePath} size=${JSON.stringify(device.getSize())} frames=${showing}`)
        await device.webContents.executeJavaScript('window.mirror.resizeDeviceWindow(600)')
        await wait(400)
        console.log(`[smoke] device window after resize to 600: ${JSON.stringify(device.getSize())}`)
        await device.webContents.executeJavaScript(`document.querySelector('[aria-label^="Resize"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
        await wait(400)
        console.log(`[smoke] device window after reset: ${JSON.stringify(device.getSize())}`)
        await device.webContents.executeJavaScript(`document.querySelector('[aria-label="Back to app window"]')?.click()`)
        await wait(1500)
        console.log(`[smoke] main window visible again: ${win.isVisible()}`)
      } else {
        console.log('[smoke] device window did not open')
      }
    }
    if (process.env.MIRROR_SMOKE_SETUP) {
      // Click inside the wizard when it is open; the app behind it has similar labels.
      const click = (text: string) =>
        wc.executeJavaScript(`
          (() => {
            const scope = document.querySelector('[aria-labelledby="setup-title"]') || document
            ;[...scope.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))?.click()
          })()
        `)
      await click('Set up a phone')
      await wait(700)
      await shot(win, 'setup-platform')
      await click('Android')
      await wait(400)
      await click('Wi-Fi')
      await wait(500)
      await shot(win, 'setup-brand')
      await click('Samsung')
      await wait(500)
      await shot(win, 'setup-devoptions')
      await click('Close setup')
      await wait(300)
      await click('Set up a phone')
      await wait(400)
      await click('Android')
      await wait(400)
      await click('USB cable')
      await wait(3000)
      await shot(win, 'setup-done')
      await click('Close setup')
      await wait(300)
    }
    if (process.env.MIRROR_SMOKE_IOS_SETUP) {
      const click = (scopeSel: string, text: string) =>
        wc.executeJavaScript(`
          (() => {
            const scope = document.querySelector(${JSON.stringify(scopeSel)}) || document
            ;[...scope.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))?.click()
          })()
        `)
      const wizard = '[aria-labelledby="setup-title"]'
      await click('body', 'Set up a phone')
      await wait(600)
      await shot(win, 'ios-setup-platform')
      await click(wizard, 'iPhone')
      await wait(400)
      await shot(win, 'ios-setup-method')
      await click(wizard, 'Wi-Fi')
      await wait(400)
      await shot(win, 'ios-setup-app')
      await click(wizard, 'Continue')
      await wait(400)
      await shot(win, 'ios-setup-allow')
      await click(wizard, 'Back')
      await wait(200)
      await click(wizard, 'Back')
      await wait(200)
      await click(wizard, 'USB cable')
      await wait(500)
      await shot(win, 'ios-setup-cable')
      await click(wizard, 'Close setup')
      await wait(300)
    }
    if (process.env.MIRROR_SMOKE_I18N) {
      // Screens opened through menu commands, so this works in any language.
      const lang: string = await wc.executeJavaScript('document.documentElement.lang + "/" + document.documentElement.dir')
      console.log(`[smoke] i18n: ${lang}`)
      await shot(win, 'i18n-main')
      wc.send('menu:command', 'settings')
      await wait(900)
      await shot(win, 'i18n-settings')
      await wc.executeJavaScript(`document.querySelector('[aria-labelledby="settings-title"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 0`)
      await wait(300)
      wc.send('menu:command', 'setup')
      await wait(700)
      await shot(win, 'i18n-setup')
      await wc.executeJavaScript(`[...document.querySelectorAll('[aria-labelledby="setup-title"] button')].at(-1)?.click(); 0`)
      await wait(500)
      await shot(win, 'i18n-setup-ios')
      await wc.executeJavaScript(`document.querySelector('[aria-labelledby="setup-title"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 0`)
      await wait(300)
    }
    if (process.env.MIRROR_SMOKE_INSTALLER) {
      const info = await wc.executeJavaScript('window.mirror.companionInstallInfo()')
      console.log(`[smoke] installer: problem=${info.problem} available=${info.available} teams=${JSON.stringify(info.teams.map((t: { id: string; free: boolean }) => `${t.id}${t.free ? ' (free)' : ''}`))} devices=${JSON.stringify(info.devices.map((d: { name: string; wired: boolean; developerMode: boolean }) => `${d.name} wired=${d.wired} devMode=${d.developerMode}`))} profiles=${JSON.stringify(info.profiles.map((p: { name: string; appId: string; development: boolean; allDevices: boolean; devices: string[]; expiresAt: number }) => `${p.name} [${p.appId}] dev=${p.development} devices=${p.allDevices ? 'all' : p.devices.length} expired=${p.expiresAt < Date.now()}`))}`)
    }
    if (process.env.MIRROR_SMOKE_SETTINGS) {
      await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Settings'))?.click()`)
      await wait(700)
      const settings = await wc.executeJavaScript('window.mirror.getSettings()')
      console.log(`[smoke] settings: ${JSON.stringify(settings)}`)
      await shot(win, 'settings')
      await wc.executeJavaScript(`document.querySelector('main')?.scrollBy(0, 2000); document.querySelector('[aria-labelledby="settings-title"] main')?.scrollTo(0, 99999)`)
      await wait(300)
      await shot(win, 'settings-bottom')
      await wc.executeJavaScript(`[...document.querySelectorAll('p')].find(p => p.textContent === 'Install on an iPhone')?.scrollIntoView({ block: 'start' })`)
      await wait(2500)
      await shot(win, 'settings-installer')
      await wc.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Close settings'))?.click()`)
      await wait(300)
    }
    if (process.env.MIRROR_SMOKE_CROP) {
      // Needs a live phone (MIRROR_SMOKE_TARGET=android).
      const screenBox = `(() => { const r = document.querySelector('.phone-screen').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })()`
      // Wait for live frames (the crop button is enabled once they arrive).
      for (let i = 0; i < 40; i++) {
        const ready: boolean = await wc.executeJavaScript(`!!document.querySelector('[aria-label="Crop the screen"]:not([disabled])') && !!document.querySelector('.phone-screen')`)
        if (ready) break
        await wait(250)
      }
      await wait(500)
      if (!(await wc.executeJavaScript(`!!document.querySelector('.phone-screen')`))) {
        await shot(win, 'crop-not-live')
        throw new Error('crop: the phone is not mirroring')
      }
      const before: number[] = await wc.executeJavaScript(screenBox)
      await wc.executeJavaScript(`document.querySelector('[aria-label="Crop the screen"]')?.click()`)
      await wait(500)
      await shot(win, 'crop-editor')
      await wc.executeJavaScript(`[...document.querySelectorAll('[role="group"][aria-label="Crop the screen"] button')].find(b => b.textContent === 'Apply')?.click()`)
      await wait(800)
      const after: number[] = await wc.executeJavaScript(screenBox)
      // Copy a cropped screenshot and measure it from the clipboard (nothing saved).
      await wc.executeJavaScript(`document.querySelector('[aria-label="Copy screenshot"]')?.click()`)
      await wait(1200)
      const { readdirSync, readFileSync, statSync, rmSync } = await import('node:fs')
      const tempDir = join(app.getPath('temp'), 'Mirror Screenshots')
      const newest = readdirSync(tempDir).map((f) => join(tempDir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
      const png = newest ? readFileSync(newest) : null
      console.log(`[smoke] crop: copied screenshot ${png ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : 'missing'} (stream 1080x2400, crop 80%)`)
      if (newest) rmSync(newest)
      await shot(win, 'crop-applied')
      console.log(`[smoke] crop: screen box before=${before} after=${after} (expect same height, narrower: 0.8 x 0.8 of the frame)`)
      await wc.executeJavaScript(`document.querySelector('[aria-label="Crop the screen"]')?.click()`)
      await wait(400)
      await wc.executeJavaScript(`[...document.querySelectorAll('[role="group"][aria-label="Crop the screen"] button')].find(b => b.textContent === 'Whole screen')?.click()`)
      await wc.executeJavaScript(`[...document.querySelectorAll('[role="group"][aria-label="Crop the screen"] button')].find(b => b.textContent === 'Apply')?.click()`)
      await wait(500)
      const reset: number[] = await wc.executeJavaScript(screenBox)
      console.log(`[smoke] crop reset: screen box=${reset}`)
    }
    if (process.env.MIRROR_SMOKE_DOCTOR) {
      wc.send('menu:command', 'doctor')
      await wait(12_000)
      await shot(win, 'doctor')
      const rows: string[] = await wc.executeJavaScript(
        `[...document.querySelectorAll('[aria-labelledby="doctor-title"] ol li')].map(li => li.innerText.replace(/\\s+/g, ' '))`
      )
      console.log(`[smoke] doctor rows: ${JSON.stringify(rows, null, 1)}`)
    }
    if (process.env.MIRROR_SMOKE_COPY) {
      await wc.executeJavaScript(`document.querySelector('[aria-label="Copy screenshot"]')?.click()`)
      await wait(800)
      const items = await clipboard.read()
      console.log(`[smoke] clipboard after copy: ${JSON.stringify(items.flatMap((i) => i.types))}`)
    }
    if (process.env.MIRROR_SMOKE_WIFI) {
      await wc.executeJavaScript(clickByText('Connect over Wi-Fi'))
      await wait(800)
    }
    const toasts: string[] = await wc.executeJavaScript(
      `[...document.querySelectorAll('[aria-live] li')].map(li => li.innerText.replace(/\\s+/g, ' '))`
    )
    console.log(`[smoke] toasts: ${JSON.stringify(toasts)}`)
    writeFileSync(outPath, (await wc.capturePage()).toPNG())
    if (process.env.MIRROR_SMOKE_TARGET === 'android') {
      await wc.executeJavaScript(`document.querySelector('[aria-label="Home"]')?.click()`)
      await wait(300)
    }
    console.log(`[smoke] screenshot: ${outPath}`)
    console.log(`[smoke] hud: ${JSON.stringify(hud)}`)
    if (process.env.MIRROR_SMOKE_TARGET === 'android') {
      console.log(`[smoke] audio packets received: ${await wc.executeJavaScript('window.__audioPackets')}`)
    }

    console.log('[smoke] cleanup: start')
    await cleanup()
    console.log('[smoke] cleanup: done, exiting')
    process.on('exit', (code) => console.log(`[smoke] process exit ${code}`))
    const fps = Number.parseFloat(hud['Frame rate'] ?? '')
    app.exit(Number.isFinite(fps) && fps > 0 ? 0 : 1)
  }
}
