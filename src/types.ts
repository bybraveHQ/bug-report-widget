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
  record: string
  recordVideo: string
  stopRecording: string
  removeVideo: string
  videoLimitReached: string
  recordSettingsTitle: string
  sourceScreen: string
  sourceWindow: string
  sourceTab: string
  microphone: string
  errorCapture: string
  errorPrepare: string
  errorSend: string
  errorRecord: string
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
  /** Screen recording button (max 60s per recording), disabled by default */
  video?: boolean
  /** Network capture: only failed requests ('errors', default) or every request ('all') */
  network?: 'errors' | 'all'
  headers?: Record<string, string>
  credentials?: RequestCredentials
  /** Cmd/Ctrl+B hotkey, enabled by default */
  hotkey?: boolean
  labels?: Partial<Labels>
}

export interface ResolvedConfig {
  endpoint?: string
  destination: 'endpoint' | 'download'
  video: boolean
  network: 'errors' | 'all'
  headers?: Record<string, string>
  credentials?: RequestCredentials
  hotkey: boolean
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
  record: 'Record',
  recordVideo: 'Record video (max 1:00)',
  stopRecording: 'Stop',
  removeVideo: 'Remove video',
  videoLimitReached: 'Recording stopped: 1:00 limit reached',
  recordSettingsTitle: 'Recording settings',
  sourceScreen: 'Screen',
  sourceWindow: 'Window',
  sourceTab: 'This tab',
  microphone: 'Microphone',
  errorCapture: 'Screenshot failed',
  errorPrepare: 'Failed to prepare image',
  errorSend: 'Failed to send',
  errorRecord: 'Recording failed',
}
