/* This file intentionally patches console methods, fetch and XMLHttpRequest to capture logs */

type ConsoleEntry = {
  level: 'log' | 'warn' | 'error' | 'info'
  message: string
  timestamp: string
}

type NetworkEntry = {
  method: string
  url: string
  status: number | null
  duration_ms: number
  request_headers: Record<string, string> | null
  /** Parsed object for JSON bodies (DevTools Preview), truncated string otherwise */
  request_body: unknown
  response_headers: Record<string, string> | null
  response_body: unknown
  timestamp: string
}

const CONSOLE_MAX = 100
const NETWORK_MAX = 50
const BODY_MAX = 5120
const TRUNCATION_MARKER = '[truncated at 5120 bytes]'
const BINARY_MARKER = '[binary, skipped]'
const STREAM_MARKER = '[stream, skipped]'
const READ_ERROR_MARKER = '[read error]'
const REDACTED_MARKER = '[redacted]'
const BINARY_CONTENT_TYPES = ['image/', 'video/', 'audio/', 'font/', 'application/octet-stream']
// Values of these headers never reach the report — they carry credentials
const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]

export type NetworkCaptureMode = 'errors' | 'all'

const consoleLogs: ConsoleEntry[] = []
const networkRequests: NetworkEntry[] = []

let initialized = false
let captureMode: NetworkCaptureMode = 'errors'

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
}
let originalFetchRef: typeof globalThis.fetch | null = null
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null
let originalXhrSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null

function pushConsole(entry: ConsoleEntry): void {
  consoleLogs.push(entry)
  if (consoleLogs.length > CONSOLE_MAX) consoleLogs.shift()
}

function pushNetwork(entry: NetworkEntry): void {
  networkRequests.push(entry)
  if (networkRequests.length > NETWORK_MAX) networkRequests.shift()
}

// Strings stay unquoted, like the DevTools console prints them
function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

const FORMAT_SPECIFIERS = /%[sdifoOc%]/g
const HAS_FORMAT_SPECIFIER = /%[sdifoOc%]/

// Console format directives (%c, %s, …) are resolved like the browser does:
// substitutions are applied, %c style arguments are consumed and dropped.
export function serializeArgs(args: unknown[]): string {
  const [first, ...rest] = args
  if (typeof first !== 'string' || !HAS_FORMAT_SPECIFIER.test(first)) {
    return args.map(stringifyArg).join(' ')
  }

  let argIndex = 0
  const message = first.replace(FORMAT_SPECIFIERS, (spec) => {
    if (spec === '%%') return '%'
    if (argIndex >= rest.length) return spec
    const arg = rest[argIndex++]
    switch (spec) {
      case '%c':
        return ''
      case '%s':
        return String(arg)
      case '%d':
      case '%i':
        return String(parseInt(String(arg), 10))
      case '%f':
        return String(parseFloat(String(arg)))
      default:
        return stringifyArg(arg)
    }
  })

  const remaining = rest.slice(argIndex).map(stringifyArg)
  return [message.trim(), ...remaining].join(' ').trim()
}

function truncate(text: string): string {
  if (text.length <= BODY_MAX) return text
  return text.slice(0, BODY_MAX) + TRUNCATION_MARKER
}

function isBinary(contentType: string | null): boolean {
  if (!contentType) return false
  return BINARY_CONTENT_TYPES.some((prefix) => contentType.includes(prefix))
}

function redactValue(key: string, value: string): string {
  return SENSITIVE_HEADERS.includes(key.toLowerCase()) ? REDACTED_MARKER : value
}

function headersToRecord(headers: Headers): Record<string, string> | null {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = redactValue(key, value)
  })
  return Object.keys(record).length > 0 ? record : null
}

// XHR exposes response headers only as a raw CRLF-joined string
function parseRawHeaders(raw: string): Record<string, string> | null {
  const record: Record<string, string> = {}
  for (const line of raw.split('\r\n')) {
    const sep = line.indexOf(': ')
    if (sep === -1) continue
    const key = line.slice(0, sep).toLowerCase()
    record[key] = redactValue(key, line.slice(sep + 2))
  }
  return Object.keys(record).length > 0 ? record : null
}

// JSON bodies become parsed objects (like the DevTools Preview tab),
// everything else stays a truncated string.
function previewBody(text: string, contentType: string | null): unknown {
  if (contentType?.includes('json') && text.length <= BODY_MAX) {
    try {
      return JSON.parse(text)
    } catch {
      /* fall through to plain text */
    }
  }
  return truncate(text)
}

function patchConsole() {
  const levels = ['log', 'warn', 'error', 'info'] as const
  for (const level of levels) {
    const original = originalConsole[level]
    console[level] = (...args: unknown[]) => {
      if (level === 'warn' || level === 'error') {
        pushConsole({ level, message: serializeArgs(args), timestamp: new Date().toISOString() })
      }
      original(...args)
    }
  }
}

function onWindowError(e: ErrorEvent): void {
  const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''
  pushConsole({
    level: 'error',
    message: `Uncaught: ${e.message}${where}`,
    timestamp: new Date().toISOString(),
  })
}

// Resource load failures (404 images, scripts, styles) don't bubble to window
// and the browser reports them bypassing console.error — the only way to see
// them is an error listener in the capture phase.
function onResourceError(e: Event): void {
  const target = e.target
  // Uncaught JS errors arrive here too (as ErrorEvent) — those are handled by onWindowError
  if (e instanceof ErrorEvent || !(target instanceof Element)) return
  const el = target as { src?: unknown; href?: unknown }
  const url =
    typeof el.src === 'string' && el.src
      ? el.src
      : typeof el.href === 'string'
        ? el.href
        : ''
  pushConsole({
    level: 'error',
    message: `Failed to load <${target.tagName.toLowerCase()}>${url ? `: ${url}` : ''}`,
    timestamp: new Date().toISOString(),
  })
}

function onUnhandledRejection(e: PromiseRejectionEvent): void {
  const reason = e.reason instanceof Error ? String(e.reason) : stringifyArg(e.reason)
  pushConsole({
    level: 'error',
    message: `Unhandled rejection: ${reason}`,
    timestamp: new Date().toISOString(),
  })
}

function patchFetch() {
  originalFetchRef = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const originalFetch = originalFetchRef!
    const timestamp = new Date().toISOString()
    const start = Date.now()

    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    const requestHeaders = headersToRecord(
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    )
    let requestBody: unknown = null
    if (typeof init?.body === 'string') {
      requestBody = previewBody(init.body, requestHeaders?.['content-type'] ?? null)
    }

    let response: Response
    try {
      response = await originalFetch(input, init)
    } catch (err) {
      pushNetwork({
        method,
        url,
        status: null,
        duration_ms: Date.now() - start,
        request_headers: requestHeaders,
        request_body: requestBody,
        response_headers: null,
        response_body: null,
        timestamp,
      })
      throw err
    }

    if (captureMode === 'all' || response.status >= 400) {
      const entry: NetworkEntry = {
        method,
        url,
        status: response.status,
        duration_ms: Date.now() - start,
        request_headers: requestHeaders,
        request_body: requestBody,
        response_headers: headersToRecord(response.headers),
        response_body: null,
        timestamp,
      }
      pushNetwork(entry)
      const contentType = response.headers.get('content-type')
      if (isBinary(contentType)) {
        entry.response_body = BINARY_MARKER
      } else if (contentType?.includes('text/event-stream')) {
        entry.response_body = STREAM_MARKER
      } else {
        // Fill the body in asynchronously: awaiting it here would hold the
        // response back from the caller until the full body arrives (and
        // never return it for endless streams).
        response
          .clone()
          .text()
          .then(
            (text) => {
              entry.response_body = previewBody(text, contentType)
            },
            () => {
              entry.response_body = READ_ERROR_MARKER
            },
          )
      }
    }

    return response
  }
}

type XhrMeta = {
  method: string
  url: string
  start: number
  timestamp: string
  requestHeaders: Record<string, string>
  requestBody: unknown
}

const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>()

function patchXhr() {
  const proto = XMLHttpRequest.prototype
  originalXhrOpen = proto.open
  originalXhrSend = proto.send
  originalXhrSetHeader = proto.setRequestHeader

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ) {
    xhrMeta.set(this, {
      method: method.toUpperCase(),
      url: String(url),
      start: 0,
      timestamp: '',
      requestHeaders: {},
      requestBody: null,
    })
    return originalXhrOpen!.call(this, method, url, async, username ?? null, password ?? null)
  }

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const meta = xhrMeta.get(this)
    if (meta) meta.requestHeaders[name.toLowerCase()] = redactValue(name, value)
    return originalXhrSetHeader!.call(this, name, value)
  }

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = xhrMeta.get(this)
    if (meta) {
      meta.start = Date.now()
      meta.timestamp = new Date().toISOString()
      if (typeof body === 'string') {
        meta.requestBody = previewBody(body, meta.requestHeaders['content-type'] ?? null)
      }
      this.addEventListener('loadend', () => {
        // status 0 — network error / aborted request
        const failed = this.status === 0 || this.status >= 400
        if (captureMode !== 'all' && !failed) return
        const contentType = this.getResponseHeader('content-type')
        let responseBody: unknown = null
        if (this.status !== 0) {
          if (isBinary(contentType)) {
            responseBody = BINARY_MARKER
          } else if (this.responseType === '' || this.responseType === 'text') {
            try {
              responseBody = previewBody(this.responseText, contentType)
            } catch {
              responseBody = READ_ERROR_MARKER
            }
          } else {
            responseBody = `[responseType: ${this.responseType}, skipped]`
          }
        }
        pushNetwork({
          method: meta.method,
          url: meta.url,
          status: this.status === 0 ? null : this.status,
          duration_ms: Date.now() - meta.start,
          request_headers:
            Object.keys(meta.requestHeaders).length > 0 ? { ...meta.requestHeaders } : null,
          request_body: meta.requestBody,
          response_headers:
            this.status !== 0 ? parseRawHeaders(this.getAllResponseHeaders()) : null,
          response_body: responseBody,
          timestamp: meta.timestamp,
        })
      })
    }
    return originalXhrSend!.call(this, body ?? null)
  }
}

export function initInterceptors(mode: NetworkCaptureMode = 'errors'): void {
  captureMode = mode
  if (initialized) return
  initialized = true
  patchConsole()
  patchFetch()
  if (typeof XMLHttpRequest !== 'undefined') patchXhr()
  if (typeof window !== 'undefined') {
    window.addEventListener('error', onWindowError)
    window.addEventListener('error', onResourceError, true)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
  }
}

export function teardownInterceptors(): void {
  if (!initialized) return
  initialized = false
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.info = originalConsole.info
  if (originalFetchRef !== null) {
    globalThis.fetch = originalFetchRef
    originalFetchRef = null
  }
  if (originalXhrOpen !== null) {
    XMLHttpRequest.prototype.open = originalXhrOpen
    originalXhrOpen = null
  }
  if (originalXhrSend !== null) {
    XMLHttpRequest.prototype.send = originalXhrSend
    originalXhrSend = null
  }
  if (originalXhrSetHeader !== null) {
    XMLHttpRequest.prototype.setRequestHeader = originalXhrSetHeader
    originalXhrSetHeader = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('error', onWindowError)
    window.removeEventListener('error', onResourceError, true)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}

export function _resetForTesting(): void {
  teardownInterceptors()
  consoleLogs.length = 0
  networkRequests.length = 0
}

export function getConsoleLogs(): ConsoleEntry[] {
  return [...consoleLogs]
}

export function getNetworkRequests(): NetworkEntry[] {
  return [...networkRequests]
}
