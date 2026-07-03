import { h, render } from 'preact'
import cssText from './styles.css?inline'
import Widget from './widget'
import { teardownInterceptors } from './capture-interceptors'
import { defaultLabels, type BugReportConfig, type ResolvedConfig } from './types'

export type { BugReportConfig, Labels } from './types'

const HOST_ID = 'bug-report-widget'
const PROPERTY_STYLE_ID = 'bug-report-widget-properties'

let host: HTMLElement | null = null
let mount: HTMLElement | null = null

// Chromium ignores @property rules inside a shadow root, so Tailwind's
// registered defaults (e.g. --tw-border-style: solid) never apply and every
// border-* utility collapses to width 0. Re-inject those rules at document
// level, where registration is honored and is global to shadow trees too.
function injectPropertyRules(): void {
  if (document.getElementById(PROPERTY_STYLE_ID)) return
  const rules = cssText.match(/@property[^{]+\{[^}]*\}/g)
  if (!rules) return
  const style = document.createElement('style')
  style.id = PROPERTY_STYLE_ID
  style.textContent = rules.join('\n')
  document.head.appendChild(style)
}

export function init(config: BugReportConfig): void {
  const download = config?.download !== false
  const destination =
    download && config?.destination === 'download' ? 'download' : 'endpoint'
  if (destination === 'endpoint' && !config?.endpoint) {
    console.error(
      '[bug-report-widget] init: `endpoint` is required unless `destination` is "download"',
    )
    return
  }
  if (host) destroy()

  const resolved: ResolvedConfig = {
    endpoint: config.endpoint,
    destination,
    download,
    video: config.video === true,
    network: config.network === 'all' ? 'all' : 'errors',
    headers: config.headers,
    credentials: config.credentials,
    hotkey: config.hotkey !== false,
    labels: { ...defaultLabels, ...config.labels },
  }

  injectPropertyRules()

  host = document.createElement('div')
  host.id = HOST_ID
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = cssText
  shadow.appendChild(style)

  mount = document.createElement('div')
  shadow.appendChild(mount)
  document.body.appendChild(host)

  render(h(Widget, { config: resolved }), mount)
}

export function destroy(): void {
  if (!host || !mount) return
  render(null, mount)
  host.remove()
  document.getElementById(PROPERTY_STYLE_ID)?.remove()
  teardownInterceptors()
  host = null
  mount = null
}

// Auto-initialization from <script> tag data attributes.
// The guard keeps the module importable during SSR (Next.js and friends),
// where `document` does not exist at module-evaluation time.
if (typeof document !== 'undefined') {
  const script = document.currentScript as HTMLScriptElement | null
  const endpoint = script?.dataset.endpoint
  const destination = script?.dataset.destination === 'download' ? 'download' : 'endpoint'
  if (endpoint || destination === 'download') {
    const start = () =>
      init({
        endpoint,
        destination,
        download: script?.dataset.download !== 'false',
        video: script?.dataset.video === 'true',
        network: script?.dataset.network === 'all' ? 'all' : 'errors',
        hotkey: script?.dataset.hotkey !== 'false',
        credentials: script?.dataset.credentials as RequestCredentials | undefined,
      })
    if (document.body) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
  }
}
