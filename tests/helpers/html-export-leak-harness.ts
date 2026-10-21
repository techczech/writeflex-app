export type HtmlExportLeakContext = {
  marginNoteTexts: readonly string[]
  sourceFrontmatter: Readonly<Record<string, unknown>>
  selectedFrontmatterFields: readonly string[]
  workspaceRoot: string
  machineHostname: string
  versionRecordMarkers: readonly string[]
  diarySessionMarkers: readonly string[]
  collectionProvenanceMarkers: readonly string[]
  /** Sharing: words only an Agent note about the piece holds. */
  agentNoteTexts?: readonly string[]
  /** Sharing: words only a pending change to the piece holds (its proposed text, its summary). */
  pendingChangeTexts?: readonly string[]
  /** Sharing: the collection's name and the piece's file path, absolute and relative. */
  collectionName?: string
  filePaths?: readonly string[]
  annotationEnabled: boolean
  editEnabled?: boolean
}

const ANNOTATION_RUNTIME_MARKERS = [
  'data-writeflex-reader-notes-ui',
  'data-writeflex-reader-notes-runtime',
  'WriteFlexReaderNotes',
]

export const EDIT_RUNTIME_MARKERS = [
  'data-writeflex-reader-edits-ui',
  'data-writeflex-reader-edits-runtime',
  'WriteFlexReaderEdits',
  'createTextEditRecord',
]

function fail(category: string, marker: string): never {
  throw new Error(`HTML export leaked ${category}: ${marker}`)
}

function assertAbsent(html: string, category: string, markers: readonly string[]): void {
  for (const marker of markers) {
    if (marker !== '' && html.includes(marker)) fail(category, marker)
  }
}

function scalarStrings(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(scalarStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(scalarStrings)
  return []
}

/** Assert the five non-negotiable HTML-export exclusions, and (sharing) what a published copy must also leave out: Agent notes, pending changes, the collection name and the file path. */
export function assertHtmlExportDoesNotLeak(html: string, context: HtmlExportLeakContext): void {
  assertAbsent(html, 'margin-note text', context.marginNoteTexts)

  const selected = new Set(context.selectedFrontmatterFields)
  const unselectedValues = Object.entries(context.sourceFrontmatter)
    .filter(([field]) => !selected.has(field))
    .flatMap(([, value]) => scalarStrings(value))
  assertAbsent(html, 'unselected front-matter field', unselectedValues)

  if (/\/Users\//.test(html)) fail('absolute local path', '/Users/')
  assertAbsent(html, 'workspace root', [context.workspaceRoot])
  assertAbsent(html, 'machine hostname', [context.machineHostname])

  assertAbsent(html, 'version record', context.versionRecordMarkers)
  assertAbsent(html, 'diary session', context.diarySessionMarkers)
  assertAbsent(html, 'collection provenance', context.collectionProvenanceMarkers)
  assertAbsent(html, 'Agent note', context.agentNoteTexts ?? [])
  assertAbsent(html, 'pending change', context.pendingChangeTexts ?? [])
  if (context.collectionName) assertAbsent(html, 'collection name', [context.collectionName])
  assertAbsent(html, 'file path', context.filePaths ?? [])

  if (!context.annotationEnabled) {
    assertAbsent(html, 'annotation runtime', ANNOTATION_RUNTIME_MARKERS)
  }
  if (!context.editEnabled) {
    assertAbsent(html, 'edit runtime', EDIT_RUNTIME_MARKERS)
  }
  if (!context.annotationEnabled && !context.editEnabled) {
    assertAbsent(html, 'interaction manifest', ['writeflex-interaction-manifest'])
  }
}
