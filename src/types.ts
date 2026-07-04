export interface Labels {
  buttonTitle: string
  typeBug: string
  typeImprovement: string
  toggleBug: string
  toggleImprovement: string
  toolMove: string
  toolRect: string
  toolArrow: string
  toolPencil: string
  toolText: string
  undo: string
  clear: string
  placeholderBug: string
  placeholderImprovement: string
  send: string
  sent: string
  download: string
  destinationTitle: string
  cancel: string
  ok: string
  close: string
  textSizeDecrease: string
  textSizeIncrease: string
  strokeWidth: string
  errorCapture: string
  errorPrepare: string
  errorSend: string
}

export type ButtonPosition =
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | { x: number; y: number }

export interface SubmitInfo {
  type: 'bug' | 'improvement'
  description: string
  destination: 'endpoint' | 'download'
}

export interface BugReportConfig {
  /** Endpoint URL accepting the multipart/form-data report. Required unless `destination` is 'download' */
  endpoint?: string
  /**
   * Default report destination: POST to `endpoint` or a .zip download to the
   * user's computer. When `endpoint` is set the user can switch destinations
   * from the widget toolbar; without `endpoint` only 'download' is available.
   */
  destination?: 'endpoint' | 'download'
  /**
   * Allow saving the report as a .zip download, enabled by default. Set to
   * false to hide the destination picker and always send to `endpoint`
   * (requires `endpoint`).
   */
  download?: boolean
  /** Network capture: only failed requests ('errors', default) or every request ('all') */
  network?: 'errors' | 'all'
  headers?: Record<string, string>
  credentials?: RequestCredentials
  /**
   * Cmd/Ctrl+B hotkey, enabled by default. False disables it; a single
   * letter/digit picks another key (e.g. 'k' → Cmd/Ctrl+K).
   */
  hotkey?: boolean | string
  /**
   * Initial position of the floating button: an edge/corner preset or exact
   * pixel coordinates ({ x, y } of the top-left corner). Once the user drags
   * the button, the dragged position is stored in localStorage and wins.
   */
  position?: ButtonPosition
  /** Called after a report is successfully sent or downloaded */
  onSubmit?: (report: SubmitInfo) => void
  /** Called when preparing or sending a report fails */
  onError?: (error: unknown) => void
  /** JPEG quality of the screenshot, 0–1 (default 0.85) */
  screenshotQuality?: number
  labels?: Partial<Labels>
}

export interface ResolvedConfig {
  endpoint?: string
  destination: 'endpoint' | 'download'
  download: boolean
  network: 'errors' | 'all'
  headers?: Record<string, string>
  credentials?: RequestCredentials
  /** Normalized hotkey: an uppercase letter/digit, or false when disabled */
  hotkey: string | false
  position: ButtonPosition
  onSubmit?: (report: SubmitInfo) => void
  onError?: (error: unknown) => void
  screenshotQuality: number
  labels: Labels
}

export const defaultLabels: Labels = {
  buttonTitle: 'Report a bug (Cmd/Ctrl+B)',
  typeBug: 'Bug',
  typeImprovement: 'Improvement',
  toggleBug: 'Bug',
  toggleImprovement: 'Idea',
  toolMove: 'Move',
  toolRect: 'Rect',
  toolArrow: 'Arrow',
  toolPencil: 'Pencil',
  toolText: 'Text',
  undo: 'Undo',
  clear: 'Clear',
  placeholderBug: 'Describe the bug...',
  placeholderImprovement: 'Describe the improvement...',
  send: 'Send',
  sent: 'Sent',
  download: 'Download',
  destinationTitle: 'Where to save the report',
  cancel: 'Cancel',
  ok: 'OK',
  close: 'Close',
  textSizeDecrease: 'Smaller text',
  textSizeIncrease: 'Larger text',
  strokeWidth: 'Line thickness',
  errorCapture: 'Screenshot failed',
  errorPrepare: 'Failed to prepare image',
  errorSend: 'Failed to send',
}
