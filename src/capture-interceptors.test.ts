import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initInterceptors,
  teardownInterceptors,
  _resetForTesting,
  getConsoleLogs,
  getNetworkRequests,
  serializeArgs,
} from './capture-interceptors'

const realFetch = globalThis.fetch

async function flushBodyCapture(): Promise<void> {
  // response bodies are filled in asynchronously after the entry is pushed
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  _resetForTesting()
})

afterEach(() => {
  _resetForTesting()
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('serializeArgs', () => {
  it('joins plain arguments with JSON stringification', () => {
    expect(serializeArgs(['msg', { a: 1 }, 2])).toBe('msg {"a":1} 2')
  })

  it('applies %s and %d substitutions', () => {
    expect(serializeArgs(['user %s has %d items', 'alice', '5'])).toBe('user alice has 5 items')
  })

  it('drops %c style arguments', () => {
    expect(serializeArgs(['%cstyled', 'color: red'])).toBe('styled')
  })

  it('keeps %% as a literal percent', () => {
    expect(serializeArgs(['100%%'])).toBe('100%')
  })

  it('appends leftover arguments after substitutions', () => {
    expect(serializeArgs(['%s!', 'hi', { extra: true }])).toBe('hi! {"extra":true}')
  })
})

describe('console capture', () => {
  it('records warn and error, skips log and info', () => {
    initInterceptors()
    console.warn('careful')
    console.error('boom', { code: 1 })
    console.log('noise')
    console.info('noise')

    const logs = getConsoleLogs()
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ level: 'warn', message: 'careful' })
    expect(logs[1]).toMatchObject({ level: 'error', message: 'boom {"code":1}' })
    expect(logs[1]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('teardown restores the original console methods', () => {
    const originalWarn = console.warn
    initInterceptors()
    expect(console.warn).not.toBe(originalWarn)
    teardownInterceptors()
    expect(console.warn).toBe(originalWarn)
  })
})

describe('fetch capture', () => {
  it('records failed responses in errors mode and skips 2xx', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('{"error":"nope"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      )
    initInterceptors('errors')

    await fetch('/fine')
    await fetch('/broken')
    await flushBodyCapture()

    const reqs = getNetworkRequests()
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({
      method: 'GET',
      url: '/broken',
      status: 500,
      response_body: { error: 'nope' },
    })
  })

  it('records every request in all mode', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    initInterceptors('all')
    await fetch('/one')
    await fetch('/two', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
    await flushBodyCapture()

    const reqs = getNetworkRequests()
    expect(reqs).toHaveLength(2)
    expect(reqs[1]).toMatchObject({ method: 'POST', request_body: { a: 1 } })
  })

  it('redacts sensitive request headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('no', { status: 401 }))
    initInterceptors('errors')
    await fetch('/private', { headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'k' } })
    await flushBodyCapture()

    const headers = getNetworkRequests()[0]!.request_headers!
    expect(headers['authorization']).toBe('[redacted]')
    expect(headers['x-api-key']).toBe('[redacted]')
  })

  it('does not read event-stream bodies', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('data: x\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    initInterceptors('all')
    await fetch('/stream')

    expect(getNetworkRequests()[0]!.response_body).toBe('[stream, skipped]')
  })

  it('returns the response before the body is consumed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('payload', { status: 500 }))
    initInterceptors('errors')
    const res = await fetch('/err')
    // the caller can still read the body — capture used a clone
    expect(await res.text()).toBe('payload')
    await flushBodyCapture()
    expect(getNetworkRequests()[0]!.response_body).toBe('payload')
  })

  it('records network errors and rethrows', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('offline'))
    initInterceptors('errors')
    await expect(fetch('/down')).rejects.toThrow('offline')

    expect(getNetworkRequests()[0]).toMatchObject({ url: '/down', status: null })
  })

  it('re-initialization switches the capture mode without stacking patches', async () => {
    const stub = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    globalThis.fetch = stub
    initInterceptors('errors')
    initInterceptors('all')
    await fetch('/x')
    await flushBodyCapture()

    expect(stub).toHaveBeenCalledTimes(1)
    expect(getNetworkRequests()).toHaveLength(1)
  })

  it('teardown restores the original fetch', () => {
    const stub = vi.fn()
    globalThis.fetch = stub
    initInterceptors()
    expect(globalThis.fetch).not.toBe(stub)
    teardownInterceptors()
    expect(globalThis.fetch).toBe(stub)
  })
})

describe('XHR capture', () => {
  // Node has no XMLHttpRequest — a minimal fake exercises the prototype patch
  class FakeXhr {
    status = 0
    responseType = ''
    responseText = ''
    private listeners: Record<string, Array<() => void>> = {}
    open(_method: string, _url: string | URL) {}
    setRequestHeader(_name: string, _value: string) {}
    send(_body?: unknown) {
      this.dispatch('loadend')
    }
    addEventListener(type: string, cb: () => void) {
      ;(this.listeners[type] ??= []).push(cb)
    }
    getResponseHeader(_name: string): string | null {
      return 'application/json'
    }
    getAllResponseHeaders(): string {
      return 'content-type: application/json\r\nset-cookie: session=secret'
    }
    private dispatch(type: string) {
      for (const cb of this.listeners[type] ?? []) cb()
    }
  }

  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  })

  afterEach(() => {
    _resetForTesting()
    vi.unstubAllGlobals()
  })

  it('records a failed XHR with method, url, body and redacted headers', () => {
    initInterceptors('errors')
    // the patch rewrites XMLHttpRequest.prototype (= FakeXhr.prototype)
    const xhr = new FakeXhr()
    xhr.responseText = '{"error":"gone"}'
    xhr.open('get', '/api/missing')
    xhr.setRequestHeader('Authorization', 'Bearer secret')
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.status = 404
    xhr.send('{"q":1}')

    const reqs = getNetworkRequests()
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({
      method: 'GET',
      url: '/api/missing',
      status: 404,
      request_body: { q: 1 },
      response_body: { error: 'gone' },
    })
    expect(reqs[0]!.request_headers).toMatchObject({ authorization: '[redacted]' })
    expect(reqs[0]!.response_headers).toMatchObject({ 'set-cookie': '[redacted]' })
  })

  it('skips successful XHR in errors mode and records it in all mode', () => {
    initInterceptors('errors')
    const ok = new FakeXhr()
    ok.open('GET', '/fine')
    ok.status = 200
    ok.send()
    expect(getNetworkRequests()).toHaveLength(0)

    initInterceptors('all')
    const ok2 = new FakeXhr()
    ok2.open('GET', '/fine')
    ok2.status = 200
    ok2.send()
    expect(getNetworkRequests()).toHaveLength(1)
  })
})
