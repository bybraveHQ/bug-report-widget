import { useRef, useState, useCallback, useEffect } from 'preact/hooks'
import type { JSX } from 'preact'
import {
  Bug,
  Lightbulb,
  Square,
  ArrowUpRight,
  Pencil,
  Type,
  Send,
  Loader,
  X,
  Undo2,
  MousePointer2,
  Trash2,
} from 'lucide-preact'
import { type Annotation, type RectAnn, type ArrowAnn, hitTest, moveAnnotation } from './geometry'
import { initInterceptors, getConsoleLogs, getNetworkRequests } from './capture-interceptors'
import type { ResolvedConfig } from './types'

type Phase = 'idle' | 'capturing' | 'annotating'
type Tool = 'cursor' | 'rect' | 'arrow' | 'pencil' | 'text'
type ReportType = 'bug' | 'improvement'

interface Point {
  x: number
  y: number
}

type PencilAnn = { tool: 'pencil'; points: Point[] }
type LiveDraw = RectAnn | ArrowAnn | PencilAnn

const STORAGE_KEY = 'bug-report-widget-pos'

async function captureViewport(): Promise<string> {
  const { snapdom } = await import('@zumer/snapdom')
  // The output is cropped to the viewport, so subtrees that start below it
  // don't need to be cloned at all — on long pages this is the difference
  // between seconds and sub-second capture. Content above the viewport is
  // kept: removing it would reflow the clone and break the crop offset.
  const vh = window.innerHeight
  const capture = await snapdom(document.documentElement, {
    embedFonts: true,
    filter: (el: Element) => el.getBoundingClientRect().top <= vh,
    filterMode: 'remove',
  })
  const full = await capture.toCanvas()
  // Crop the full-document render to what the user actually sees,
  // keeping devicePixelRatio scale.
  const dpr = window.devicePixelRatio || 1
  const out = document.createElement('canvas')
  out.width = Math.round(window.innerWidth * dpr)
  out.height = Math.round(vh * dpr)
  out.getContext('2d')!.drawImage(
    full,
    Math.round(window.scrollX * dpr),
    Math.round(window.scrollY * dpr),
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height,
  )
  return out.toDataURL('image/jpeg', 0.85)
}

// Events from shadow DOM are retargeted to the host — get the real element via composedPath
function isEditableTarget(e: Event): boolean {
  const target = e.composedPath()[0]
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: Annotation | LiveDraw,
  selected = false,
) {
  ctx.strokeStyle = selected ? '#3b82f6' : '#ef4444'
  ctx.fillStyle = selected ? '#3b82f6' : '#ef4444'
  ctx.lineWidth = selected ? 4 : 3
  ctx.setLineDash([])

  if (ann.tool === 'rect') {
    ctx.setLineDash([8, 4])
    ctx.strokeRect(ann.start.x, ann.start.y, ann.end.x - ann.start.x, ann.end.y - ann.start.y)
    ctx.setLineDash([])
  } else if (ann.tool === 'arrow') {
    ctx.beginPath()
    ctx.moveTo(ann.start.x, ann.start.y)
    ctx.lineTo(ann.end.x, ann.end.y)
    ctx.stroke()
    const angle = Math.atan2(ann.end.y - ann.start.y, ann.end.x - ann.start.x)
    const len = 14
    ctx.beginPath()
    ctx.moveTo(ann.end.x, ann.end.y)
    ctx.lineTo(
      ann.end.x - len * Math.cos(angle - Math.PI / 6),
      ann.end.y - len * Math.sin(angle - Math.PI / 6),
    )
    ctx.moveTo(ann.end.x, ann.end.y)
    ctx.lineTo(
      ann.end.x - len * Math.cos(angle + Math.PI / 6),
      ann.end.y - len * Math.sin(angle + Math.PI / 6),
    )
    ctx.stroke()
  } else if (ann.tool === 'pencil') {
    if (ann.points.length < 2) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(ann.points[0]!.x, ann.points[0]!.y)
    for (let i = 1; i < ann.points.length; i++) ctx.lineTo(ann.points[i]!.x, ann.points[i]!.y)
    ctx.stroke()
  } else if (ann.tool === 'text') {
    ctx.font = `bold ${ann.fontSize}px sans-serif`
    const lines = ann.text.split('\n')
    const lineHeight = ann.fontSize * 1.3
    lines.forEach((line, i) => ctx.fillText(line, ann.pos.x, ann.pos.y + i * lineHeight))
  }
}

async function submitReport(
  config: ResolvedConfig,
  data: {
    screenshot: Blob
    description: string
    type: ReportType
    consoleLogs: string
    networkRequests: string
  },
): Promise<void> {
  const form = new FormData()
  form.append('screenshot', data.screenshot, 'screenshot.jpg')
  form.append('url', window.location.href)
  form.append('page_title', document.title)
  form.append('description', data.description)
  form.append('type', data.type)
  form.append('console_logs', data.consoleLogs)
  form.append('network_requests', data.networkRequests)
  const res = await fetch(config.endpoint, {
    method: 'POST',
    body: form,
    headers: config.headers,
    credentials: config.credentials,
  })
  if (!res.ok) throw new Error(`Report submit failed: ${res.status}`)
}

export default function Widget({ config }: { config: ResolvedConfig }) {
  const T = config.labels
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('rect')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [liveDraw, setLiveDraw] = useState<LiveDraw | null>(null)
  const [pendingText, setPendingText] = useState<{
    canvasPos: Point
    screenPos: Point
    value: string
    fontSize: number
  } | null>(null)
  const [reportType, setReportType] = useState<ReportType>('bug')
  const [description, setDescription] = useState('')
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [cursorDragging, setCursorDragging] = useState(false)

  const buttonRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)
  const pendingTextRef = useRef<typeof pendingText>(null)
  const hasDragged = useRef(false)
  const dragStart = useRef<{ mouseX: number; mouseY: number; btnX: number; btnY: number } | null>(
    null,
  )
  const isDrawing = useRef(false)
  const drawStart = useRef<Point | null>(null)
  const pencilPoints = useRef<Point[]>([])
  const cursorDragOrigin = useRef<Point | null>(null)
  const cursorDragAnnSnap = useRef<Annotation | null>(null)
  const cursorDragIdx = useRef<number | null>(null)
  useEffect(() => {
    pendingTextRef.current = pendingText
  }, [pendingText])

  useEffect(() => {
    const el = textInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [pendingText?.value])

  // Focus the new text input (replaces flushSync + focus from the React version)
  useEffect(() => {
    if (pendingText) textInputRef.current?.focus()
  }, [pendingText?.canvasPos])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const p = JSON.parse(saved)
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - 48, p.x)),
          y: Math.max(0, Math.min(window.innerHeight - 48, p.y)),
        })
      } else {
        setPos({ x: 24, y: Math.round(window.innerHeight / 2) })
      }
    } catch {
      /* ignore */
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
      hasDragged.current = false
      dragStart.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        btnX: pos?.x ?? 24,
        btnY: pos?.y ?? 0,
      }

      const onMove = (ev: MouseEvent) => {
        if (!dragStart.current) return
        const dx = ev.clientX - dragStart.current.mouseX
        const dy = ev.clientY - dragStart.current.mouseY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged.current = true
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - 48, dragStart.current.btnX + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 48, dragStart.current.btnY + dy)),
        })
      }
      const onUp = () => {
        setPos((p) => {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
          return p
        })
        dragStart.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [pos],
  )

  const triggerCapture = useCallback(async () => {
    if (phase !== 'idle') return
    setPhase('capturing')
    if (buttonRef.current) buttonRef.current.style.visibility = 'hidden'
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    try {
      const dataUrl = await captureViewport()
      setScreenshotDataUrl(dataUrl)
      setAnnotations([])
      setLiveDraw(null)
      setPendingText(null)
      setDescription('')
      setDescriptionOpen(false)
      setReportType('bug')
      setSent(false)
      setError(null)
      setSelectedIndex(null)
      setPhase('annotating')
    } catch {
      setError(T.errorCapture)
      setPhase('idle')
    } finally {
      if (buttonRef.current) buttonRef.current.style.visibility = 'visible'
    }
  }, [phase])

  const handleClick = useCallback(async () => {
    if (hasDragged.current) return
    await triggerCapture()
  }, [triggerCapture])

  useEffect(() => { initInterceptors() }, [])

  // Warm up the capture chunk and font/image caches off the critical click path
  useEffect(() => {
    const warmUp = () =>
      void import('@zumer/snapdom')
        .then((m) => m.preCache(document.documentElement, { embedFonts: true }))
        .catch(() => {})
    if ('requestIdleCallback' in window) requestIdleCallback(warmUp)
    else setTimeout(warmUp, 2000)
  }, [])

  useEffect(() => {
    if (!descriptionOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setDescriptionOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [descriptionOpen])

  useEffect(() => {
    if (!config.hotkey) return
    const onKeyDown = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || e.key !== 'b') return
      if (isEditableTarget(e)) return
      e.preventDefault()
      triggerCapture()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [triggerCapture, config.hotkey])

  useEffect(() => {
    if (phase !== 'annotating') return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        setAnnotations((prev) => prev.slice(0, -1))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [phase])

  useEffect(() => {
    if (phase !== 'annotating' || !screenshotDataUrl || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.onload = () => {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      ctx.drawImage(img, 0, 0)
      annotations.forEach((ann, i) => drawAnnotation(ctx, ann, i === selectedIndex))
      if (liveDraw) drawAnnotation(ctx, liveDraw)
    }
    img.src = screenshotDataUrl
  }, [phase, screenshotDataUrl, annotations, liveDraw, selectedIndex])

  const getXY = (e: JSX.TargetedMouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const getTextFontSize = (): number => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return Math.round((18 * canvas.width) / rect.width)
  }

  const confirmText = useCallback(() => {
    const current = pendingTextRef.current
    if (!current) return
    pendingTextRef.current = null
    if (current.value.trim()) {
      setAnnotations((prev) => [
        ...prev,
        {
          tool: 'text',
          pos: current.canvasPos,
          text: current.value.trim(),
          fontSize: current.fontSize,
        },
      ])
    }
    setPendingText(null)
  }, [])

  const onCanvasDown = (e: JSX.TargetedMouseEvent<HTMLCanvasElement>) => {
    if (tool === 'cursor') {
      const p = getXY(e)
      let found = -1
      for (let i = annotations.length - 1; i >= 0; i--) {
        if (hitTest(annotations[i]!, p)) {
          found = i
          break
        }
      }
      setSelectedIndex(found === -1 ? null : found)
      if (found !== -1) {
        cursorDragOrigin.current = p
        cursorDragAnnSnap.current = annotations[found] ?? null
        cursorDragIdx.current = found
        isDrawing.current = true
        setCursorDragging(true)
      }
      return
    }

    if (tool === 'text') {
      const existing = pendingTextRef.current
      pendingTextRef.current = null
      const fontSize = getTextFontSize()
      if (existing?.value.trim()) {
        setAnnotations((prev) => [
          ...prev,
          {
            tool: 'text',
            pos: existing.canvasPos,
            text: existing.value.trim(),
            fontSize: existing.fontSize,
          },
        ])
      }
      setPendingText({
        canvasPos: getXY(e),
        screenPos: { x: e.clientX, y: e.clientY },
        value: '',
        fontSize,
      })
      return
    }

    isDrawing.current = true
    drawStart.current = getXY(e)
    if (tool === 'pencil') pencilPoints.current = [getXY(e)]
  }

  const onCanvasMove = (e: JSX.TargetedMouseEvent<HTMLCanvasElement>) => {
    if (
      tool === 'cursor' &&
      isDrawing.current &&
      cursorDragOrigin.current &&
      cursorDragAnnSnap.current &&
      cursorDragIdx.current !== null
    ) {
      const p = getXY(e)
      const dx = p.x - cursorDragOrigin.current.x
      const dy = p.y - cursorDragOrigin.current.y
      setAnnotations((prev) =>
        prev.map((ann, i) =>
          i === cursorDragIdx.current ? moveAnnotation(cursorDragAnnSnap.current!, dx, dy) : ann,
        ),
      )
      return
    }
    if (!isDrawing.current || !drawStart.current) return
    if (tool === 'pencil') {
      pencilPoints.current.push(getXY(e))
      setLiveDraw({ tool: 'pencil', points: [...pencilPoints.current] })
    } else {
      setLiveDraw({ tool, start: drawStart.current, end: getXY(e) } as RectAnn | ArrowAnn)
    }
  }

  const onCanvasUp = (e: JSX.TargetedMouseEvent<HTMLCanvasElement>) => {
    if (tool === 'cursor') {
      isDrawing.current = false
      setCursorDragging(false)
      cursorDragOrigin.current = null
      cursorDragAnnSnap.current = null
      cursorDragIdx.current = null
      return
    }
    if (tool === 'text') return
    if (!isDrawing.current || !drawStart.current) return
    isDrawing.current = false
    if (tool === 'pencil') {
      const points = [...pencilPoints.current]
      pencilPoints.current = []
      if (points.length > 1) setAnnotations((prev) => [...prev, { tool: 'pencil', points }])
    } else {
      const start = drawStart.current
      const end = getXY(e)
      setAnnotations((prev) => [...prev, { tool, start, end } as RectAnn | ArrowAnn])
    }
    drawStart.current = null
    setLiveDraw(null)
  }

  const handleSubmit = () => {
    if (!canvasRef.current) return
    setSubmitting(true)
    setError(null)
    canvasRef.current.toBlob(async (blob) => {
      if (!blob) {
        setError(T.errorPrepare)
        setSubmitting(false)
        return
      }
      const logs = getConsoleLogs()
      const net = getNetworkRequests()
      const MAX = 512 * 1024
      let logsJson = JSON.stringify(logs)
      let netJson = JSON.stringify(net)
      while (logsJson.length + netJson.length > MAX && (logs.length > 0 || net.length > 0)) {
        if (logs.length >= net.length) { logs.shift(); logsJson = JSON.stringify(logs) }
        else { net.shift(); netJson = JSON.stringify(net) }
      }
      try {
        await submitReport(config, {
          screenshot: blob,
          description,
          type: reportType,
          consoleLogs: logsJson,
          networkRequests: netJson,
        })
        setSent(true)
        setTimeout(() => {
          setPhase('idle')
          setSent(false)
        }, 1500)
      } catch {
        setError(T.errorSend)
      } finally {
        setSubmitting(false)
      }
    }, 'image/jpeg', 0.85)
  }

  const toolButtons = [
    { id: 'cursor' as const, icon: <MousePointer2 className="w-3 h-3" />, label: T.toolMove },
    { id: 'rect' as const, icon: <Square className="w-3 h-3" />, label: T.toolRect },
    { id: 'arrow' as const, icon: <ArrowUpRight className="w-3 h-3" />, label: T.toolArrow },
    { id: 'pencil' as const, icon: <Pencil className="w-3 h-3" />, label: T.toolPencil },
    { id: 'text' as const, icon: <Type className="w-3 h-3" />, label: T.toolText },
  ]

  const canvasCursor =
    tool === 'cursor'
      ? cursorDragging
        ? 'cursor-grabbing'
        : 'cursor-default'
      : tool === 'text'
        ? 'cursor-text'
        : 'cursor-crosshair'

  return (
    <div className="font-sans">
      {pos && (
        <button
          ref={buttonRef}
          onMouseDown={handleMouseDown}
          onClick={handleClick}
          style={{ left: pos.x, top: pos.y }}
          className="fixed z-50 w-11 h-11 rounded-full bg-red-600 hover:bg-red-500 active:bg-red-700 active:scale-95 text-white shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing transition-colors transition-transform select-none"
          title={T.buttonTitle}
        >
          {phase === 'capturing' ? (
            <Loader className="w-4 h-4 animate-spin" />
          ) : (
            <Bug className="w-4 h-4" />
          )}
        </button>
      )}

      {phase === 'annotating' && (
        <div className="fixed inset-0 z-[9999] bg-black flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 text-white shrink-0 flex-wrap">
            <div className="flex items-center gap-1.5 mr-1 min-w-[112px]">
              {reportType === 'bug' ? (
                <Bug className="w-4 h-4 text-red-400 shrink-0" />
              ) : (
                <Lightbulb className="w-4 h-4 text-yellow-400 shrink-0" />
              )}
              <span className={`text-sm font-semibold ${reportType === 'bug' ? 'text-red-400' : 'text-yellow-400'}`}>
                {reportType === 'bug' ? T.typeBug : T.typeImprovement}
              </span>
            </div>
            <div className="flex items-center rounded overflow-hidden border border-gray-600 mr-1">
              <button
                onClick={() => setReportType('bug')}
                className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors active:scale-95 ${reportType === 'bug' ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
              >
                <Bug className="w-3 h-3" /> {T.toggleBug}
              </button>
              <button
                onClick={() => setReportType('improvement')}
                className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors active:scale-95 ${reportType === 'improvement' ? 'bg-yellow-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
              >
                <Lightbulb className="w-3 h-3" /> {T.toggleImprovement}
              </button>
            </div>
            {toolButtons.map(({ id, icon, label }) => (
              <button
                key={id}
                onClick={() => {
                  confirmText()
                  setTool(id)
                  if (id !== 'cursor') setSelectedIndex(null)
                }}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors active:scale-95 ${tool === id ? (reportType === 'bug' ? 'bg-red-600 text-white' : 'bg-yellow-600 text-white') : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
              >
                {icon} {label}
              </button>
            ))}
            <button
              onClick={() => setAnnotations((prev) => prev.slice(0, -1))}
              disabled={annotations.length === 0}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors active:scale-95 disabled:active:scale-100"
            >
              <Undo2 className="w-3 h-3" /> {T.undo}
            </button>
            <button
              onClick={() => {
                setAnnotations([])
                setSelectedIndex(null)
              }}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors active:scale-95"
            >
              <Trash2 className="w-3 h-3" /> {T.clear}
            </button>
            <div className="flex-1" />
            <input
              value={description}
              readOnly
              onClick={() => setDescriptionOpen(true)}
              placeholder={reportType === 'bug' ? T.placeholderBug : T.placeholderImprovement}
              className={`bg-gray-800 text-white text-xs h-7 px-3 rounded w-64 cursor-pointer placeholder:text-gray-500 border transition-colors outline-none ${reportType === 'bug' ? 'border-red-500/60 hover:border-red-400 focus:border-red-400' : 'border-yellow-500/60 hover:border-yellow-400 focus:border-yellow-400'}`}
            />
            <button
              onClick={handleSubmit}
              disabled={submitting || sent}
              className={`flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-60 transition-colors active:scale-95 disabled:active:scale-100 ${reportType === 'bug' ? 'bg-red-600 hover:bg-red-500' : 'bg-yellow-600 hover:bg-yellow-500'}`}
            >
              {sent ? (
                T.sent
              ) : submitting ? (
                <Loader className="w-3 h-3 animate-spin" />
              ) : (
                <>
                  <Send className="w-3 h-3" /> {T.send}
                </>
              )}
            </button>
            {error && <span className="text-xs text-red-400">{error}</span>}
            <button
              onClick={() => setPhase('idle')}
              className="ml-1 p-1 rounded hover:bg-gray-700 transition-colors active:scale-95"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-auto">
            <canvas
              ref={canvasRef}
              onMouseDown={onCanvasDown}
              onMouseMove={onCanvasMove}
              onMouseUp={onCanvasUp}
              className={`block max-w-full ${canvasCursor}`}
            />
          </div>

          {descriptionOpen && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center bg-black/60"
            >
              <div
                className={`bg-gray-900 rounded-xl border w-full max-w-lg mx-4 p-4 shadow-2xl ${reportType === 'bug' ? 'border-red-500/50' : 'border-yellow-500/50'}`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className={`flex items-center gap-2 mb-3 text-sm font-semibold ${reportType === 'bug' ? 'text-red-400' : 'text-yellow-400'}`}>
                  {reportType === 'bug' ? <Bug className="w-4 h-4" /> : <Lightbulb className="w-4 h-4" />}
                  {reportType === 'bug' ? T.typeBug : T.typeImprovement}
                  <button
                    className="ml-auto p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors active:scale-95"
                    onClick={() => { setDescription(''); setDescriptionOpen(false) }}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <textarea
                  value={description}
                  onInput={(e) => setDescription(e.currentTarget.value)}
                  placeholder={reportType === 'bug' ? T.placeholderBug : T.placeholderImprovement}
                  className={`bg-gray-800 text-white text-sm border border-gray-700 rounded placeholder:text-gray-500 min-h-[120px] max-h-[50vh] overflow-y-auto w-full px-3 py-2 outline-none resize-none ${reportType === 'bug' ? 'focus:border-red-500' : 'focus:border-yellow-500'}`}
                  ref={(el) => el?.focus()}
                />
                <div className="flex justify-end gap-2 mt-3">
                  <button
                    onClick={() => { setDescription(''); setDescriptionOpen(false) }}
                    className="px-4 py-1.5 rounded text-xs text-gray-300 bg-gray-700 hover:bg-gray-600 transition-colors active:scale-95"
                  >
                    {T.cancel}
                  </button>
                  <button
                    onClick={() => setDescriptionOpen(false)}
                    className={`px-4 py-1.5 rounded text-xs font-medium text-white transition-colors active:scale-95 ${reportType === 'bug' ? 'bg-red-600 hover:bg-red-500' : 'bg-yellow-600 hover:bg-yellow-500'}`}
                  >
                    {T.ok}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* raw textarea: positioned over the canvas at mouse coordinates */}
          {pendingText && (
            <textarea
              ref={textInputRef}
              style={{ left: pendingText.screenPos.x, top: pendingText.screenPos.y }}
              value={pendingText.value}
              onInput={(e) => {
                const value = e.currentTarget.value
                setPendingText((p) => (p ? { ...p, value } : null))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.ctrlKey || e.metaKey) {
                    const el = e.currentTarget
                    const s = el.selectionStart ?? el.value.length
                    const end = el.selectionEnd ?? el.value.length
                    const next = el.value.slice(0, s) + '\n' + el.value.slice(end)
                    setPendingText((p) => (p ? { ...p, value: next } : null))
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = s + 1
                    })
                  } else {
                    confirmText()
                  }
                }
                if (e.key === 'Escape') {
                  pendingTextRef.current = null
                  setPendingText(null)
                }
              }}
              rows={1}
              className={`fixed z-[10000] bg-transparent border-b-2 font-bold text-lg outline-none min-w-[80px] resize-none overflow-hidden leading-tight ${reportType === 'bug' ? 'border-red-500 text-red-500' : 'border-yellow-500 text-yellow-500'}`}
              placeholder="..."
            />
          )}
        </div>
      )}
    </div>
  )
}
