/* This file intentionally patches console methods and fetch to capture logs */

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
  request_body: string | null
  response_body: string | null
  timestamp: string
}

const CONSOLE_MAX = 100
const NETWORK_MAX = 50
const BODY_MAX = 5120
const TRUNCATION_MARKER = '[truncated at 5120 bytes]'
const BINARY_MARKER = '[binary, skipped]'
const BINARY_CONTENT_TYPES = ['image/', 'video/', 'audio/', 'font/', 'application/octet-stream']

const consoleLogs: ConsoleEntry[] = []
const networkRequests: NetworkEntry[] = []

let initialized = false

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
}
let originalFetchRef: typeof globalThis.fetch | null = null

function serializeArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

function truncate(text: string): string {
  if (text.length <= BODY_MAX) return text
  return text.slice(0, BODY_MAX) + TRUNCATION_MARKER
}

function isBinary(contentType: string | null): boolean {
  if (!contentType) return false
  return BINARY_CONTENT_TYPES.some((prefix) => contentType.includes(prefix))
}

function patchConsole() {
  const levels = ['log', 'warn', 'error', 'info'] as const
  for (const level of levels) {
    const original = originalConsole[level]
    console[level] = (...args: unknown[]) => {
      if (level === 'warn' || level === 'error') {
        consoleLogs.push({ level, message: serializeArgs(args), timestamp: new Date().toISOString() })
        if (consoleLogs.length > CONSOLE_MAX) consoleLogs.shift()
      }
      original(...args)
    }
  }
}

function patchFetch() {
  originalFetchRef = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const originalFetch = originalFetchRef!
    const timestamp = new Date().toISOString()
    const start = Date.now()

    const method = init?.method ?? 'GET'
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    let requestBody: string | null = null
    if (typeof init?.body === 'string') {
      requestBody = truncate(init.body)
    }

    let response: Response
    let status: number | null = null
    let responseBody: string | null = null

    try {
      response = await originalFetch(input, init)
      status = response.status

      const contentType = response.headers.get('content-type')
      if (isBinary(contentType)) {
        responseBody = BINARY_MARKER
      } else {
        try {
          const text = await response.clone().text()
          responseBody = truncate(text)
        } catch {
          responseBody = '[read error]'
        }
      }
    } catch (err) {
      const duration_ms = Date.now() - start
      networkRequests.push({ method, url, status: null, duration_ms, request_body: requestBody, response_body: null, timestamp })
      if (networkRequests.length > NETWORK_MAX) networkRequests.shift()
      throw err
    }

    const duration_ms = Date.now() - start
    if (status >= 400) {
      networkRequests.push({ method, url, status, duration_ms, request_body: requestBody, response_body: responseBody, timestamp })
      if (networkRequests.length > NETWORK_MAX) networkRequests.shift()
    }

    return response
  }
}

export function _resetForTesting(): void {
  consoleLogs.length = 0
  networkRequests.length = 0
  initialized = false
  // Restore original methods to avoid stacking wrapper layers
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.info = originalConsole.info
  if (originalFetchRef !== null) {
    globalThis.fetch = originalFetchRef
    originalFetchRef = null
  }
}

export function initInterceptors(): void {
  if (initialized) return
  initialized = true
  patchConsole()
  patchFetch()
}

export function getConsoleLogs(): ConsoleEntry[] {
  return [...consoleLogs]
}

export function getNetworkRequests(): NetworkEntry[] {
  return [...networkRequests]
}
