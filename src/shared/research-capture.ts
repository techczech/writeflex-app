/**
 * Types shared by the main-process verb "Capture to research" (main/research-capture.ts) and the sheet
 * that asks for it. The kinds are the contract's (`scout capture --kind`).
 */
export const CAPTURE_KINDS = ['evidence', 'table', 'visualisation', 'snippet', 'search', 'widget'] as const
export type CaptureKind = (typeof CAPTURE_KINDS)[number]

export const CAPTURE_KIND_LABELS: Record<CaptureKind, string> = {
  evidence: 'Evidence',
  table: 'Table',
  visualisation: 'Visualisation',
  snippet: 'Snippet',
  search: 'Search result',
  widget: 'Widget',
}

/** What the sheet sends. `project` is the open Piece's path; main finds the Folio or folder from it. */
export type CaptureRequest = {
  project: string
  title: string
  kind: CaptureKind
  prompt?: string
  body: string
}

/** `file` is Workspace-relative. */
export type CaptureResponse =
  | { ok: true; file: string; project: string; corpus: string | null; indexed: boolean }
  | { ok: false; code: 'invalid' | 'scout-missing' | 'not-a-directory' | 'capture-failed' | 'unreadable-output' | 'writes-paused'; message: string }
