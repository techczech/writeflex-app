/**
 * "An agent created this document", recorded in BOTH places the writer decided on (7 October):
 *
 *  1. A LINE IN THE DOCUMENT'S OWN FRONTMATTER: `created-by: Claude Code` (or `Codex`, or `Outside
 *     agent`). One flat key with a plain value, written by the app's one frontmatter writer
 *     (verbs/verb-support.ts `setFrontmatterKeys`), so it is ordered and quoted as every other key the
 *     app writes. It is ordinary frontmatter: the writer can edit or delete it and nothing reads it
 *     afterwards. Text passed in that already has a frontmatter block gains the line inside that
 *     block; text that already carries the key keeps the value it came with.
 *  2. A RECORD IN WRITEFLEX'S HISTORY FOR THE FILE: a first version of the document, named `Created
 *     by Claude Code` and authored by that source, saved through the one version-save route there is
 *     (`WriteAccess.saveVersion`: the command line's guarded history writer under its lock with the
 *     app closed, the app's own stores when it carries out the request). The History pane lists it
 *     like any version and can show and restore its text; nothing in the renderer changes.
 *
 * WHO. The source is what the caller declared (`--source`, global or the operation's own, or
 * `WRITEFLEX_SOURCE`), mapped through the closed list (shared/outside-source.ts, `declaredSource`);
 * with nothing declared, or anything not on the list, it is the generic `Outside agent`. It is a
 * statement by the caller, not proof, as everywhere else. Nothing a caller sends is copied into the
 * line or the version: both are built from the closed list's own labels.
 *
 * BOTH OR NEITHER, AND NEVER A FAILED CREATE. Creating the document is what was asked for; the record
 * is not allowed to stop it. The line travels in the document's first bytes, so the two are written
 * together or the document is put back as it was given:
 *  - the text passed in cannot safely take the line (a frontmatter block the app's writer will not
 *    edit): the document is created exactly as given, no version is saved, and the result says so;
 *  - the history record cannot be written (the history store is not usable, the app has no store
 *    open yet, the Collection was taken over): the line this command added is taken out again, so
 *    the document holds exactly the text given, and the result says the history record was not
 *    written and why. If taking it out fails too, the line stays and the result says that instead.
 *
 * WHAT COUNTS. `create` only, on either route. `duplicate` copies the writer's document byte for
 * byte, its frontmatter included, and is not a document an agent wrote. `create-manifest` writes a
 * Folio manifest (JSON, no frontmatter, no versions). `note` writes an agent note, whose frontmatter
 * already says `author: agent`.
 */
import { OUTSIDE_SOURCE_LABELS, type OutsideSource } from '../../shared/outside-source'
import { frontmatterKeys } from '../frontmatter'
import { setFrontmatterKeys } from '../verbs/verb-support'
import { OUTSIDE_AUTHORS } from './review-format'
import type { WriteAccess } from './write-access'

/** The frontmatter key. Hyphenated, as the app's other two-word key (`series-order`) is. */
export const CREATED_BY_KEY = 'created-by'

/** The name of the version that records the creation, as the History pane lists it. */
export const createdVersionName = (source: OutsideSource): string => `Created by ${OUTSIDE_SOURCE_LABELS[source]}`

/** The text a created document is first written with, and what became of the provenance line. */
export type MarkedContent =
  | { content: string; line: 'added' }
  /** The text passed in already carries the key: it is the writer's (or the caller's) and is left as it is. */
  | { content: string; line: 'given' }
  /** The app's frontmatter writer refused the block the text came with; `why` is its reason. */
  | { content: string; line: 'not-added'; why: string }

/** `given` with the provenance line in its frontmatter (a block is made when it has none). Never throws. */
export function withCreatedBy(given: string, source: OutsideSource, path: string): MarkedContent {
  if (frontmatterKeys(given).includes(CREATED_BY_KEY)) return { content: given, line: 'given' }
  try {
    return { content: setFrontmatterKeys(given, { [CREATED_BY_KEY]: OUTSIDE_SOURCE_LABELS[source] }, path), line: 'added' }
  } catch (error) {
    return { content: given, line: 'not-added', why: error instanceof Error ? error.message : String(error) }
  }
}

/** What was recorded, for the result (`createdBy` under `--json`) and its one plain line. */
export type AgentCreatedRecord = {
  source: OutsideSource
  label: string
  /** Whether the document's frontmatter carries the key now. */
  frontmatter: boolean
  /** The version that records the creation, or null when none was saved. */
  history: { version: string; name: string } | null
  /** Why something was not recorded; absent when both records were written. */
  note?: string
}

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * THE HOOK. Called by `create` once the document is on disk, while the Collection is still held
 * (the command line's lock, or the app's for a request). `given` is the text as it was passed in and
 * `marked` what the document was written with. Never throws.
 */
export async function recordAgentCreatedDocument(access: WriteAccess, path: string, given: string, marked: MarkedContent, source: OutsideSource): Promise<AgentCreatedRecord> {
  const label = OUTSIDE_SOURCE_LABELS[source]
  const record = { source, label }
  if (marked.line === 'not-added') {
    return { ...record, frontmatter: false, history: null, note: `Not recorded as created by ${label}, in the document or in its history: the frontmatter the text came with could not be given the line safely (${marked.why}). The document was created exactly as given.` }
  }
  try {
    const saved = await access.saveVersion({ path, name: createdVersionName(source), author: OUTSIDE_AUTHORS[source] })
    return { ...record, frontmatter: true, history: { version: saved.record.id, name: saved.record.name }, ...(marked.line === 'given' ? { note: `The text given already carried ${CREATED_BY_KEY} in its frontmatter; that line was left as it came.` } : {}) }
  } catch (error) {
    const why = said(error)
    if (marked.line === 'given') {
      return { ...record, frontmatter: true, history: null, note: `The history record of the creation was not written (${why}). The ${CREATED_BY_KEY} line the text came with is in the document, as given.` }
    }
    try {
      // Neither, then: the document goes back to exactly the text given.
      await access.session.rewriteCreated(path, given)
      return { ...record, frontmatter: false, history: null, note: `Not recorded as created by ${label}: the history record could not be written (${why}), so the ${CREATED_BY_KEY} line was left out of the document too. The document was created with exactly the text given.` }
    } catch (again) {
      return { ...record, frontmatter: true, history: null, note: `The history record of the creation was not written (${why}). The line "${CREATED_BY_KEY}: ${label}" is in the document's frontmatter and could not be taken out again (${said(again)}).` }
    }
  }
}

/** The plain line a create's result carries about the record. */
export function createdByLine(record: AgentCreatedRecord): string {
  if (record.history && !record.note) return `Recorded as created by ${record.label}: the line "${CREATED_BY_KEY}: ${record.label}" in its frontmatter, and the version "${record.history.name}" in its history in WriteFlex.`
  if (record.history) return `Recorded as created by ${record.label}: the version "${record.history.name}" in its history in WriteFlex. ${record.note}`
  return record.note ?? ''
}
