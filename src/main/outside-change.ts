/**
 * The inbox validator for shown-first requests (specification section 4, "The inbox is treated as
 * untrusted input"): one request in, the Change it would be or the reason it cannot be one out.
 * `proposeOutsideChange` writes nothing and decides nothing about who asked. It is run twice on every
 * request, from scratch each time: by the command line before it files (against what is saved on
 * disk), and by the app when it adds the request to the review ledger. The app trusts nothing the
 * command line concluded; the file in the inbox can have been written by anything.
 *
 * WHAT IT CHECKS, for every operation:
 *  - the operation is on the closed list (cli/review-format.ts);
 *  - the path is a document the sidebar would show (`Workspace.classifyPath`: the typed path and its
 *    real location; no dot-folder, nothing under `.writeflex` or `.bridle`, no link out of the
 *    Collection), a Markdown file, and there now. It is read ONCE, through `readDocumentGuarded`
 *    (guarded-document-read.ts): opened without following a link, and the opened file's real
 *    location judged, so a link swapped in after the path check cannot put another file's text
 *    into a Change. Where one of the app's planners reads the document again by name (status, a
 *    source), its text must equal what the guarded read returned, or the request is refused;
 *  - every field has its type and is within its size limit;
 *  - the Change can be placed NOW: a replacement's target is non-empty and occurs exactly once; an
 *    insert's or a move's anchor occurs exactly once (an insert with no anchor goes at the end of the
 *    document, after any frontmatter and all the prose: verb-support.ts `resolveOutsideInsert`).
 *
 * TEXT IS TEXT. A target and an anchor are matched literally (`indexOf`), never as a pattern. New
 * text is stored as the document text it would become and is never read as anything else: not as a
 * path, a command, a template or markup to run. A note becomes the Change's summary line, cut to a
 * length.
 *
 * THE REPRESENTATION is the one the in-app agent's staged proposals already have in the ledger
 * (agent.ts `ingestStagedChanges`), so the existing accept path replays it with no live proposal:
 *   replace              `content`, the target as `oldText`, the replacement as `newText`
 *   insert, object       `insert`, the anchor as `insertAfter` (empty: at the end)
 *   move-text            `move`, with the ranges found when it is ADDED, and the anchor's text kept
 *                        beside them (`outsideMoveAfter`) so accept places it by text again
 *   frontmatter, status,
 *   a source             `content` over the whole frontmatter block, marked `frontmatter`: placed only
 *                        while the block is exactly as proposed, so an edit to the writing never stands
 *                        in its way and a changed block makes it wait (frontmatter-change.ts). When the request
 *                        changes more than the frontmatter, or the document has no block yet, it is a
 *                        change over the whole document, as a version is:
 *   a version            `content` over the whole document, marked `whole`: `oldText` is the document
 *                        as it stands, `newText` what it would be. Accept applies it only while the
 *                        document is still EXACTLY that text (never as a passage found inside a
 *                        document that has grown since); otherwise the Change closes with the reason.
 *   tick                 `content` over the task's own line, which must occur once
 *
 * A move's positions are never taken from a request: a request carries text, and positions are worked
 * out here, at the time of adding.
 */
import { posix } from 'node:path'
import type { Change, NewChange } from '../engine'
import { anchorContextOf, isWholeDocumentChange, type ClosedCode, type FrontmatterChange, type WholeDocumentChange } from './changes'
import { frontmatterBlockEdit } from '../shared/markdown/frontmatter-proposal'
import { frontmatterEditOf, placeInFrontmatter } from './frontmatter-change'
import { outsideMoveAfterOf, type OutsideChangeFields } from './outside-change-fields'
import { readTaskLines } from '../shared/markdown/task-lines'
import { objectBlock, validateObjectMarkup, type ObjectKind } from '../shared/object-markup'
import { normaliseCollectionStatus } from '../shared/collection-status'
import { checkedStoresForReading, versionTextReader } from './cli/history-store'
import {
  INTENDED_SHOWN_CHARS, MAX_CHANGES_PER_REQUEST, MAX_NEW_TEXT_BYTES, MAX_NOTE_CHARS, MAX_TARGET_BYTES, MAX_VALUE_CHARS, MAX_WHOLE_DOCUMENT_BYTES,
  bytesOf, isShownFirst,
} from './cli/review-format'
import { planCollectionPieceStatus } from './collection'
import { DocumentReadRefused, readDocumentGuarded } from './guarded-document-read'
import { prepareSourceAttach } from './source-attach'
import { placeRecordedReplacement } from './recorded-placement'
import { PlacementError, frontmatterSplit, normaliseExistingFrontmatter, resolveOutsideInsert, resolveProseMove, setFrontmatterKeys } from './verbs/verb-support'
import type { Workspace } from './workspace'

export * from './outside-change-fields'

/** A Change as the validator proposes it: no author, no source, no status. Whoever adds it gives those. */
export type OutsideDraft = Pick<NewChange, 'path' | 'editClass' | 'category' | 'summary' | 'oldText' | 'newText' | 'anchor' | 'moveFrom' | 'moveTo' | 'insertAfter'> & Pick<OutsideChangeFields, 'outsideMoveAfter'> & WholeDocumentChange & FrontmatterChange

export type OutsideProposal =
  | { ok: true; path: string; changes: OutsideDraft[] }
  /** `path` is the request's own, as given; `intended` what it asked for, uncut; `code` the reason from the closed list. */
  | { ok: false; reason: string; code: ClosedCode; path: string; summary: string; intended: { oldText: string; newText: string } }

const MARKDOWN = /\.(?:md|markdown|mdx)$/i
const OBJECT_KINDS: readonly ObjectKind[] = ['table', 'mermaid', 'markmap', 'svg']
const quote = (text: string): string => JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)

class Refusal extends Error {
  constructor(reason: string, readonly code: ClosedCode) { super(reason) }
}
const refuse = (reason: string, code: ClosedCode = 'other'): never => { throw new Refusal(reason, code) }

/** A refused guarded read as a code from the closed list. */
const READ_CODES: Record<DocumentReadRefused['code'], ClosedCode> = {
  missing: 'file-missing', 'not-a-document': 'not-a-document', 'is-a-folder': 'not-a-document', 'is-a-link': 'not-a-document',
  'not-a-file': 'not-a-document', moved: 'unreadable', unreadable: 'unreadable', 'too-large': 'other',
}

/** Occurrences of `needle` in `text`, counted up to two. Literal. */
function occurrences(text: string, needle: string): 0 | 1 | 2 {
  const first = text.indexOf(needle)
  if (first === -1) return 0
  return text.indexOf(needle, first + 1) === -1 ? 1 : 2
}

function textField(args: Record<string, unknown>, name: string, what: string, maxBytes: number, opts: { required?: boolean } = {}): string {
  const value = args[name]
  if (value === undefined) {
    if (opts.required) refuse(`${what} is missing.`)
    return ''
  }
  if (typeof value !== 'string') return refuse(`${what} must be text.`)
  if (bytesOf(value) > maxBytes) return refuse(`${what} is ${bytesOf(value)} bytes; the limit is ${maxBytes}.`)
  if (opts.required && value === '') return refuse(`${what} is empty.`)
  return value
}

/** The note as a one-line summary, or `fallback`. Cut, never refused: it is a label, not content. */
function summaryOf(args: Record<string, unknown>, fallback: string): string {
  const note = typeof args.note === 'string' ? args.note.replace(/\s+/g, ' ').trim() : ''
  return (note === '' ? fallback : note).slice(0, MAX_NOTE_CHARS)
}

/** The document a request names, read now. Throws a Refusal for every way it cannot be a target. */
async function readTarget(ws: Workspace, given: unknown, what = 'The path'): Promise<{ path: string; content: string }> {
  if (typeof given !== 'string' || given === '') return refuse(`${what} is missing.`)
  // Exactly as given: a path is never trimmed, so it names the one file whose characters it holds.
  const typed = given
  if (typed.includes('\0') || typed.length > 4096) return refuse(`${what} is not a usable path.`)
  if (posix.isAbsolute(typed)) return refuse(`${quote(typed)} is not a path inside the Collection (give it relative to the Collection's folder).`, 'not-a-document')
  const verdict = ws.classifyPath(typed)
  if (verdict === 'outside') return refuse(`${quote(typed)} is outside the Collection.`, 'not-a-document')
  if (verdict === 'hidden') return refuse(`${quote(typed)} is under a dot-folder or an ignored folder, which is not part of the Collection.`, 'not-a-document')
  let path: string
  try { path = ws.relative(ws.absolute(typed)) } catch { return refuse(`${quote(typed)} is outside the Collection.`, 'not-a-document') }
  if (!MARKDOWN.test(path)) return refuse(`${quote(typed)} is not a Markdown document.`, 'not-a-document')
  try {
    // One guarded read: the file that is opened is the file that is judged and the file that is read.
    return await readDocumentGuarded(ws, path)
  } catch (error) {
    if (error instanceof DocumentReadRefused) return refuse(error.message, READ_CODES[error.code])
    return refuse(`${quote(typed)} could not be read (${(error as NodeJS.ErrnoException | null)?.code ?? 'unknown error'}).`, 'unreadable')
  }
}

/** A Change over the whole document: `next` is what the document would become. */
function wholeDocument(path: string, content: string, next: string, summary: string): OutsideDraft {
  if (content === '') refuse(`${path} is empty, so a change to the whole of it cannot be shown for review.`)
  if (next === content) refuse(`${path} already reads that way; there is nothing to change.`)
  for (const text of [content, next]) {
    if (bytesOf(text) > MAX_WHOLE_DOCUMENT_BYTES) refuse(`${path} is too large for this change to be shown for review (the limit is ${MAX_WHOLE_DOCUMENT_BYTES} bytes).`)
  }
  return { path, editClass: 'content', category: 'other', summary, oldText: content, newText: next, whole: true }
}

/**
 * A Change to the metadata: `next` is what the document would become. Judged as a change to the whole
 * document is (empty, unchanged, too large), then filed as the old and new frontmatter blocks when only
 * the frontmatter changes; otherwise over the whole document.
 */
function metadataChange(path: string, content: string, next: string, summary: string): OutsideDraft {
  const whole = wholeDocument(path, content, next, summary)
  const edit = frontmatterBlockEdit(content, next)
  if (!edit) return whole
  return { path, editClass: 'content', category: 'other', summary, oldText: edit.oldText, newText: edit.newText, anchor: { from: edit.from, to: edit.to }, frontmatter: true }
}

/** The app's own words when one of its planners refuses, as a Refusal. */
async function planned<T>(plan: () => T | Promise<T>): Promise<T> {
  try { return await plan() } catch (error) {
    if (error instanceof Refusal) throw error
    return refuse(error instanceof Error ? error.message : String(error), error instanceof PlacementError ? error.code : 'other')
  }
}

type Build = (ws: Workspace, args: Record<string, unknown>, stores: Workspace) => Promise<{ path: string; changes: OutsideDraft[] }>

const BUILDERS: Record<string, Build> = {
  replace: async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const target = textField(args, 'target', 'The text to replace (target)', MAX_TARGET_BYTES, { required: true })
    const next = textField(args, 'with', 'The replacement text', MAX_NEW_TEXT_BYTES)
    if (target === next) refuse('The replacement is the same as the text it replaces; there is nothing to change.')
    const found = occurrences(content, target)
    if (found === 0) refuse(`The text to replace was not found in ${path}. It must match the document exactly, character for character.`, 'target-gone')
    if (found === 2) refuse(`The text to replace occurs more than once in ${path}. Give more of the surrounding text so that it matches once.`, 'target-repeated')
    const from = content.indexOf(target)
    return { path, changes: [{ path, editClass: 'content', category: 'other', summary: summaryOf(args, `Replace text in ${path}`), oldText: target, newText: next, anchor: { from, to: from + target.length } }] }
  },
  insert: async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const text = textField(args, 'text', 'The text to insert', MAX_NEW_TEXT_BYTES, { required: true })
    const after = textField(args, 'after', 'The text to insert after (after)', MAX_TARGET_BYTES)
    await planned(() => resolveOutsideInsert(content, { path, insertAfter: after, text }))
    return { path, changes: [{ path, editClass: 'insert', category: 'other', summary: summaryOf(args, after === '' ? `Add text at the end of ${path}` : `Insert text in ${path}`), oldText: '', newText: text, insertAfter: after }] }
  },
  'move-text': async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const text = textField(args, 'text', 'The text to move', MAX_TARGET_BYTES, { required: true })
    const after = textField(args, 'after', 'The text to move it after (after)', MAX_TARGET_BYTES, { required: true })
    // Positions are worked out here, from the text, at the time of adding; a request never carries any.
    const resolved = await planned(() => resolveProseMove(content, { path, text, insertAfter: after, summary: '' }))
    return { path, changes: [{
      path, editClass: 'move', category: 'structure', summary: summaryOf(args, `Move text in ${path}`), oldText: text, newText: text,
      anchor: { from: resolved.moveTo.from - after.length, to: resolved.moveTo.from }, moveFrom: resolved.moveFrom, moveTo: resolved.moveTo, outsideMoveAfter: after,
    }] }
  },
  'restore-version': async (ws, args, stores) => {
    const { path, content } = await readTarget(ws, args.path)
    const id = typeof args.version === 'string' ? args.version.trim() : ''
    if (id === '' || id.length > 200) refuse('The version to restore is missing ("writeflex versions" lists them by id).')
    const restored = await planned(async () => {
      const version = (await checkedStoresForReading(stores).versions.list({ path })).find((candidate) => candidate.id === id)
      if (!version) return refuse(`${path} has no saved version with the id ${quote(id)} ("writeflex versions ${path}" lists them).`)
      // The guarded reader: the object must hash to its name, so only that version's own bytes come back.
      const text = version.snapshotId ? await versionTextReader(stores.root).readSnapshotContent(version.snapshotId) : null
      if (text === null) return refuse(`The saved text of version ${quote(version.name)} of ${path} is not in the history store, so it cannot be restored.`)
      return { name: version.name, text }
    })
    return { path, changes: [wholeDocument(path, content, restored.text, summaryOf(args, `Restore version “${restored.name.slice(0, 120)}” of ${path}`))] }
  },
  'set-frontmatter': async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const key = typeof args.key === 'string' ? args.key.trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) refuse('The frontmatter key must be a plain name (letters, digits, - and _, starting with a letter).')
    const value = args.value
    if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS || /[\r\n\u0085\u2028\u2029]/.test(value)) refuse(`The frontmatter value must be one line of text of at most ${MAX_VALUE_CHARS} characters.`)
    const next = await planned(() => setFrontmatterKeys(content, { [key]: value as string }, path))
    return { path, changes: [metadataChange(path, content, next, summaryOf(args, `Set ${key} in the frontmatter of ${path}`))] }
  },
  'normalise-frontmatter': async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    if (!frontmatterSplit(content.startsWith('\uFEFF') ? content.slice(1) : content)) refuse(`${path} has no frontmatter block to normalise.`)
    const next = await planned(() => normaliseExistingFrontmatter(content))
    return { path, changes: [metadataChange(path, content, next, summaryOf(args, `Normalise the frontmatter of ${path}`))] }
  },
  'set-status': async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const status = await planned(() => normaliseCollectionStatus(args.status))
    const dir = typeof args.collection === 'string' ? args.collection.replace(/^\/+|\/+$/g, '') : posix.dirname(path) === '.' ? '' : posix.dirname(path)
    if (dir !== '' && ws.classifyPath(dir, 'folder') !== 'document') refuse(`${quote(dir)} is not a folder of this Collection.`)
    const plan = await planned(() => planCollectionPieceStatus(ws, dir, path, status))
    if (plan.next === null) refuse(`${path} already has the status ${quote(status)}; there is nothing to change.`)
    // What was read for the plan is what the Change is over.
    if (plan.source.content !== content) refuse(`${path} changed while it was being read. Try again.`)
    return { path, changes: [metadataChange(path, content, plan.next as string, summaryOf(args, `Set the status of ${path} to “${status}”`))] }
  },
  tick: async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const line = args.line
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return refuse('The line must be a whole number, 1 or more ("writeflex tasks" gives it).')
    if (args.untick !== undefined && typeof args.untick !== 'boolean') refuse('untick must be true or false.')
    const untick = args.untick === true
    const item = readTaskLines(content).find((candidate) => candidate.line === line)
    if (!item) return refuse(`Line ${line} of ${path} has no checkbox ("writeflex tasks ${path}" lists the lines that do).`, 'target-gone')
    if (item.checked !== untick) refuse(`The box on line ${line} of ${path} is already ${item.checked ? 'ticked' : 'unticked'}; there is nothing to change.`)
    const start = content.lastIndexOf('\n', item.from) + 1
    const nextBreak = content.indexOf('\n', item.from)
    const end = nextBreak === -1 ? content.length : nextBreak
    const oldText = content.slice(start, end)
    if (occurrences(content, oldText) !== 1) refuse(`Line ${line} of ${path} reads the same as another line, so a tick for it cannot be placed safely. Use "writeflex replace" with enough surrounding text.`, 'target-repeated')
    const newText = content.slice(start, item.tick) + (untick ? ' ' : 'x') + content.slice(item.tick + 1, end)
    return { path, changes: [{ path, editClass: 'content', category: 'other', summary: summaryOf(args, `${untick ? 'Untick' : 'Tick'} “${item.text.slice(0, 120)}”`), oldText, newText, anchor: { from: start, to: end } }] }
  },
  'insert-object': async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const kind = args.kind
    if (typeof kind !== 'string' || !(OBJECT_KINDS as readonly string[]).includes(kind)) return refuse(`The kind of object must be one of: ${OBJECT_KINDS.join(', ')}.`)
    const inner = textField(args, 'content', 'The object\'s markup', MAX_NEW_TEXT_BYTES, { required: true })
    const after = textField(args, 'after', 'The text to insert after (after)', MAX_TARGET_BYTES)
    const text = await planned(() => { validateObjectMarkup(kind as ObjectKind, inner); return objectBlock(kind as ObjectKind, inner) })
    await planned(() => resolveOutsideInsert(content, { path, insertAfter: after, text }))
    return { path, changes: [{ path, editClass: 'insert', category: 'other', summary: summaryOf(args, `Insert a ${kind} object in ${path}`), oldText: '', newText: text, insertAfter: after }] }
  },
  'attach-source': async (ws, args) => {
    const { path, content } = await readTarget(ws, args.path)
    const source = await readTarget(ws, args['source-path'], 'The source')
    const dir = typeof args.collection === 'string' ? args.collection.replace(/^\/+|\/+$/g, '') : ''
    if (dir !== '' && ws.classifyPath(dir, 'folder') !== 'document') refuse(`${quote(dir)} is not a folder of this Collection.`)
    const plan = await planned(() => prepareSourceAttach(ws, { dir, piece: path, source: source.path }))
    if (plan.piece.path !== path || plan.piece.before !== content || plan.piece.after === null) refuse(`${path} changed while it was being read. Try again.`)
    return { path, changes: [metadataChange(path, content, plan.piece.after as string, summaryOf(args, `Add “${plan.sourceTitle.slice(0, 120)}” to the sources of ${plan.pieceTitle.slice(0, 120)}`))] }
  },
}

/** Why a request yielding `count` Changes is refused, or null: one request carries at most `MAX_CHANGES_PER_REQUEST`. */
export function tooManyChanges(count: number): string | null {
  return count > MAX_CHANGES_PER_REQUEST ? `The request would make ${count} changes; one request may make at most ${MAX_CHANGES_PER_REQUEST}. Ask for them in smaller requests.` : null
}

/** What a request asked for, as text, when it is refused: for the closed Change's record. */
function intendedOf(operation: string, args: Record<string, unknown>): { oldText: string; newText: string } {
  const text = (name: string): string => (typeof args[name] === 'string' ? args[name] as string : '')
  if (operation === 'replace') return { oldText: text('target'), newText: text('with') }
  if (operation === 'insert') return { oldText: '', newText: text('text') }
  if (operation === 'move-text') return { oldText: text('text'), newText: text('text') }
  if (operation === 'insert-object') return { oldText: '', newText: text('content') }
  if (operation === 'set-frontmatter') return { oldText: '', newText: `${text('key')}: ${text('value')}` }
  if (operation === 'set-status') return { oldText: '', newText: `status: ${text('status')}` }
  if (operation === 'attach-source') return { oldText: '', newText: text('source-path') }
  if (operation === 'restore-version') return { oldText: '', newText: `version ${text('version')}` }
  return { oldText: '', newText: '' }
}

/**
 * The Change (or Changes) a shown-first request would become in `ws` as it stands now, or why it
 * cannot be one. `ws` is a Workspace whose reads the caller has already narrowed to documents (the
 * command line's guarded Workspace, the app's document-only view); the path is judged here as well.
 * `stores` is the same Collection's Workspace as the app's own history stores are read through (a
 * version's record and its saved text, for restore-version); it is never used for a path a request names.
 * Never throws, writes nothing.
 */
export async function proposeOutsideChange(ws: Workspace, operation: string, args: Record<string, unknown>, stores: Workspace = ws): Promise<OutsideProposal> {
  const path = typeof args.path === 'string' ? args.path.slice(0, 4096) : ''
  const refused = (reason: string, code: ClosedCode = 'other'): OutsideProposal => ({
    ok: false, reason, code, path,
    summary: `${isShownFirst(operation) ? operation : 'request'}${path ? ` on ${path}` : ''}`.slice(0, MAX_NOTE_CHARS),
    intended: intendedOf(operation, args),
  })
  if (!isShownFirst(operation)) return refused('The request asks for an operation that is not one shown for review.')
  try {
    const built = await BUILDERS[operation](ws, args, stores)
    const tooMany = tooManyChanges(built.changes.length)
    if (tooMany) return refused(tooMany)
    return { ok: true, path: built.path, changes: built.changes }
  } catch (error) {
    if (error instanceof Refusal) return refused(error.message, error.code)
    return refused(`The request could not be checked (${error instanceof Error ? error.message : String(error)}).`)
  }
}

/** A refused request's text as it is kept on its closed Change: cut to a length, marked when cut. */
export function intendedForRecord(intended: { oldText: string; newText: string }): NonNullable<OutsideChangeFields['outsideIntended']> {
  const cut = intended.oldText.length > INTENDED_SHOWN_CHARS || intended.newText.length > INTENDED_SHOWN_CHARS
  return { oldText: intended.oldText.slice(0, INTENDED_SHOWN_CHARS), newText: intended.newText.slice(0, INTENDED_SHOWN_CHARS), cut }
}

/** Why a Change cannot be placed, in words and as a code from the closed list. */
export type Unplaceable = { reason: string; code: ClosedCode }

/** Why a whole-document Change cannot be applied to `content`, or null while `content` is exactly the text it was made over. */
export function wholeDocumentMismatch(change: Change, content: string): Unplaceable | null {
  return content === change.oldText ? null : { reason: `${change.path} has changed since this change was proposed, so it was not applied.`, code: 'document-changed' }
}

/**
 * Why an undecided outside Change can no longer be placed in `content`, or null while it can. The
 * same questions accept asks (agent.ts `resolveChange`), asked without writing: used after another
 * Change to the same document is accepted, so a second edit to the same passage is closed then and
 * does not wait to fail. A whole-document Change can be placed only in exactly the text it was made over.
 */
export function unplaceableIn(change: Change, content: string): Unplaceable | null {
  // A change to the metadata only (filed so, or a whole-document record that changes only the
  // frontmatter): judged inside the frontmatter, as Accept places it (frontmatter-change.ts).
  const metadata = frontmatterEditOf(change)
  if (metadata) {
    const placed = placeInFrontmatter(content, change.path, metadata)
    return 'reason' in placed ? placed : null
  }
  if (isWholeDocumentChange(change)) return wholeDocumentMismatch(change, content)
  try {
    if (change.editClass === 'move') {
      const after = outsideMoveAfterOf(change)
      if (after === null) return null // an in-app move: its own accept path judges it
      resolveProseMove(content, { path: change.path, text: change.oldText, insertAfter: after, summary: '' })
      return null
    }
    if (change.editClass === 'insert') {
      resolveOutsideInsert(content, { path: change.path, insertAfter: change.insertAfter ?? '', text: change.newText })
      return null
    }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error), code: error instanceof PlacementError ? error.code : 'other' }
  }
  // A replacement: the very judgement Accept places it by (ticket 14), so this never closes one Accept would place.
  const placed = placeRecordedReplacement(content, change)
  if (!('reason' in placed)) return null
  // The same judgement, in this sweep's own words where it has them.
  if (anchorContextOf(change) === null && placed.code === 'target-gone') return { reason: `The text this change replaces is no longer in ${change.path}.`, code: 'target-gone' }
  if (anchorContextOf(change) === null && placed.code === 'target-repeated') return { reason: `The text this change replaces now occurs more than once in ${change.path}.`, code: 'target-repeated' }
  return placed
}
