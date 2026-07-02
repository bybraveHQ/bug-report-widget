# bug-report-widget

Portable bug report button: page screenshot, annotations (rect / arrow / pencil / text), capture of console errors and failed network requests, submission to your endpoint. A single JS file, Shadow DOM — host page styles don't leak in or break. No React/Tailwind required in the consuming project.

Preact + Tailwind v4 inside, compiled into the bundle.

## Build

```bash
npm install
npm run build   # dist/bug-report-widget.iife.js (script tag) + dist/bug-report-widget.js (ESM)
npm run dev     # demo page at http://localhost:5173 with a mock endpoint
```

## Usage

### Option 1 — script tag (any stack)

```html
<script
  src="/bug-report-widget.iife.js"
  data-endpoint="/api/reports"
></script>
```

Attributes: `data-endpoint` (required), `data-hotkey="false"` (disable Cmd/Ctrl+B), `data-credentials="include"`.

Manual initialization instead of attributes:

```html
<script src="/bug-report-widget.iife.js"></script>
<script>
  BugReport.init({ endpoint: '/api/reports' })
</script>
```

### Option 2 — npm / ESM (React, Next.js, Vue, anything)

```bash
npm install @bybrave/bug-report-widget
```

```ts
import { init, destroy } from '@bybrave/bug-report-widget'

init({ endpoint: '/api/reports' })
```

In Next.js — call it in a client component inside `useEffect` (the widget is browser-only):

```tsx
'use client'
import { useEffect } from 'react'
import { init, destroy } from '@bybrave/bug-report-widget'

export function BugReportLoader() {
  useEffect(() => {
    init({ endpoint: '/api/reports' })
    return destroy
  }, [])
  return null
}
```

### Config

```ts
init({
  endpoint: '/api/reports',        // required
  headers: { 'X-Api-Key': '...' }, // optional
  credentials: 'include',          // optional (RequestCredentials)
  hotkey: true,                    // Cmd/Ctrl+B, defaults to true
  labels: { send: 'Submit' },      // partial override of any label
})
```

## Backend contract

`POST {endpoint}`, `multipart/form-data`:

| Field | Type | Description |
|---|---|---|
| `screenshot` | file (PNG) | screenshot with annotations |
| `url` | string | page URL |
| `page_title` | string | page title |
| `description` | string | report text |
| `type` | string | `bug` \| `improvement` |
| `console_logs` | string (JSON) | recent warn/error console entries |
| `network_requests` | string (JSON) | failed requests (status ≥ 400 or network error) |

Any 2xx response is treated as success.

### Example route handler for Next.js

```ts
// app/api/reports/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const screenshot = form.get('screenshot') as File
  const id = `report_${new Date().toISOString().replace(/[:.]/g, '-')}`
  const dir = path.join(process.cwd(), 'reports', 'new')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${id}.png`), Buffer.from(await screenshot.arrayBuffer()))
  await writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify(
      {
        id,
        timestamp: new Date().toISOString(),
        url: form.get('url'),
        page_title: form.get('page_title'),
        description: form.get('description'),
        type: form.get('type'),
        console_logs: JSON.parse((form.get('console_logs') as string) || '[]'),
        network_requests: JSON.parse((form.get('network_requests') as string) || '[]'),
        status: 'new',
      },
      null,
      2,
    ),
  )
  return NextResponse.json({ id }, { status: 201 })
}
```

## Features

- Floating draggable button (position persisted in localStorage)
- Cmd/Ctrl+B hotkey
- Screenshot via `html-to-image` (no browser permissions needed)
- Tools: select/move, rectangle, arrow, pencil, text; Undo (Cmd/Ctrl+Z), Clear
- Report type: Bug / Improvement
- Captures console warn/error (up to 100) and failed fetch requests (up to 50), 512 KB total cap
