import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Suggestion } from './agent'
import type { Change, ChangeStore } from './changes'
import { setFrontmatterKeys } from './capabilities'
import { parseFrontmatter } from './frontmatter'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { normaliseWorkspaceDocumentPath } from '../shared/agent-note-paths'
import { AGENT_NOTE_DIR, defaultAgentNoteTitle, normaliseNoteKind } from './agent-note-create'
import { SavedButNotReadBack, type Workspace } from './workspace'
import { objectBlock, parseTable, validateObjectMarkup } from '../shared/object-markup'
import { parseQuery } from './query-engine'

export type AgentObjectKind = 'query' | 'table' | 'mermaid' | 'markmap'
export type AgentNoteStatus = 'discarded' | 'accepted'
export type AgentObjectNote = {
  path: string
  recordedAt: string
  sourceDocument: string
  kind: AgentObjectKind
  source: string
  status: AgentNoteStatus
  summary: string
  settlements: Array<{ status: AgentNoteStatus; recordedAt: string }>
  invalidReason?: string
}

/** A prose note ABOUT a document (`notes.create`: review, comments, feedback…), read back for the pane. */
export type AgentProseNote = {
  path: string
  title: string
  kind: string
  sourceDocument: string
  created: string
  skill?: string
  /** The note's Markdown without its frontmatter block. */
  body: string
  /** Where `body` begins in the note FILE — its 1-based line and its offset — so a box the pane draws
   *  from `body` names the file's own line when it is ticked (checkbox-lists ticket 04). */
  bodyLine: number
  bodyOffset: number
}
/** What `agent-notes:list` returns: object notes for the shown collection plus every prose note. */
export type AgentNote = ({ noteType: 'object' } & AgentObjectNote) | ({ noteType: 'prose' } & AgentProseNote)

type PersistInput = Omit<AgentObjectNote, 'path' | 'recordedAt' | 'settlements' | 'invalidReason'> & { recordedAt?: Date; collectionDir?: string }

const NOTE_DIR = 'agent-notes'
const SOURCE_HEADING = '## Object source'
const SETTLEMENT_HEADING = '## Settlement history'

function safeSummary(summary: string, kind: AgentObjectKind): string {
  const value = summary.trim().replace(/\s+/g, ' ')
  return value || `${kind[0].toUpperCase()}${kind.slice(1)} object`
}

function sourceFence(source: string): string {
  const longest = Math.max(2, ...[...source.matchAll(/`+/g)].map((match) => match[0].length))
  return '`'.repeat(longest + 1)
}

function settlementLine(status: AgentNoteStatus, recordedAt: string): string {
  return `- ${status} — ${recordedAt}`
}

function noteBody(summary: string, source: string, status: AgentNoteStatus, recordedAt: string): string {
  const fence = sourceFence(source)
  return `# ${summary}\n\n${SOURCE_HEADING}\n\n${fence}markdown\n${source}\n${fence}\n\n${SETTLEMENT_HEADING}\n\n${settlementLine(status, recordedAt)}\n`
}

function notePath(at: Date, collectionDir = ''): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return posix.join(collectionDir, NOTE_DIR, `${stamp}-${randomUUID().slice(0, 8)}.md`)
}

export async function persistAgentObjectNote(ws: Workspace, input: PersistInput): Promise<AgentObjectNote> {
  const at = input.recordedAt ?? new Date()
  const path = notePath(at, input.collectionDir)
  const summary = safeSummary(input.summary, input.kind)
  const recordedAt = at.toISOString()
  const content = setFrontmatterKeys(noteBody(summary, input.source, input.status, recordedAt), {
    agent_note_status: input.status,
    source_document: input.sourceDocument,
    object_kind: input.kind,
    recorded_at: recordedAt,
  }, path)
  try { await ws.createFile(path, content) } catch (error) {
    throw new Error(`Could not write Agent note at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { path, recordedAt, sourceDocument: input.sourceDocument, kind: input.kind, source: input.source, status: input.status, summary, settlements: [{ status: input.status, recordedAt }] }
}

export async function appendAgentObjectSettlement(ws: Workspace, path: string, status: AgentNoteStatus, recordedAt = new Date().toISOString()): Promise<AgentObjectNote> {
  const existing = await readAgentObjectNote(ws, path)
  const raw = (await ws.readFile(path)).content
  const content = setFrontmatterKeys(`${raw.trimEnd()}\n${settlementLine(status, recordedAt)}\n`, {
    agent_note_status: status,
  }, path)
  // Only over the note as it was read here (R5; final review round 2, finding 1): a newer version is kept.
  try {
    await ws.saveFileOverRead(path, content, raw)
  } catch (error) {
    // Committed and not read back: written.
    if (!(error instanceof SavedButNotReadBack)) throw new Error(`Could not update Agent note at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { ...existing, status, settlements: [...existing.settlements, { status, recordedAt }] }
}

function parseSourceRegion(content: string): { source: string; end: number } | null {
  const heading = content.indexOf(`${SOURCE_HEADING}\n`)
  if (heading < 0) return null
  const afterHeading = content.indexOf('\n', heading + SOURCE_HEADING.length) + 1
  const opening = /(`{3,})markdown\r?\n/.exec(content.slice(afterHeading))
  if (!opening) return null
  const start = afterHeading + opening.index + opening[0].length
  const closing = `\n${opening[1]}`
  const end = content.indexOf(closing, start)
  return end < 0 ? null : { source: content.slice(start, end), end: end + closing.length }
}

function parseSource(content: string): string | null { return parseSourceRegion(content)?.source ?? null }

function heading(content: string): string {
  return /^#\s+(.+?)\s*$/m.exec(content)?.[1]?.trim() ?? 'Agent object'
}

function noteDirectory(collectionDir = ''): string { return posix.join(collectionDir, NOTE_DIR) }

function settlements(content: string): Array<{ status: AgentNoteStatus; recordedAt: string }> {
  const source = parseSourceRegion(content)
  if (!source) return []
  const marker = `${SETTLEMENT_HEADING}\n`
  const start = content.indexOf(marker, source.end)
  if (start < 0) return []
  return [...content.slice(start + marker.length).matchAll(/^- (accepted|discarded) — (\S+)\s*$/gm)]
    .map((match) => ({ status: match[1] as AgentNoteStatus, recordedAt: match[2] }))
}

function invalidCause(kind: AgentObjectKind, source: string): string | undefined {
  const parsed = objectSource(source)
  if (!parsed) return `object_kind is ${kind} but the body does not contain a recognised object`
  if (parsed.kind !== kind) return `object_kind is ${kind} but the body contains ${parsed.kind}`
  try { validateStoredObject({ path: '', recordedAt: '', sourceDocument: '', kind, source, status: 'discarded', summary: '', settlements: [] }) }
  catch (error) { return error instanceof Error ? error.message : String(error) }
  return undefined
}

export async function listAgentObjectNotes(ws: Workspace, collectionDir = ''): Promise<AgentObjectNote[]> {
  const directory = noteDirectory(collectionDir)
  const files = (await ws.listFiles()).filter((file) => file.directory === directory)
  const notes = await Promise.all(files.map(async (file): Promise<AgentObjectNote | null> => {
    const content = (await ws.readFile(file.path)).content
    const frontmatter = parseFrontmatter(content)
    const status = frontmatter?.extra.agent_note_status
    const sourceDocument = frontmatter?.extra.source_document
    const kind = frontmatter?.extra.object_kind
    const recordedAt = frontmatter?.extra.recorded_at
    const source = parseSource(content)
    if ((status !== 'discarded' && status !== 'accepted') || typeof sourceDocument !== 'string'
      || (kind !== 'query' && kind !== 'table' && kind !== 'mermaid' && kind !== 'markmap')
      || typeof recordedAt !== 'string' || source === null) return null
    const invalidReason = invalidCause(kind, source)
    return { path: file.path, recordedAt, sourceDocument, kind, source, status, summary: heading(content), settlements: settlements(content), ...(invalidReason ? { invalidReason } : {}) }
  }))
  return notes.filter((note): note is AgentObjectNote => note !== null)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt) || right.path.localeCompare(left.path))
}

function proseNoteFromFile(path: string, content: string): AgentProseNote | null {
  const frontmatter = parseFrontmatter(content)
  if (!frontmatter || frontmatter.author !== 'agent') return null
  const rawSource = frontmatter.extra.source_document
  if (typeof rawSource !== 'string' || !rawSource.trim()) return null
  if (typeof frontmatter.extra.object_kind === 'string') return null // an object note; listed above
  const sourceDocument = normaliseWorkspaceDocumentPath(rawSource)
  const kind = normaliseNoteKind(typeof frontmatter.extra.agent_note_kind === 'string' ? frontmatter.extra.agent_note_kind : undefined)
  const created = typeof frontmatter.extra.created === 'string' ? frontmatter.extra.created : ''
  const skill = typeof frontmatter.extra.skill === 'string' && frontmatter.extra.skill ? frontmatter.extra.skill : undefined
  const block = frontmatterBlock(content)
  const body = (block ? content.slice(block.end) : content).replace(/^(?:\r?\n)+/, '')
  const bodyOffset = content.length - body.length
  const bodyLine = content.slice(0, bodyOffset).split('\n').length
  const title = frontmatter.title?.trim() || defaultAgentNoteTitle(kind, sourceDocument)
  return { path, title, kind, sourceDocument, created, ...(skill ? { skill } : {}), body, bodyLine, bodyOffset }
}

/**
 * Prose notes from EVERY `agent-notes/` directory in the Workspace — a note's home is the folder
 * of the piece it is about, which need not be the collection the pane is showing. Newest first.
 */
export async function listAgentProseNotes(ws: Workspace): Promise<AgentProseNote[]> {
  const files = (await ws.listFiles()).filter((file) => posix.basename(file.directory) === AGENT_NOTE_DIR)
  const notes = await Promise.all(files.map(async (file) => proseNoteFromFile(file.path, (await ws.readFile(file.path)).content)))
  return notes.filter((note): note is AgentProseNote => note !== null)
    .sort((left, right) => right.created.localeCompare(left.created) || left.path.localeCompare(right.path))
}

/** The pane's list: the collection's object notes and all prose notes, each carrying its discriminant. */
export async function listAgentNotes(ws: Workspace, collectionDir = ''): Promise<AgentNote[]> {
  const [objects, prose] = await Promise.all([listAgentObjectNotes(ws, collectionDir), listAgentProseNotes(ws)])
  return [
    ...prose.map((note): AgentNote => ({ noteType: 'prose', ...note })),
    ...objects.map((note): AgentNote => ({ noteType: 'object', ...note })),
  ]
}

export async function readAgentObjectNote(ws: Workspace, path: string): Promise<AgentObjectNote> {
  const directory = posix.dirname(path)
  if (posix.basename(directory) !== NOTE_DIR) throw new Error('Agent note must be inside agent-notes/.')
  const collectionDir = posix.dirname(directory) === '.' ? '' : posix.dirname(directory)
  const note = (await listAgentObjectNotes(ws, collectionDir)).find((candidate) => candidate.path === path)
  if (!note) throw new Error(`Could not read Agent note: ${path}`)
  return note
}

export async function restageAgentObjectNote(
  ws: Workspace,
  changes: ChangeStore,
  notePathValue: string,
  input: { sourceDocument: string; insertAfter?: string; anchor?: { from: number; to: number } },
): Promise<Change> {
  const note = await readAgentObjectNote(ws, notePathValue)
  if (note.invalidReason) throw new Error(`Cannot restage Agent note: ${note.invalidReason}.`)
  const document = await ws.readFile(input.sourceDocument)
  if (input.anchor) {
    if (input.anchor.from !== input.anchor.to || !Number.isInteger(input.anchor.from)
      || input.anchor.from < 0 || input.anchor.to > document.content.length) {
      throw new Error('The restage cursor is outside the current document; place the cursor again and retry.')
    }
    if (input.insertAfter !== undefined && document.content.slice(0, input.anchor.from) !== input.insertAfter) {
      throw new Error('The document changed at the restage cursor; place the cursor again and retry.')
    }
  }
  const change = await changes.add({
    path: input.sourceDocument,
    provenance: 'agent',
    editClass: 'insert',
    category: 'other',
    summary: note.summary,
    oldText: '',
    newText: note.source,
    ...(input.insertAfter !== undefined ? { insertAfter: input.insertAfter } : {}),
    ...(input.anchor ? { anchor: input.anchor } : {}),
    isCorrection: false,
  })
  return change
}

function validateStoredObject(note: AgentObjectNote): void {
  const parsed = objectSource(note.source)
  if (!parsed || parsed.kind !== note.kind) throw new Error(`Agent note does not contain a valid ${note.kind} object.`)
  if (note.kind === 'table') {
    validateObjectMarkup('table', note.source)
    return
  }
  const inner = /^```(?:query|mermaid|markmap)\r?\n([\s\S]*?)\r?\n```\s*$/.exec(note.source)?.[1] ?? ''
  if (note.kind === 'query') {
    if (!parseQuery(inner).ok) throw new Error('Agent note does not contain a valid query object.')
    return
  }
  validateObjectMarkup(note.kind, inner)
}

export function agentObjectFromChange(change: Change): Omit<PersistInput, 'status'> | null {
  if (change.provenance !== 'agent' || change.editClass !== 'insert') return null
  const object = objectSource(change.newText)
  return object ? { sourceDocument: change.path, ...object, summary: change.summary } : null
}

export function agentObjectFromSuggestion(suggestion: Suggestion): Omit<PersistInput, 'status'> | null {
  const input = suggestion.input as Record<string, unknown> | null
  if (!input || typeof input.path !== 'string') return null
  if (suggestion.capabilityName === 'objects.insert'
    && (input.kind === 'table' || input.kind === 'mermaid' || input.kind === 'markmap')
    && typeof input.content === 'string') {
    return { sourceDocument: input.path, kind: input.kind, source: objectBlock(input.kind, input.content), summary: typeof input.summary === 'string' ? input.summary : `Insert ${input.kind} object` }
  }
  if (suggestion.capabilityName !== 'prose.insert' || typeof input.text !== 'string') return null
  const object = objectSource(input.text)
  return object ? { sourceDocument: input.path, ...object, summary: typeof input.summary === 'string' ? input.summary : `Insert ${object.kind} object` } : null
}

function objectSource(source: string): { kind: AgentObjectKind; source: string } | null {
  if (parseTable(source)) return { kind: 'table', source }
  const match = /^```(query|mermaid|markmap)\r?\n[\s\S]*\r?\n```\s*$/.exec(source)
  return match ? { kind: match[1] as AgentObjectKind, source } : null
}
