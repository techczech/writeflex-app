import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { AGENT_NOTE_DIR } from './agent-note-dir'
import { setFrontmatterKeys } from './verbs/verb-support'
import { normaliseMarkdownPath, type FileReadResult, type Workspace } from './workspace'

/**
 * Agent notes ABOUT a document (review, comments, feedback…) — never beside the writer's piece.
 *
 * Store agent comments in a dedicated subfolder with source metadata, so they can be
 * distinguished from the writer's own documents.
 *
 * The convention is the one `agent-notes.ts` already uses for discarded objects: an `agent-notes/`
 * directory beside the document, frontmatter naming the source document. The model never chooses
 * the path — `notes.create` derives it here — and `housekeeping.create_file` refuses names that
 * look like agent notes so the skill prose is not the only fence.
 */

export { AGENT_NOTE_DIR }
/** The note names the review skill used to write beside the document. */
export const AGENT_NOTE_BASENAME = /\.(review|notes|comments|feedback)\.md$/i
export const NOTES_CREATE = 'notes.create'
const DEFAULT_KIND = 'notes'

export type AgentNoteInput = { sourceDocument: string; kind?: string; title?: string; body: string }
export type AgentNoteFrontmatter = {
  title: string
  author: 'agent'
  agent_note_kind: string
  source_document: string
  created: string
  skill?: string
}

export function insideAgentNotes(path: string): boolean {
  return path.split('/').includes(AGENT_NOTE_DIR)
}

/** Lower-case slug of the kind: `Peer Review` → `peer-review`; empty or unusable → `notes`. */
export function normaliseNoteKind(kind: string | undefined): string {
  const slug = (kind ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || DEFAULT_KIND
}

function stamp(at: Date): string {
  const iso = at.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`
}

/**
 * `<dir of source>/agent-notes/<stem>.<kind>.md`; on collision `<stem>.<kind>.<YYYYMMDD-HHmm>.md`,
 * and a `-2`, `-3`… counter behind the stamp so two notes in one minute still never overwrite.
 */
export function deriveAgentNotePath(sourceDocument: string, kind: string | undefined, exists: (path: string) => boolean, now = new Date()): string {
  // The extension is added when missing and nothing else changes: a resolved source is used as it is.
  if (!sourceDocument.trim()) throw new Error('Path is required.')
  const source = /\.(md|markdown|mdx)$/i.test(sourceDocument) ? sourceDocument : `${sourceDocument}.md`
  const directory = posix.dirname(source)
  const stem = posix.basename(source).replace(/\.(md|markdown)$/i, '')
  const base = posix.join(directory === '.' ? '' : directory, AGENT_NOTE_DIR, `${stem}.${normaliseNoteKind(kind)}`)
  if (!exists(`${base}.md`)) return `${base}.md`
  const stamped = `${base}.${stamp(now)}`
  let candidate = `${stamped}.md`
  let counter = 2
  while (exists(candidate)) candidate = `${stamped}-${counter++}.md`
  return candidate
}

export function defaultAgentNoteTitle(kind: string, sourceDocument: string): string {
  const stem = posix.basename(sourceDocument).replace(/\.(md|markdown)$/i, '')
  const label = kind.replace(/-/g, ' ')
  return `${label[0].toUpperCase()}${label.slice(1)} of ${stem}`
}

export function agentNoteFrontmatter(input: AgentNoteInput, sourceDocument: string, opts: { skill?: string; now?: Date } = {}): AgentNoteFrontmatter {
  const kind = normaliseNoteKind(input.kind)
  const title = input.title?.trim() || defaultAgentNoteTitle(kind, sourceDocument)
  return {
    title,
    author: 'agent',
    agent_note_kind: kind,
    source_document: sourceDocument,
    created: (opts.now ?? new Date()).toISOString(),
    ...(opts.skill ? { skill: opts.skill } : {}),
  }
}

/** The note file's full content: the body under a frontmatter block written by the ONE writer. */
export function agentNoteContent(input: AgentNoteInput, path: string, sourceDocument: string, opts: { skill?: string; now?: Date } = {}): string {
  const body = input.body.endsWith('\n') ? input.body : `${input.body}\n`
  return setFrontmatterKeys(body, agentNoteFrontmatter(input, sourceDocument, opts), path)
}

/**
 * The source document, workspace-relative and normalised, or a refusal. Outside the workspace and
 * inside `agent-notes/` are refused; a document that does not exist is refused too — a note about
 * nothing is a misaddressed note.
 */
export function resolveNoteSource(workspace: Workspace, sourceDocument: string, exact = false): string {
  if (typeof sourceDocument !== 'string' || !sourceDocument.trim()) {
    throw new Error('sourceDocument must name the Workspace document the note is about.')
  }
  let relative: string
  try {
    // `exact`: the caller has already judged the path and it is taken as it stands, untrimmed (the command line).
    relative = workspace.relative(workspace.absolute(exact ? sourceDocument : normaliseMarkdownPath(sourceDocument)))
  } catch {
    throw new Error(`sourceDocument ${JSON.stringify(sourceDocument)} is outside the open Workspace; notes are only written about Workspace documents.`)
  }
  if (insideAgentNotes(relative)) {
    throw new Error(`sourceDocument ${JSON.stringify(relative)} is itself an agent note; notes are written about the writer's documents, not about agent-notes/.`)
  }
  if (!existsSync(workspace.absolute(relative))) {
    throw new Error(`sourceDocument ${JSON.stringify(relative)} does not exist in the Workspace.`)
  }
  return relative
}

/** The path `notes.create` will write for this input right now — the touchedPaths declaration. */
export function planAgentNotePath(workspace: Workspace, input: AgentNoteInput, now = new Date()): string {
  const source = resolveNoteSource(workspace, input.sourceDocument)
  return deriveAgentNotePath(source, input.kind, (candidate) => existsSync(workspace.absolute(candidate)), now)
}

/**
 * Write the note. `path` is the executor's frozen declaration when Bridle resolved touched paths
 * (the capability must write exactly that set), otherwise it is derived here.
 */
export async function createAgentNote(
  workspace: Workspace,
  input: AgentNoteInput,
  opts: { skill?: string; now?: Date; path?: string; /** The source path is used exactly as given, never trimmed. */ exact?: boolean } = {},
): Promise<FileReadResult> {
  if (typeof input.body !== 'string' || !input.body.trim()) throw new Error('body must not be empty; provide the note text as Markdown.')
  const now = opts.now ?? new Date()
  const source = resolveNoteSource(workspace, input.sourceDocument, opts.exact === true)
  const path = opts.path ?? deriveAgentNotePath(source, input.kind, (candidate) => existsSync(workspace.absolute(candidate)), now)
  if (!insideAgentNotes(path)) throw new Error(`Refusing to write an agent note outside ${AGENT_NOTE_DIR}/: ${path}`)
  return workspace.createFile(path, agentNoteContent(input, path, source, { skill: opts.skill, now }))
}

/**
 * Why `housekeeping.create_file` must not create `path`, or null when it may. Refused ONLY a
 * basename in the agent-note grammar (`essay.review.md`, `essay.comments.md`…) — the names the
 * model used to choose beside the document. Any other name is a real piece and stays allowed,
 * `chapter.draft.md` beside `chapter.md` included .
 */
export function createFileNoteRefusal(path: string): string | null {
  let normalised: string
  try { normalised = normaliseMarkdownPath(path) } catch { return null }
  if (!AGENT_NOTE_BASENAME.test(posix.basename(normalised))) return null
  return `${JSON.stringify(normalised)} is named like an agent note about a document; housekeeping.create_file does not create agent notes. `
    + `Use ${NOTES_CREATE} (sourceDocument, kind, body) instead: it files the note under ${AGENT_NOTE_DIR}/ with author and source metadata.`
}
