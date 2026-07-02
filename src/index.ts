import { h, render } from 'preact'
import cssText from './styles.css?inline'
import Widget from './widget'
import { defaultLabels, type BugReportConfig, type ResolvedConfig } from './types'

export type { BugReportConfig, Labels } from './types'

const HOST_ID = 'bug-report-widget'

let host: HTMLElement | null = null
let mount: HTMLElement | null = null

export function init(config: BugReportConfig): void {
  if (!config?.endpoint) {
    console.error('[bug-report-widget] init: `endpoint` is required')
    return
  }
  if (host) destroy()

  const resolved: ResolvedConfig = {
    endpoint: config.endpoint,
    headers: config.headers,
    credentials: config.credentials,
    hotkey: config.hotkey !== false,
    labels: { ...defaultLabels, ...config.labels },
  }

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
  host = null
  mount = null
}

// Автоинициализация из data-атрибутов тега <script>
const script = document.currentScript as HTMLScriptElement | null
const endpoint = script?.dataset.endpoint
if (endpoint) {
  const start = () =>
    init({
      endpoint,
      hotkey: script?.dataset.hotkey !== 'false',
      credentials: script?.dataset.credentials as RequestCredentials | undefined,
    })
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}
