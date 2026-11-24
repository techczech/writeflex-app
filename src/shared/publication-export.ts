export type EpubMetadata = { title: string; author: string; language: string }
export type EpubBuffer = { path: string; source: string; disk: string }
export type EpubPreparationOptions = {
  buffers?: readonly EpubBuffer[]
  metadata?: Partial<EpubMetadata>
  keepLineBreaks?: boolean
  omissions?: readonly string[]
  useExportOrder?: boolean
}
export type EpubProblemCode = 'outside-folio' | 'source' | 'stale' | 'empty' | 'order' | 'unwritten' | 'image' | 'alternative' | 'metadata' | 'destination' | 'generation'

export type EpubProblem = { code: EpubProblemCode; message: string; part?: string }
export type EpubPartSummary = {
  title: string
  role: 'title' | 'front' | 'chapter' | 'continues' | 'section'
  depth: number
}

export type EpubSummary = {
  metadata: EpubMetadata
  sourceMetadata: EpubMetadata
  lastSourceMetadata?: EpubMetadata
  parts: EpubPartSummary[]
  chapters: number
  problems: EpubProblem[]
  planned: { id: string; title: string }[]
  omitted: string[]
}

export type EpubPrepareRequest = EpubPreparationOptions & { dir: string }
export type EpubPrepareReply =
  | { status: 'ready'; token: string; summary: EpubSummary }
  | { status: 'error'; problem: EpubProblem }
export type EpubSaveReply =
  | { status: 'chooser-cancelled' | 'cancelled' }
  | { status: 'complete'; name: string; warning?: string }
  | { status: 'error'; problem: EpubProblem }
