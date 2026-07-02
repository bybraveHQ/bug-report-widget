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
  cancel: string
  ok: string
  errorCapture: string
  errorPrepare: string
  errorSend: string
}

export interface BugReportConfig {
  /** Endpoint URL accepting the multipart/form-data report */
  endpoint: string
  headers?: Record<string, string>
  credentials?: RequestCredentials
  /** Cmd/Ctrl+B hotkey, enabled by default */
  hotkey?: boolean
  labels?: Partial<Labels>
}

export interface ResolvedConfig {
  endpoint: string
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
  cancel: 'Cancel',
  ok: 'OK',
  errorCapture: 'Screenshot failed',
  errorPrepare: 'Failed to prepare image',
  errorSend: 'Failed to send',
}
