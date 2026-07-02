# Standalone bug report widget
Дата: 02-07-2026
Статус: done
Прогресс: 3 / 3 этапов

Извлечение bug report кнопки из TestCaseLab в самостоятельный виджет: один JS-файл, Shadow DOM, подключение script-тегом или через npm.

## ✅ Этап 1 — Собрать каркас проекта
- [x] Vite (lib mode, IIFE + ESM), Preact, Tailwind v4 через PostCSS
- [x] tsconfig strict + noUncheckedIndexedAccess, декларации типов
- [x] Demo-страница с мок-эндпоинтом /api/reports

## ✅ Этап 2 — Портировать виджет
- [x] geometry.ts и capture-interceptors.ts — без изменений
- [x] ReportButton → widget.tsx на Preact (onInput, focus через ref/effect вместо flushSync, composedPath для hotkey в shadow DOM)
- [x] index.ts: init/destroy, Shadow DOM, автоинициализация из data-атрибутов
- [x] Отправка через fetch по конфигу endpoint/headers/credentials, тот же FormData-контракт

## ✅ Этап 3 — Проверить и задокументировать
- [x] npm run build без ошибок, IIFE самодостаточный (html-to-image и CSS внутри)
- [x] Playwright-смоук: монтирование, стили в shadow, скриншот, рисование, POST 201, Sent!, хоткей
- [x] README: подключение (script tag / npm / Next.js), контракт бэкенда, пример route handler
