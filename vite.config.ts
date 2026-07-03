import { defineConfig, type Plugin } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface MultipartPart {
  name: string
  filename?: string
  data: Buffer
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delim = Buffer.from('--' + boundary)
  const parts: MultipartPart[] = []
  let pos = body.indexOf(delim)
  if (pos === -1) return parts
  pos += delim.length
  while (body.subarray(pos, pos + 2).toString() !== '--') {
    pos += 2 // CRLF after the delimiter
    const headerEnd = body.indexOf('\r\n\r\n', pos)
    if (headerEnd === -1) break
    const next = body.indexOf(delim, headerEnd)
    if (next === -1) break
    const headers = body.subarray(pos, headerEnd).toString()
    const name = /name="([^"]*)"/.exec(headers)?.[1] ?? ''
    const filename = /filename="([^"]*)"/.exec(headers)?.[1]
    parts.push({ name, filename, data: body.subarray(headerEnd + 4, next - 2) })
    pos = next + delim.length
  }
  return parts
}

// Demo endpoint: saves incoming reports to reports/new/<id>/ in the project
function mockReportsEndpoint(): Plugin {
  return {
    name: 'mock-reports-endpoint',
    configureServer(server) {
      // Real 404 for the demo "fetch 404" button — without this Vite serves
      // index.html with 200 for unknown paths and the error is never captured
      server.middlewares.use('/api/does-not-exist', (_req, res) => {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Not found', code: 404, hint: 'demo error response' }))
      })
      // JSON payload for the demo "fetch JSON" button — shows up as a parsed
      // Preview object in the report's network_requests
      server.middlewares.use('/api/demo-data', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('X-Demo-Header', 'bug-report-widget')
        res.end(
          JSON.stringify({
            user: { id: 7, name: 'Alice', roles: ['admin', 'qa'] },
            items: [
              { sku: 'A-100', price: 19.9, in_stock: true },
              { sku: 'B-205', price: 4.5, in_stock: false },
            ],
            meta: { page: 1, total: 2 },
          }),
        )
      })
      server.middlewares.use('/api/reports', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          const id = `report_${new Date().toISOString().replace(/[:.]/g, '-')}`
          try {
            const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1]
            if (!boundary) throw new Error('no multipart boundary')
            const parts = parseMultipart(Buffer.concat(chunks), boundary)
            const dir = path.join(process.cwd(), 'reports', 'new', id)
            mkdirSync(dir, { recursive: true })
            const fields: Record<string, unknown> = { id }
            for (const part of parts) {
              if (part.filename) {
                writeFileSync(path.join(dir, part.filename), part.data)
              } else {
                const text = part.data.toString()
                fields[part.name] =
                  part.name === 'console_logs' || part.name === 'network_requests'
                    ? JSON.parse(text || '[]')
                    : part.name === 'meta'
                      ? JSON.parse(text || '{}')
                      : text
              }
            }
            writeFileSync(path.join(dir, 'report.json'), JSON.stringify(fields, null, 2))
            console.log(`[reports] saved to reports/new/${id}`)
            res.statusCode = 201
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ id }))
          } catch (err) {
            console.error('[reports] failed to save:', err)
            res.statusCode = 500
            res.end()
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [mockReportsEndpoint()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'BugReport',
      formats: ['iife', 'es'],
      fileName: (format) =>
        format === 'es' ? 'bug-report-widget.js' : 'bug-report-widget.iife.js',
    },
  },
})
