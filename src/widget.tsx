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
  Video,
  Download,
  Minus,
  Plus,
  ChevronDown,
  Check,
  Monitor,
  AppWindow,
  PanelTop,
  Mic,
} from 'lucide-preact'
import { createZip, type ZipEntry } from './zip'
import { type Annotation, type RectAnn, type ArrowAnn, hitTest, moveAnnotation } from './geometry'
import { initInterceptors, getConsoleLogs, getNetworkRequests } from './capture-interceptors'
import type { ResolvedConfig } from './types'

type Phase = 'idle' | 'capturing' | 'annotating' | 'recording'
type Tool = 'cursor' | 'rect' | 'arrow' | 'pencil' | 'text'
type ReportType = 'bug' | 'improvement'

interface Point {
  x: number
  y: number
}

type PencilAnn = { tool: 'pencil'; points: Point[] }
type LiveDraw = RectAnn | ArrowAnn | PencilAnn

const STORAGE_KEY = 'bug-report-widget-pos'
const DEST_STORAGE_KEY = 'bug-report-widget-dest'
const REC_STORAGE_KEY = 'bug-report-widget-rec'

// Floating button footprint used to clamp its position to the viewport
const BUTTON_SIZE_PX = 48

type RecordSource = 'monitor' | 'window' | 'browser'

function loadRecordSettings(): { source: RecordSource; mic: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(REC_STORAGE_KEY) ?? '{}')
    return {
      source: ['monitor', 'window', 'browser'].includes(saved.source) ? saved.source : 'monitor',
      mic: saved.mic === true,
    }
  } catch {
    return { source: 'monitor', mic: false }
  }
}

// Keep the success state visible just long enough to register, then get out
// of the user's way.
const SENT_LINGER_MS = 800

const VIDEO_MAX_SEC = 60
const NOTICE_LINGER_MS = 5000
const TEXT_SIZE_DEFAULT = 18
const TEXT_SIZE_MIN = 8
const TEXT_SIZE_MAX = 72
const TEXT_SIZE_HOLD_DELAY_MS = 350
const TEXT_SIZE_HOLD_INTERVAL_MS = 50
const TEXT_INPUT_PADDING_PX = 8

// `field-sizing: content` is Chromium-only, so the annotation text input is
// sized manually: width from measuring the text, height from scrollHeight.
let measureCtx: CanvasRenderingContext2D | null = null
function measureTextWidth(text: string, fontSize: number): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  measureCtx.font = `bold ${fontSize}px sans-serif`
  return Math.max(0, ...text.split('\n').map((line) => measureCtx!.measureText(line).width))
}

function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

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
  const ctx = out.getContext('2d')!
  // If the document is shorter than the viewport, the uncovered area stays
  // transparent and turns black in the JPEG export — pre-fill with the page
  // background instead.
  const bodyBg = getComputedStyle(document.body).backgroundColor
  ctx.fillStyle = bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' ? bodyBg : '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(
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
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: Annotation | LiveDraw,
  reportType: ReportType,
  selected = false,
) {
  const color = selected ? '#3b82f6' : reportType === 'bug' ? '#ef4444' : '#eab308'
  ctx.strokeStyle = color
  ctx.fillStyle = color
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

interface ReportData {
  screenshot: Blob
  video: Blob | null
  description: string
  type: ReportType
  consoleLogs: string
  networkRequests: string
}

// Environment snapshot attached to every report
function collectMeta() {
  return {
    user_agent: navigator.userAgent,
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    device_pixel_ratio: window.devicePixelRatio,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

async function submitReport(config: ResolvedConfig, data: ReportData): Promise<void> {
  const form = new FormData()
  form.append('screenshot', data.screenshot, 'screenshot.jpg')
  if (data.video) form.append('video', data.video, 'video.webm')
  form.append('url', window.location.href)
  form.append('page_title', document.title)
  form.append('description', data.description)
  form.append('type', data.type)
  form.append('console_logs', data.consoleLogs)
  form.append('network_requests', data.networkRequests)
  form.append('meta', JSON.stringify(collectMeta()))
  const res = await fetch(config.endpoint!, {
    method: 'POST',
    body: form,
    headers: config.headers,
    credentials: config.credentials,
  })
  if (!res.ok) throw new Error(`Report submit failed: ${res.status}`)
}

async function downloadReport(data: ReportData): Promise<void> {
  const report = {
    url: window.location.href,
    page_title: document.title,
    type: data.type,
    description: data.description,
    created_at: new Date().toISOString(),
    meta: collectMeta(),
    console_logs: JSON.parse(data.consoleLogs),
    network_requests: JSON.parse(data.networkRequests),
  }
  const entries: ZipEntry[] = [
    { name: 'screenshot.jpg', data: new Uint8Array(await data.screenshot.arrayBuffer()) },
    { name: 'report.json', data: new TextEncoder().encode(JSON.stringify(report, null, 2)) },
  ]
  if (data.video) {
    entries.push({ name: 'video.webm', data: new Uint8Array(await data.video.arrayBuffer()) })
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const url = URL.createObjectURL(createZip(entries))
  const a = document.createElement('a')
  a.href = url
  a.download = `bug-report-${stamp}.zip`
  a.click()
  // Revoke after the download has had a chance to start
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
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
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [cursorDragging, setCursorDragging] = useState(false)
  const [textSize, setTextSize] = useState(TEXT_SIZE_DEFAULT)
  const textSizeRef = useRef(TEXT_SIZE_DEFAULT)
  const textSizeHoldRef = useRef<{
    delay: ReturnType<typeof setTimeout> | null
    interval: ReturnType<typeof setInterval> | null
    repeated: boolean
  }>({ delay: null, interval: null, repeated: false })
  const [destination, setDestination] = useState<'endpoint' | 'download'>(() => {
    if (!config.endpoint) return 'download'
    if (!config.download) return 'endpoint'
    try {
      const saved = localStorage.getItem(DEST_STORAGE_KEY)
      if (saved === 'endpoint' || saved === 'download') return saved
    } catch {
      /* ignore */
    }
    return config.destination
  })
  const [destMenuOpen, setDestMenuOpen] = useState(false)
  const [recSettings, setRecSettings] = useState(loadRecordSettings)
  const [recMenuOpen, setRecMenuOpen] = useState(false)
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null)
  const [videoDurationSec, setVideoDurationSec] = useState(0)
  const [recordElapsed, setRecordElapsed] = useState(0)

  const buttonRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [canvasCss, setCanvasCss] = useState<{ w: number; h: number } | null>(null)
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
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordStreamRef = useRef<MediaStream | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordStartedAtRef = useRef(0)
  const recordLimitHitRef = useRef(false)
  useEffect(() => {
    pendingTextRef.current = pendingText
  }, [pendingText])

  // Re-measure on font size changes too, or the text overflows the underline
  useEffect(() => {
    const el = textInputRef.current
    if (!el) return
    const width = measureTextWidth(pendingText?.value ?? '', textSize) + TEXT_INPUT_PADDING_PX
    el.style.width = Math.ceil(width) + 'px' // min-w/max-w classes clamp it
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [pendingText?.value, textSize])

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
          x: Math.max(0, Math.min(window.innerWidth - BUTTON_SIZE_PX, p.x)),
          y: Math.max(0, Math.min(window.innerHeight - BUTTON_SIZE_PX, p.y)),
        })
      } else {
        setPos({ x: 24, y: Math.round(window.innerHeight / 2) })
      }
    } catch {
      /* ignore */
    }
  }, [])

  // Keep the button inside the viewport when the window shrinks
  useEffect(() => {
    const clamp = () =>
      setPos((p) =>
        p
          ? {
              x: Math.max(0, Math.min(window.innerWidth - BUTTON_SIZE_PX, p.x)),
              y: Math.max(0, Math.min(window.innerHeight - BUTTON_SIZE_PX, p.y)),
            }
          : p,
      )
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  const handleButtonPointerDown = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLButtonElement>) => {
      hasDragged.current = false
      dragStart.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        btnX: pos?.x ?? 24,
        btnY: pos?.y ?? 0,
      }

      const onMove = (ev: PointerEvent) => {
        if (!dragStart.current) return
        const dx = ev.clientX - dragStart.current.mouseX
        const dy = ev.clientY - dragStart.current.mouseY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged.current = true
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - BUTTON_SIZE_PX, dragStart.current.btnX + dx)),
          y: Math.max(0, Math.min(window.innerHeight - BUTTON_SIZE_PX, dragStart.current.btnY + dy)),
        })
      }
      const onUp = () => {
        setPos((p) => {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
          return p
        })
        dragStart.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
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
      setNotice(null)
      setSelectedIndex(null)
      setVideoBlob(null)
      setVideoDurationSec(0)
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

  useEffect(() => { initInterceptors(config.network) }, [config.network])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_LINGER_MS)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    if (!destMenuOpen && !recMenuOpen) return
    const close = () => {
      setDestMenuOpen(false)
      setRecMenuOpen(false)
    }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [destMenuOpen, recMenuOpen])

  const updateRecSettings = (patch: Partial<typeof recSettings>) => {
    setRecSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(REC_STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }, [])

  const startRecording = useCallback(async () => {
    if (phase !== 'annotating' || recorderRef.current) return
    let stream: MediaStream
    try {
      // displaySurface is a hint: the share picker opens with that tab preselected,
      // the user can still switch to another source
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: recSettings.source },
        audio: false,
      })
    } catch {
      return // user dismissed the share picker
    }
    if (recSettings.mic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        mic.getAudioTracks().forEach((t) => stream.addTrack(t))
      } catch {
        /* mic denied — record without sound */
      }
    }
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm'
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime })
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      setError(T.errorRecord)
      return
    }

    recorderRef.current = recorder
    recordStreamRef.current = stream
    recordChunksRef.current = []
    recordLimitHitRef.current = false
    recordStartedAtRef.current = Date.now()
    setRecordElapsed(0)

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordChunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
      stream.getTracks().forEach((t) => t.stop())
      recorderRef.current = null
      recordStreamRef.current = null
      const blob = new Blob(recordChunksRef.current, { type: mime })
      recordChunksRef.current = []
      if (blob.size > 0) {
        setVideoBlob(blob)
        setVideoDurationSec(
          Math.min(Math.round((Date.now() - recordStartedAtRef.current) / 1000), VIDEO_MAX_SEC),
        )
      }
      if (recordLimitHitRef.current) setNotice(T.videoLimitReached)
      setPhase('annotating')
    }
    // The user can also stop sharing via the browser's own UI
    stream.getVideoTracks()[0]?.addEventListener('ended', stopRecording)

    recordTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - recordStartedAtRef.current) / 1000
      setRecordElapsed(elapsed)
      if (elapsed >= VIDEO_MAX_SEC) {
        recordLimitHitRef.current = true
        stopRecording()
      }
    }, 250)

    recorder.start()
    setError(null)
    setNotice(null)
    setPhase('recording')
  }, [phase, stopRecording, T.errorRecord, T.videoLimitReached, recSettings])

  // Release the capture stream if the widget unmounts mid-recording
  useEffect(() => stopRecording, [stopRecording])

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
      // e.code, not e.key: the hotkey has to work on non-latin keyboard layouts
      if ((!e.metaKey && !e.ctrlKey) || e.code !== 'KeyB') return
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

  // Scale the canvas to the stage width (up or down, aspect kept): the capture
  // is viewport-wide, so width-fit leaves no side bars — the toolbar-height
  // overflow just scrolls. Explicit CSS pixel sizes keep getBoundingClientRect
  // matching the drawing buffer, which the mouse→canvas math in getXY relies on.
  const fitCanvas = useCallback(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas || !canvas.width || !canvas.height) return
    const scale = stage.clientWidth / canvas.width
    setCanvasCss({ w: canvas.width * scale, h: canvas.height * scale })
  }, [])

  useEffect(() => {
    if (phase !== 'annotating') return
    window.addEventListener('resize', fitCanvas)
    return () => window.removeEventListener('resize', fitCanvas)
  }, [phase, fitCanvas])

  useEffect(() => {
    if (phase !== 'annotating' || !screenshotDataUrl || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.onload = () => {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      fitCanvas()
      ctx.drawImage(img, 0, 0)
      annotations.forEach((ann, i) => drawAnnotation(ctx, ann, reportType, i === selectedIndex))
      if (liveDraw) drawAnnotation(ctx, liveDraw, reportType)
    }
    img.src = screenshotDataUrl
  }, [phase, screenshotDataUrl, annotations, liveDraw, selectedIndex, reportType, fitCanvas])

  const getXY = (e: JSX.TargetedPointerEvent<HTMLCanvasElement>): Point => {
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
    return Math.round((textSize * canvas.width) / rect.width)
  }

  const selectDestination = (d: 'endpoint' | 'download') => {
    setDestination(d)
    setDestMenuOpen(false)
    try {
      localStorage.setItem(DEST_STORAGE_KEY, d)
    } catch {
      /* ignore */
    }
  }

  const adjustTextSize = (delta: number): boolean => {
    const next = Math.max(TEXT_SIZE_MIN, Math.min(TEXT_SIZE_MAX, textSizeRef.current + delta))
    if (next === textSizeRef.current) return false
    textSizeRef.current = next
    setTextSize(next)
    const canvas = canvasRef.current
    if (canvas && pendingTextRef.current) {
      const rect = canvas.getBoundingClientRect()
      const fontSize = Math.round((next * canvas.width) / rect.width)
      setPendingText((p) => (p ? { ...p, fontSize } : p))
    }
    return true
  }

  const startTextSizeHold = (delta: number) => {
    stopTextSizeHold()
    textSizeHoldRef.current.repeated = false
    textSizeHoldRef.current.delay = setTimeout(() => {
      textSizeHoldRef.current.interval = setInterval(() => {
        textSizeHoldRef.current.repeated = true
        if (!adjustTextSize(delta)) stopTextSizeHold()
      }, TEXT_SIZE_HOLD_INTERVAL_MS)
    }, TEXT_SIZE_HOLD_DELAY_MS)
  }

  const stopTextSizeHold = () => {
    const hold = textSizeHoldRef.current
    if (hold.delay !== null) clearTimeout(hold.delay)
    if (hold.interval !== null) clearInterval(hold.interval)
    hold.delay = null
    hold.interval = null
  }

  useEffect(() => stopTextSizeHold, [])

  const clickTextSize = (delta: number) => {
    if (textSizeHoldRef.current.repeated) {
      textSizeHoldRef.current.repeated = false
      return
    }
    adjustTextSize(delta)
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

  const onCanvasDown = (e: JSX.TargetedPointerEvent<HTMLCanvasElement>) => {
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
        // Keep receiving moves when the pointer leaves the canvas mid-drag
        e.currentTarget.setPointerCapture(e.pointerId)
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
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onCanvasMove = (e: JSX.TargetedPointerEvent<HTMLCanvasElement>) => {
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

  const onCanvasUp = (e: JSX.TargetedPointerEvent<HTMLCanvasElement>) => {
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
        const data = {
          screenshot: blob,
          video: videoBlob,
          description,
          type: reportType,
          consoleLogs: logsJson,
          networkRequests: netJson,
        }
        if (destination === 'download') await downloadReport(data)
        else await submitReport(config, data)
        setSent(true)
        setTimeout(() => {
          setPhase('idle')
          setSent(false)
        }, SENT_LINGER_MS)
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
      {pos && phase !== 'recording' && (
        <button
          ref={buttonRef}
          onPointerDown={handleButtonPointerDown}
          onClick={handleClick}
          style={{ left: pos.x, top: pos.y }}
          className="fixed z-50 w-11 h-11 rounded-full bg-red-600 hover:bg-red-500 active:bg-red-700 active:scale-95 text-white shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing transition-colors transition-transform select-none touch-none"
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
            {tool === 'text' && (
              <div className="flex items-center rounded overflow-hidden border border-gray-600">
                <button
                  onClick={() => clickTextSize(-1)}
                  onPointerDown={() => startTextSizeHold(-1)}
                  onPointerUp={stopTextSizeHold}
                  onPointerLeave={stopTextSizeHold}
                  onPointerCancel={stopTextSizeHold}
                  aria-label={T.textSizeDecrease}
                  disabled={textSize <= TEXT_SIZE_MIN}
                  className="px-1.5 py-1 bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors active:scale-95 disabled:active:scale-100"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <span className="px-1.5 text-xs tabular-nums text-gray-300 select-none">
                  {textSize}
                </span>
                <button
                  onClick={() => clickTextSize(1)}
                  onPointerDown={() => startTextSizeHold(1)}
                  onPointerUp={stopTextSizeHold}
                  onPointerLeave={stopTextSizeHold}
                  onPointerCancel={stopTextSizeHold}
                  aria-label={T.textSizeIncrease}
                  disabled={textSize >= TEXT_SIZE_MAX}
                  className="px-1.5 py-1 bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors active:scale-95 disabled:active:scale-100"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            )}
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
            {config.video && (
              <div className="relative flex items-stretch">
                <button
                  onClick={startRecording}
                  title={T.recordVideo}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-l text-xs font-medium border border-red-500/50 bg-red-500/15 text-red-300 hover:bg-red-500/30 hover:text-red-200 transition-colors active:scale-95"
                >
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  {T.record}
                  <span className="text-red-400/70 font-normal">{formatSeconds(VIDEO_MAX_SEC)}</span>
                </button>
                <button
                  title={T.recordSettingsTitle}
                  onClick={() => setRecMenuOpen((o) => !o)}
                  className="flex items-center px-1 rounded-r border border-l-0 border-red-500/50 bg-red-500/15 text-red-300 hover:bg-red-500/30 transition-colors active:scale-95"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
                {recMenuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute left-0 top-full mt-1 z-20 min-w-[170px] rounded-lg border border-gray-700 bg-gray-900 shadow-xl overflow-hidden"
                  >
                    {(
                      [
                        ['monitor', T.sourceScreen, <Monitor className="w-3 h-3" />],
                        ['window', T.sourceWindow, <AppWindow className="w-3 h-3" />],
                        ['browser', T.sourceTab, <PanelTop className="w-3 h-3" />],
                      ] as const
                    ).map(([source, label, icon]) => (
                      <button
                        key={source}
                        onClick={() => updateRecSettings({ source })}
                        className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors"
                      >
                        {icon} {label}
                        {recSettings.source === source && <Check className="w-3 h-3 ml-auto" />}
                      </button>
                    ))}
                    <div className="border-t border-gray-700" />
                    <button
                      onClick={() => updateRecSettings({ mic: !recSettings.mic })}
                      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors"
                    >
                      <Mic className="w-3 h-3" /> {T.microphone}
                      {recSettings.mic && <Check className="w-3 h-3 ml-auto" />}
                    </button>
                  </div>
                )}
              </div>
            )}
            {videoBlob && (
              <span className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-gray-800 border border-gray-600 text-gray-300">
                <Video className="w-3 h-3 text-red-400" />
                <span className="tabular-nums">{formatSeconds(videoDurationSec)}</span>
                <button
                  onClick={() => {
                    setVideoBlob(null)
                    setVideoDurationSec(0)
                  }}
                  title={T.removeVideo}
                  className="p-0.5 rounded hover:bg-gray-600 transition-colors active:scale-95"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
            <div className="flex-1" />
            <input
              value={description}
              readOnly
              onClick={() => setDescriptionOpen(true)}
              placeholder={reportType === 'bug' ? T.placeholderBug : T.placeholderImprovement}
              className={`bg-gray-800 text-white text-xs h-7 px-3 rounded w-64 cursor-pointer placeholder:text-gray-500 border transition-colors outline-none ${reportType === 'bug' ? 'border-red-500/60 hover:border-red-400 focus:border-red-400' : 'border-yellow-500/60 hover:border-yellow-400 focus:border-yellow-400'}`}
            />
            <div className="relative flex items-stretch">
              <button
                onClick={handleSubmit}
                disabled={submitting || sent}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium disabled:opacity-60 transition-colors active:scale-95 disabled:active:scale-100 ${config.endpoint && config.download ? 'rounded-l' : 'rounded'} ${reportType === 'bug' ? 'bg-red-600 hover:bg-red-500' : 'bg-yellow-600 hover:bg-yellow-500'}`}
              >
                {sent ? (
                  T.sent
                ) : submitting ? (
                  <Loader className="w-3 h-3 animate-spin" />
                ) : destination === 'download' ? (
                  <>
                    <Download className="w-3 h-3" /> {T.download}
                  </>
                ) : (
                  <>
                    <Send className="w-3 h-3" /> {T.send}
                  </>
                )}
              </button>
              {config.endpoint && config.download && (
                <button
                  title={T.destinationTitle}
                  onClick={() => setDestMenuOpen((o) => !o)}
                  className={`flex items-center px-1 rounded-r border-l transition-colors active:scale-95 ${reportType === 'bug' ? 'bg-red-600 hover:bg-red-500 border-red-800' : 'bg-yellow-600 hover:bg-yellow-500 border-yellow-800'}`}
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              )}
              {destMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 min-w-[150px] rounded-lg border border-gray-700 bg-gray-900 shadow-xl overflow-hidden">
                  <button
                    onClick={() => selectDestination('endpoint')}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    <Send className="w-3 h-3" /> {T.send}
                    {destination === 'endpoint' && <Check className="w-3 h-3 ml-auto" />}
                  </button>
                  <button
                    onClick={() => selectDestination('download')}
                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    <Download className="w-3 h-3" /> {T.download}
                    {destination === 'download' && <Check className="w-3 h-3 ml-auto" />}
                  </button>
                </div>
              )}
            </div>
            {error && <span className="text-xs text-red-400">{error}</span>}
            {notice && <span className="text-xs text-yellow-400">{notice}</span>}
            <button
              onClick={() => setPhase('idle')}
              aria-label={T.close}
              title={T.close}
              className="ml-1 p-1 rounded hover:bg-gray-700 transition-colors active:scale-95"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div
            ref={stageRef}
            className="flex-1 min-h-0 flex overflow-y-auto overflow-x-hidden bg-gray-900"
          >
            <canvas
              ref={canvasRef}
              onPointerDown={onCanvasDown}
              onPointerMove={onCanvasMove}
              onPointerUp={onCanvasUp}
              style={canvasCss ? { width: canvasCss.w, height: canvasCss.h } : undefined}
              className={`block m-auto ring-1 ring-white/10 touch-none ${canvasCursor}`}
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
                    aria-label={T.close}
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
              style={{
                left: pendingText.screenPos.x,
                top: pendingText.screenPos.y,
                fontSize: textSize,
              }}
              className={`fixed z-[10000] bg-transparent border-b-2 font-bold outline-none min-w-[80px] max-w-[50vw] resize-none overflow-hidden leading-tight ${reportType === 'bug' ? 'border-red-500 text-red-500' : 'border-yellow-500 text-yellow-500'}`}
              placeholder="..."
            />
          )}
        </div>
      )}

      {phase === 'recording' && (
        <>
          <div className="fixed inset-0 z-[9998] pointer-events-none border-4 border-red-500" />
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full bg-gray-900/95 text-white shadow-lg">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs tabular-nums">
              {formatSeconds(recordElapsed)} / {formatSeconds(VIDEO_MAX_SEC)}
            </span>
            <button
              onClick={stopRecording}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-red-600 hover:bg-red-500 transition-colors active:scale-95"
            >
              <Square className="w-3 h-3 fill-current" /> {T.stopRecording}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
