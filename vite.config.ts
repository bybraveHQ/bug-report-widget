import { defineConfig, type Plugin } from 'vite'

// Мок-эндпоинт для demo-страницы: принимает репорт и отвечает 201
function mockReportsEndpoint(): Plugin {
  return {
    name: 'mock-reports-endpoint',
    configureServer(server) {
      server.middlewares.use('/api/reports', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let size = 0
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
        })
        req.on('end', () => {
          console.log(`[mock] report received, ${Math.round(size / 1024)} KB`)
          res.statusCode = 201
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ id: 'demo_report' }))
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
