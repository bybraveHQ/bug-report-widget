# bug-report-widget

Переносимая кнопка bug report: скриншот страницы, аннотации (rect / arrow / pencil / text), перехват console-ошибок и упавших network-запросов, отправка на ваш эндпоинт. Один JS-файл, Shadow DOM — стили хост-страницы не влияют и не ломаются. Не требует React/Tailwind в проекте-потребителе.

Извлечён из TestCaseLab (`frontend/src/components/report/`), внутри Preact + Tailwind v4, скомпилированные в бандл.

## Сборка

```bash
npm install
npm run build   # dist/bug-report-widget.iife.js (script tag) + dist/bug-report-widget.js (ESM)
npm run dev     # demo-страница на http://localhost:5173 с мок-эндпоинтом
```

## Подключение

### Вариант 1 — script tag (любой стек)

```html
<script
  src="/bug-report-widget.iife.js"
  data-endpoint="/api/reports"
></script>
```

Атрибуты: `data-endpoint` (обязателен), `data-hotkey="false"` (отключить Cmd/Ctrl+B), `data-credentials="include"`.

Ручная инициализация вместо атрибутов:

```html
<script src="/bug-report-widget.iife.js"></script>
<script>
  BugReport.init({ endpoint: '/api/reports' })
</script>
```

### Вариант 2 — npm / ESM (React, Next.js, Vue, что угодно)

```bash
npm install github:bybraveHQ/bug-report-widget
# или локально: "bug-report-widget": "file:../bug-report-widget"
```

```ts
import { init, destroy } from 'bug-report-widget'

init({ endpoint: '/api/reports' })
```

В Next.js — вызвать в client-компоненте внутри `useEffect` (виджет работает только в браузере):

```tsx
'use client'
import { useEffect } from 'react'
import { init, destroy } from 'bug-report-widget'

export function BugReportLoader() {
  useEffect(() => {
    init({ endpoint: '/api/reports' })
    return destroy
  }, [])
  return null
}
```

### Конфиг

```ts
init({
  endpoint: '/api/reports',        // обязателен
  headers: { 'X-Api-Key': '...' }, // опционально
  credentials: 'include',          // опционально (RequestCredentials)
  hotkey: true,                    // Cmd/Ctrl+B, по умолчанию true
  labels: { send: 'Отправить' },   // частичный override любых надписей
})
```

## Контракт бэкенда

`POST {endpoint}`, `multipart/form-data`:

| Поле | Тип | Описание |
|---|---|---|
| `screenshot` | file (PNG) | скриншот с аннотациями |
| `url` | string | адрес страницы |
| `page_title` | string | заголовок страницы |
| `description` | string | текст репорта |
| `type` | string | `bug` \| `improvement` |
| `console_logs` | string (JSON) | последние warn/error из console |
| `network_requests` | string (JSON) | упавшие запросы (status ≥ 400 или network error) |

Успех — любой 2xx. Совместим с существующим эндпоинтом TestCaseLab (`backend/app/api/reports.py`).

### Пример route handler для Next.js

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

## Возможности

- Плавающая перетаскиваемая кнопка (позиция сохраняется в localStorage)
- Хоткей Cmd/Ctrl+B
- Скриншот через `html-to-image` (без разрешений браузера)
- Инструменты: выделение/перемещение, прямоугольник, стрелка, карандаш, текст; Undo (Cmd/Ctrl+Z), Clear
- Тип репорта: Bug / Improvement
- Перехват console warn/error (до 100) и упавших fetch-запросов (до 50), суммарный лимит 512 KB
