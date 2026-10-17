import { createRoot } from 'react-dom/client'
import { App } from './App'
import { DeviceView } from './DeviceView'
import './styles.css'
// Sets the page's language and direction (from the app's language) before the first render.
import './i18n'

const root = createRoot(document.getElementById('root')!)

// The device window loads the same page with `#device?name=...`.
if (location.hash.startsWith('#device')) {
  const params = new URLSearchParams(location.hash.slice(location.hash.indexOf('?') + 1))
  document.documentElement.classList.add('device-view')
  root.render(
    <DeviceView
      name={params.get('name') ?? 'Phone'}
      initialAspect={Number(params.get('aspect')) || 1080 / 2340}
      controllable={params.get('controllable') === '1'}
      serial={params.get('serial') || null}
      mode={params.get('mode') === 'extra' ? 'extra' : 'popout'}
    />
  )
} else {
  root.render(<App />)
}
