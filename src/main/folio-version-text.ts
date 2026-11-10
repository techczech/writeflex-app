/**
 * The three-text view of a part both sides changed, main's side (ADR-0052 § Decision 1, journey J3; Folio versions ticket 17). Electron-free:
 * the stores and the window's binding are passed in.
 *
 * TWO OPERATIONS.
 *  - `readThreeText` READS and writes nothing: the part as it was sent, her section as the import stored it, and the part now, aligned by the
 *    pure function in `shared/folio-version-align.ts`, with each row's state taken from the change ledger and the decisions file.
 *  - `decideText` is the only writer, and runs only on the writer's own click. One row per call.
 *      Use theirs  stage her paragraphs over the writer's as ONE suggestion in the part's margin (attributed to her, placed as whole paragraphs
 *                  with ~300 characters of context, as ticket 15 stages), then tell the window to ACCEPT it through the one Accept every
 *                  proposal has. This file never writes a part: the text gets there by that route, with its restore point, its guarded write
 *                  and its check that the paragraph is still where it was recorded.
 *      Keep mine   nothing is written to the part. Where her change is already a suggestion waiting in the margin the window DECLINES it
 *                  there; otherwise the decision is recorded in `.writeflex/folio-decisions.jsonl` (never the Folio journal: the frozen alpha.9
 *                  backup helper must keep projecting cleanly).
 *      Edit by hand  stage her paragraphs as a suggestion that waits in the margin (her text and the writer's text on one card), or find
 *                  the one already waiting; the window opens the part. Nothing is decided: the suggestion is decided in the margin.
 *
 * RULES THIS KEEPS (lessons of the reviews of tickets 09 to 16).
 *  - Bound to what the writer saw. The request carries the sha256 of the sent text, her text and the part's bytes as the writer's view was read;
 *    all three are read again inside the Collection's write turn and any difference refuses, writing nothing, with a sentence and the fresh view.
 *  - The window's binding to the Collection is asked before every write (the suggestion, the decision) and again at the start.
 *  - A row wider than the suggestions in the margin (it covers several, or a different span from one) COVERS the undecided ones that lie within it (`coveredBy`).
 *    Keep mine closes them, then records the decision; Use theirs and Edit by hand file one suggestion over the whole row and close them in the same ledger write.
 *  - Whole or nothing: one suggestion is filed by one ledger write, or one decision line is appended; a stop leaves nothing half done, and the same
 *    request again finds what is there (a waiting suggestion of the row is reused, never filed twice).
 *  - Text is placed on WHOLE paragraphs plus context, by the placement ticket 15 uses (`placeHunk`); there is no "the text stands once elsewhere"
 *    fallback. What cannot be placed is refused in words and left to the writer's hands.
 *  - Never decided by an agent: no verb, request or permission switch reaches `decideText`; the IPC channels are the window's.
 *
 * judgement-vs-code: which part a section is was settled in step 2 (or is the writer's answer); two paragraphs are the same when their words are
 * (white space collapsed). Which text is better is the writer's.
 */
import { createHash } from 'node:crypto'
import type { Change, NewChange } from '../engine'
import { alignThreeWay, needsDecision, squashParagraph, whoChanged, type AlignRow } from '../shared/folio-version-align'
import { effectiveSections, type DecideTextPart, type EffectiveSection } from '../shared/folio-version-decide'
import { isSha256, type FolioDecision, type FolioVersion } from '../shared/folio-version-records'
import { NOT_STAGED_WORDS, folioRevisionOf, type FolioRevisionMarker } from '../shared/folio-version-stage'
import {
  KEPT_MESSAGE, TEXT_ALREADY_DECIDED, TEXT_BAD_REQUEST, TEXT_CHOICES, TEXT_NOT_FOUND, TEXT_NOTHING_TO_DECIDE, TEXT_STALE, handMessage, isSettled,
  type TextAnswer, type TextChoice, type TextDecideRequest, type TextRefusalCode, type TextRowState, type ThreeText, type ThreeTextRead, type ThreeTextRow, type ThreeTextSeen,
} from '../shared/folio-version-text'
import { closedReasonOf, undecided, type AnchorContext, type ChangeStore } from './changes'
import { indexNotePath } from './folio'
import { bodyBelowTitle, placeHunk, resolveMatchedParts, summaryOf, type Hunk, type PlanPart } from './folio-version-stage'
import type { VersionReaderSources } from './folio-version-reader'
import type { FolioVersionStore } from './folio-versions'
import { markdownBlocks } from './markdown-blocks'
import { unplaceableIn } from './outside-change'
import { readPlan } from './plan'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import type { Workspace } from './workspace'

export type TextDeps = {
  workspace: Workspace
  folioVersions: Pick<FolioVersionStore, 'list' | 'getObject' | 'recordDecision' | 'listDecisions'>
  changes: Pick<ChangeStore, 'list' | 'addMany' | 'replaceMany' | 'closeMany'>
  reader: VersionReaderSources
  /** A part's bytes as they stand on disk now (the guarded reader); null when it is not there. */
  readWorking: (path: string) => Promise<Buffer | null>
  /** Throws when the window no longer holds the Collection it held when the request began. */
  confirmOwner: () => Promise<void>
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const plain = (deps: TextDeps, error: unknown): string => withoutAbsolutePaths(error instanceof Error ? error.message : String(error), deps.workspace.root)

class Stop extends Error {
  constructor(readonly code: TextRefusalCode, message: string, readonly nothingWritten = true, readonly text?: ThreeText) { super(message) }
}

/** Why a suggestion that could not be placed any more was closed when the writer chose again over the text as it stands. Written only in the same ledger write that files its replacement. */
const REPLACED_REASON = 'It could not be placed over the text as it stands now, so a fresh suggestion over the current text replaced it.'
/** Why a smaller suggestion was closed when the writer decided the whole row it lies within. Written in the same ledger write that files the row's fresh suggestion. */
const COVERED_REPLACED_REASON = 'Her change was filed again over the whole of the paragraphs it lies in, so this smaller suggestion was closed in its favour.'
/** Why the suggestions within a row were closed when the writer kept their own text. */
const COVERED_KEPT_REASON = 'You kept your own text in the three texts.'
type Replacing = Array<{ id: string; reason: string; code: 'target-gone' | 'other' }>
const MAX_PART_BYTES = 4 * 1024 * 1024
const MAX_SHOWN_PARAGRAPH = 20_000

// ---- Analysing one part -----------------------------------------------------------------------------------

type Blocks = ReturnType<typeof markdownBlocks>
type Side = { body: string; blocks: Blocks }
const sideOf = (body: string): Side => ({ body, blocks: markdownBlocks(body) })
/** The exact Markdown of paragraphs `from` to `to` of a side (blank lines between them kept), or '' when there are none. */
const sliceOf = (side: Side, range: { from: number; to: number }): string => (range.to > range.from ? side.body.slice(side.blocks[range.from]!.from, side.blocks[range.to - 1]!.to) : '')
const textsOf = (side: Side, range: { from: number; to: number }): string[] => side.blocks.slice(range.from, range.to).map((block) => block.text)

type Analysis = {
  version: FolioVersion
  section: EffectiveSection & { part: string }
  part: PlanPart & { path: string }
  sent: Side
  hers: Side
  yours: Side
  /** The part's full text now, as the placement works over it. */
  current: string
  seen: ThreeTextSeen
  rows: AlignRow[]
}

type Analysed = { kind: 'ready'; analysis: Analysis } | { kind: 'unavailable'; why: string }

/** Everything the view and a decision need for one matched section, or why not. Reads only. */
async function analyseSection(deps: TextDeps, dir: string, version: FolioVersion, section: EffectiveSection & { part: string }, part: PlanPart): Promise<Analysed> {
  if (part.path === null) return { kind: 'unavailable', why: 'That part is not a Markdown file in this Folio any more.' }
  if (part.baseText === null) return { kind: 'unavailable', why: 'The version she started from has no saved text for that part.' }
  if (section.object === undefined) return { kind: 'unavailable', why: 'Her section’s text is not in the history, so there is nothing to put beside yours.' }
  const [objectBytes, workingBytes] = await Promise.all([deps.folioVersions.getObject(section.object).catch(() => null), deps.readWorking(part.path)])
  if (objectBytes === null) return { kind: 'unavailable', why: 'Her section’s text is not in the history any more, so it cannot be put beside yours.' }
  if (workingBytes === null) return { kind: 'unavailable', why: 'That part is not a file in this Folio any more.' }
  if (workingBytes.length > MAX_PART_BYTES || objectBytes.length > MAX_PART_BYTES || Buffer.byteLength(part.baseText) > MAX_PART_BYTES) return { kind: 'unavailable', why: 'This part is too long to lay three texts side by side.' }
  const current = workingBytes.toString('utf8')
  const sent = sideOf(bodyBelowTitle(part.baseText))
  const hers = sideOf(objectBytes.toString('utf8').trim())
  const yours = sideOf(bodyBelowTitle(current))
  const rows = alignThreeWay(sent.blocks.map((block) => block.text), hers.blocks.map((block) => block.text), yours.blocks.map((block) => block.text))
  if (rows === null) return { kind: 'unavailable', why: 'This part is too long to lay three texts side by side.' }
  return {
    kind: 'ready',
    analysis: { version, section, part: { ...part, path: part.path }, sent, hers, yours, current, seen: { sent: sha256(sent.body), hers: sha256(hers.body), yours: sha256(workingBytes) }, rows },
  }
}

/** The row's own digest: the sha256 of its three texts. A decision is recorded with it. */
const rowSeen = (a: Analysis, row: AlignRow): string => sha256(JSON.stringify([sliceOf(a.sent, row.sent), sliceOf(a.hers, row.hers), sliceOf(a.yours, row.yours)]))

/** The keys of the rows that are not `same`, in order. Stable while the sent text and her text are: they depend on nothing the writer types (so a decision is bound to the row's digest, `rowSeen`, as well). */
function keysOf(a: Analysis): string[] {
  const seen = new Map<string, number>()
  return a.rows.map((row) => {
    if (row.kind === 'same') return ''
    const hash = sha256(`${sliceOf(a.sent, row.sent)}\u0001${sliceOf(a.hers, row.hers)}`).slice(0, 16)
    const at = seen.get(hash) ?? 0
    seen.set(hash, at + 1)
    return `text:${a.section.index}:${hash}:${at}`
  })
}

type Mapped = { change: Change; state: TextRowState; why?: string }

/** The suggestion in the margin that is this row's: the one staged for the row's key, or one of the import's whose old and new text are the row's. */
function mapChange(a: Analysis, row: AlignRow, key: string, mine: readonly Change[], used: Set<string>): Mapped | null {
  const stateOf = (change: Change): Mapped => {
    const why = closedReasonOf(change)
    const state: TextRowState = undecided(change) ? 'waiting' : change.status === 'accepted' ? 'accepted' : why !== null ? 'closed' : 'declined'
    return { change, state, ...(why !== null ? { why } : {}) }
  }
  const byKey = mine.filter((change) => !used.has(change.id) && folioRevisionOf(change)?.row === key)
  // A suggestion staged for this very row that waits or was decided; a closed one is passed over for a live one.
  const keyed = byKey.find((change) => closedReasonOf(change) === null) ?? byKey[0]
  if (keyed) { used.add(keyed.id); return stateOf(keyed) }
  if (!needsDecision(row)) return null
  const oldText = squashParagraph(sliceOf(a.yours, row.yours))
  const newText = squashParagraph(sliceOf(a.hers, row.hers))
  const found = mine.find((change) => !used.has(change.id) && folioRevisionOf(change)?.row === undefined && folioRevisionOf(change)?.section === a.section.index
    && squashParagraph(change.oldText) === oldText && squashParagraph(change.newText) === newText)
  if (!found) return null
  used.add(found.id)
  return stateOf(found)
}

/**
 * The undecided suggestions of the import that lie WITHIN a row that has no suggestion of its own (no keyed one, no exact match): the row is wider than the suggestion
 * (it covers several, or a different span from one). The alignment may group paragraphs differently from the staging (an older staging by compatibility form, or two
 * adjacent paragraphs she changed that staging filed apart). A suggestion is within the row when
 *  - a replacement or deletion: its old text is part of the row's text now and its new text part of hers;
 *  - an insertion: its new text is part of hers, and the paragraph it follows is in the row or just before it.
 * Texts are compared by `squashParagraph`, as the alignment does. A suggestion already used by another row is never taken.
 */
function coveredBy(a: Analysis, row: AlignRow, mine: readonly Change[], used: ReadonlySet<string>): Change[] {
  const yours = squashParagraph(sliceOf(a.yours, row.yours))
  const hers = squashParagraph(sliceOf(a.hers, row.hers))
  const before = row.yours.from > 0 ? squashParagraph(a.yours.blocks[row.yours.from - 1]!.text) : ''
  return mine.filter((change) => {
    if (used.has(change.id) || !undecided(change)) return false
    const marker = folioRevisionOf(change)
    if (marker === null || marker.row !== undefined || marker.section !== a.section.index) return false
    const added = squashParagraph(change.newText)
    if (added !== '' && !hers.includes(added)) return false
    const old = squashParagraph(change.oldText)
    if (old !== '') return yours.includes(old) && (added === '' || hers.includes(added))
    // An insertion: nothing to replace, so its new text must be there and its place must be in or just before the row.
    if (added === '') return false
    const after = squashParagraph(change.insertAfter ?? '')
    return after !== '' && (yours.includes(after) || before.includes(after))
  })
}

type Built = { rows: ThreeTextRow[]; keys: string[]; mapped: Array<Mapped | null>; covers: Change[][] }

function buildRows(a: Analysis, ledger: readonly Change[], decisions: readonly Pick<FolioDecision, 'row' | 'choice' | 'part' | 'seen'>[]): Built {
  const keys = keysOf(a)
  const used = new Set<string>()
  const mine = ledger.filter((change) => folioRevisionOf(change)?.revisionId === a.version.id && change.path === a.part.path)
  const mapped: Array<Mapped | null> = a.rows.map((row, at) => (row.kind === 'same' ? null : mapChange(a, row, keys[at]!, mine, used)))
  // A row left without a suggestion of its own takes the undecided ones that lie within it. Taken after every row has had its exact match, so the loose pass never
  // robs an exact one, and each suggestion belongs to one row.
  const covers: Change[][] = a.rows.map((row, at) => {
    if (row.kind === 'same' || mapped[at] !== null || !needsDecision(row)) return []
    const taken = coveredBy(a, row, mine, used)
    for (const change of taken) used.add(change.id)
    return taken
  })
  const rows = a.rows.map((row, at): ThreeTextRow => {
    const key = keys[at]!
    const found = mapped[at]!
    let state: TextRowState
    if (!needsDecision(row)) state = found?.state === 'accepted' ? 'accepted' : 'self'
    else if (found) state = found.state
    else {
      // Kept only over the three texts it was kept over, in this part: the writer who has edited that paragraph since has a row to decide again.
      const digest = rowSeen(a, row)
      state = decisions.some((entry) => entry.row === key && entry.choice === 'mine' && entry.seen === digest && entry.part === a.part.path) ? 'kept' : 'open'
    }
    const clip = (list: string[]): string[] => list.map((text) => (text.length > MAX_SHOWN_PARAGRAPH ? `${text.slice(0, MAX_SHOWN_PARAGRAPH)}…` : text))
    return {
      key, kind: row.kind, herChange: row.herChange, yourChange: row.yourChange,
      sent: clip(textsOf(a.sent, row.sent)), hers: clip(textsOf(a.hers, row.hers)), yours: clip(textsOf(a.yours, row.yours)),
      state, ...(found ? { changeId: found.change.id } : {}), ...(found?.why !== undefined ? { why: found.why } : {}),
    }
  })
  return { rows, keys, mapped, covers }
}

// ---- Reading ------------------------------------------------------------------------------------------------

type Opened = { version: FolioVersion & { withdrawn?: true }; sections: Array<EffectiveSection & { part: string }>; parts: Map<string, PlanPart>; decisions: FolioDecision[] }

/** The incoming revision at `dir`, the sections of hers that match a part, and where each part is now. Reads only. */
async function open(deps: TextDeps, dir: string, revisionId: string): Promise<Opened | Stop> {
  let indexPath: string
  try { indexPath = indexNotePath(deps.workspace, dir) } catch { return new Stop('not-found', TEXT_NOT_FOUND) }
  const own = await deps.folioVersions.list(indexPath).catch(() => null)
  const version = own?.find((entry) => entry.id === revisionId)
  if (!version?.incoming) return new Stop('not-found', 'That revision is not in this Folio any more, so nothing was changed.')
  const decisions = await deps.folioVersions.listDecisions(revisionId)
  const sections = effectiveSections(version.incoming, decisions).filter((section): section is EffectiveSection & { part: string } => (section.match === 'exact' || section.match === 'confirmed') && section.part !== undefined)
  const exists = async (path: string): Promise<boolean> => (await deps.readWorking(path)) !== null
  const parts = await resolveMatchedParts(deps.reader, dir, version.incoming.base, sections.map((section) => section.part), exists)
  return { version, sections, parts, decisions }
}

async function positionOf(deps: TextDeps, dir: string, path: string): Promise<number | null> {
  const plan = await readPlan(deps.workspace, dir).catch(() => null)
  const at = plan ? plan.parts.findIndex((part) => part.path === path) : -1
  return at >= 0 ? at + 1 : null
}

function threeTextOf(deps: TextDeps, opened: Opened, a: Analysis, built: Built, position: number | null): ThreeText {
  const changed = built.rows.filter((row) => row.kind !== 'same')
  return {
    revision: { id: opened.version.id, name: opened.version.name, from: opened.version.incoming!.author },
    part: { path: a.part.path, title: a.part.title, position },
    section: { index: a.section.index, heading: a.section.heading },
    rows: built.rows,
    seen: a.seen,
    counts: { changed: changed.length, settled: changed.filter((row) => isSettled(row.state)).length },
  }
}

/** The three texts of the part at `partPath` for the revision, or why not. Writes nothing. */
export async function readThreeText(deps: TextDeps, dir: string, revisionId: string, partPath: string): Promise<ThreeTextRead | null> {
  if (typeof revisionId !== 'string' || typeof partPath !== 'string') return null
  const opened = await open(deps, dir, revisionId)
  if (opened instanceof Stop) return { unavailable: opened.message }
  const section = opened.sections.find((entry) => opened.parts.get(entry.part)?.path === partPath)
  if (!section) return { unavailable: 'No section of the Word file is matched to that part, so there is no second text to put beside yours.' }
  const analysed = await analyseSection(deps, dir, opened.version, section, opened.parts.get(section.part)!)
  if (analysed.kind === 'unavailable') return { unavailable: analysed.why }
  const ledger = await deps.changes.list()
  return threeTextOf(deps, opened, analysed.analysis, buildRows(analysed.analysis, ledger, opened.decisions), await positionOf(deps, dir, partPath))
}

/**
 * The parts of an incoming revision that the three-text view is for, and what they add to the progress: parts both sides changed, and parts with a
 * change of hers that is not a suggestion in a margin (the import could not stage it). `unmapped` counts the rows that are the writer's to decide and are
 * NOT a suggestion in a margin (the ledger counts those): `decided` of them are kept as the writer's. Reads only; a part that cannot be read is left out.
 */
export async function readTextParts(deps: TextDeps, dir: string, version: FolioVersion, order: readonly string[], ledger: readonly Change[]): Promise<{ parts: DecideTextPart[]; unmapped: { total: number; decided: number } }> {
  const out: DecideTextPart[] = []
  const unmapped = { total: 0, decided: 0 }
  const opened = await open(deps, dir, version.id)
  if (opened instanceof Stop) return { parts: out, unmapped }
  for (const section of opened.sections) {
    const part = opened.parts.get(section.part)
    if (!part) continue
    const analysed = await analyseSection(deps, dir, opened.version, section, part).catch(() => null)
    if (analysed === null || analysed.kind !== 'ready') continue
    const a = analysed.analysis
    const built = buildRows(a, ledger, opened.decisions)
    const who = whoChanged(a.rows)
    // A row the writer decides that is no suggestion in a margin (open, kept, or closed without being applied) is not in the ledger's count.
    const loose = built.rows.filter((row) => row.state === 'open' || row.state === 'closed' || row.state === 'kept')
    if (!(who.hers && who.yours) && loose.length === 0) continue
    unmapped.total += loose.length
    unmapped.decided += loose.filter((row) => row.state === 'kept').length
    const changed = built.rows.filter((row) => row.kind !== 'same')
    out.push({
      path: a.part.path, title: a.part.title, position: order.indexOf(a.part.path) >= 0 ? order.indexOf(a.part.path) + 1 : null,
      section: section.index, heading: section.heading, both: who.hers && who.yours,
      total: changed.length, settled: changed.filter((row) => isSettled(row.state)).length,
    })
  }
  out.sort((x, y) => (x.position ?? Number.MAX_SAFE_INTEGER) - (y.position ?? Number.MAX_SAFE_INTEGER) || x.path.localeCompare(y.path))
  return { parts: out, unmapped }
}

// ---- Deciding ---------------------------------------------------------------------------------------------

const refused = (code: TextRefusalCode, message: string, nothingWritten = true, text?: ThreeText): TextAnswer => ({ status: 'refused', code, message, nothingWritten, ...(text ? { text } : {}) })

/** The request as main accepts it, or the refusal. Nothing the window sent is trusted: a path, a row, a choice, a hash. */
export function checkedTextRequest(input: unknown): Omit<TextDecideRequest, 'dir'> | TextAnswer {
  const bad = refused('bad-request', TEXT_BAD_REQUEST)
  const request = (input ?? {}) as Record<string, unknown>
  if (typeof request.revision !== 'string' || request.revision.length > 100 || typeof request.part !== 'string' || request.part === '' || request.part.length > 1000) return bad
  if (typeof request.row !== 'string' || !/^text:\d{1,6}:[a-f0-9]{16}:\d{1,4}$/.test(request.row)) return bad
  if (typeof request.choice !== 'string' || !(TEXT_CHOICES as readonly string[]).includes(request.choice)) return bad
  const seen = (request.seen ?? {}) as Record<string, unknown>
  if (!isSha256(seen.sent) || !isSha256(seen.hers) || !isSha256(seen.yours)) return bad
  return { revision: request.revision, part: request.part, row: request.row, choice: request.choice as TextChoice, seen: { sent: seen.sent, hers: seen.hers, yours: seen.yours } }
}

async function owned(deps: TextDeps): Promise<void> {
  try { await deps.confirmOwner() } catch { throw new Stop('collection-closed', 'WriteFlex no longer has this Collection open in that window. Nothing more was written.', false) }
}

/** Her paragraphs over the writer's, as the one hunk the placement of ticket 15 places: replace, insert after the paragraph before, or delete. */
function hunkOf(a: Analysis, row: AlignRow): Hunk {
  const old = sliceOf(a.yours, row.yours)
  const neu = sliceOf(a.hers, row.hers)
  if (old === '') return { kind: 'insert', old, neu, ...(row.yours.from > 0 ? { after: a.yours.blocks[row.yours.from - 1]!.text } : {}), tracked: 0 }
  return { kind: neu === '' ? 'delete' : 'replace', old, neu, tracked: 0 }
}

/**
 * File her paragraphs over the writer's as one suggestion in the part's margin. Returns its id; throws a Stop, with nothing written, when it cannot be placed or filed.
 * `replacing`: the waiting suggestions this one takes the place of: one of the row that can no longer be placed, or every suggestion that lies within a row wider than
 * they are. The fresh one is prepared and checked FIRST; then the old ones are closed and the new one filed in ONE write of the ledger (`replaceMany`), so a failure of
 * any kind leaves the old suggestions exactly as they were, waiting, and nothing is claimed to have replaced them.
 */
async function stageRow(deps: TextDeps, a: Analysis, row: AlignRow, key: string, replacing: Replacing = []): Promise<string> {
  const hunk = hunkOf(a, row)
  const placed = placeHunk(a.current, hunk)
  const stop = (reason: keyof typeof NOT_STAGED_WORDS): Stop => new Stop('not-placeable', `${NOT_STAGED_WORDS[reason]} Their text stays in the three texts here; edit the part by hand. Nothing was changed.`)
  if ('reason' in placed) throw stop(placed.reason)
  const incoming = a.version.incoming!
  const heading = a.section.heading.slice(0, 500)
  const marker: FolioRevisionMarker = { revisionId: a.version.id, reviewer: incoming.author, section: a.section.index, heading, tracked: 0, file: incoming.docx.sha256.slice(0, 12), row: key }
  const change: NewChange & { folioRevision: FolioRevisionMarker; reviewerLabel: string } & AnchorContext = {
    path: a.part.path, provenance: 'agent', editClass: placed.insertAfter !== undefined ? 'insert' : 'content', category: 'other',
    summary: summaryOf(hunk, a.part.title, incoming.author),
    oldText: placed.oldText, newText: placed.newText, isCorrection: false, author: { name: incoming.author }, reviewerLabel: incoming.author, folioRevision: marker,
    ...(placed.insertAfter !== undefined ? { insertAfter: placed.insertAfter } : { anchor: placed.anchor }),
    ...(placed.context ? { anchorContext: placed.context } : {}),
  }
  // The very judgement Accept places a record by: a change Accept could not place is never filed.
  if (unplaceableIn({ ...change, id: 'probe', ts: 0, status: 'pending' } as Change, a.current)) throw stop(placed.insertAfter !== undefined ? 'no-place' : 'text-changed')
  await owned(deps)
  try {
    if (replacing.length > 0) return (await deps.changes.replaceMany(replacing, [change]))[0]!.id
    return (await deps.changes.addMany([change]))[0]!.id
  } catch (error) {
    const why = plain(deps, error).trim()
    throw new Stop('not-placeable', `The suggestion could not be filed: ${why}${/[.!?]$/.test(why) ? '' : '.'} Nothing was changed.`)
  }
}

/** Decide one row of the three texts. See the header for what each choice does and what it keeps. */
export async function decideText(deps: TextDeps, dir: string, input: unknown): Promise<TextAnswer> {
  const request = checkedTextRequest(input)
  if ('status' in request) return request
  try {
    return await deps.workspace.exclusiveAll(async (): Promise<TextAnswer> => {
      await owned(deps)
      const opened = await open(deps, dir, request.revision)
      if (opened instanceof Stop) throw opened
      if (opened.version.withdrawn === true) throw new Stop('withdrawn', 'That revision is withdrawn, so there is nothing to decide. Nothing was changed.')
      const section = opened.sections.find((entry) => opened.parts.get(entry.part)?.path === request.part)
      if (!section) throw new Stop('not-found', TEXT_NOT_FOUND)
      const analysed = await analyseSection(deps, dir, opened.version, section, opened.parts.get(section.part)!)
      if (analysed.kind === 'unavailable') throw new Stop('not-found', `${analysed.why} Nothing was changed.`)
      const a = analysed.analysis
      const view = async (): Promise<ThreeText> => {
        const ledger = await deps.changes.list()
        const decisions = await deps.folioVersions.listDecisions(request.revision)
        const again = await analyseSection(deps, dir, opened.version, section, opened.parts.get(section.part)!)
        const target = again.kind === 'ready' ? again.analysis : a
        return threeTextOf(deps, opened, target, buildRows(target, ledger, decisions), await positionOf(deps, dir, request.part))
      }
      // Bound to what the writer saw: all three texts, read again now.
      if (a.seen.sent !== request.seen.sent || a.seen.hers !== request.seen.hers || a.seen.yours !== request.seen.yours) throw new Stop('stale', TEXT_STALE, true, await view())

      const ledger = await deps.changes.list()
      const built = buildRows(a, ledger, opened.decisions)
      const at = built.keys.indexOf(request.row)
      if (at < 0) throw new Stop('not-found', TEXT_NOT_FOUND, true, await view())
      const row = a.rows[at]!
      const shown = built.rows[at]!
      if (!needsDecision(row)) throw new Stop('nothing-to-decide', TEXT_NOTHING_TO_DECIDE, true, await view())
      if (shown.state === 'accepted' || shown.state === 'declined' || shown.state === 'kept') throw new Stop('already-decided', TEXT_ALREADY_DECIDED, true, await view())
      const waiting = shown.state === 'waiting' && shown.changeId !== undefined ? shown.changeId : null
      // A suggestion that waits but could not be placed over the text as it stands now (a neighbouring paragraph was accepted since, and the words around it were kept
      // on its record) can never be accepted. Choosing theirs or editing by hand replaces it with a fresh one over the text the writer is looking at, in one write of the
      // ledger (the old one is closed only together with the fresh one being filed: if that fails it still waits); keeping mine declines it as it is.
      const stale = waiting !== null && request.choice !== 'mine' ? built.mapped[at]?.change : undefined
      const staleOne = stale && unplaceableIn(stale, a.current) ? stale : null
      // The suggestions that lie within an open row (it covers several, or a different span from one). Choosing theirs or editing by hand files her paragraphs as one
      // suggestion and closes these in the same write; keeping mine closes them and records the decision.
      const covered = built.covers[at] ?? []
      const replacing: Replacing = staleOne !== null ? [{ id: staleOne.id, reason: REPLACED_REASON, code: 'target-gone' }]
        : covered.map((change) => ({ id: change.id, reason: COVERED_REPLACED_REASON, code: 'other' as const }))
      const usable = staleOne === null ? waiting : null

      if (request.choice === 'mine') {
        if (waiting !== null) return { status: 'resolve', changeId: waiting, path: a.part.path, action: 'reject' }
        await owned(deps)
        // The suggestions within the row are closed FIRST, in one write, then the decision is recorded: a stop between the two leaves the row open with nothing waiting in
        // it (the same request again records the decision), never a decision beside a suggestion the writer could still accept.
        let closedFirst = false
        if (covered.length > 0) {
          try {
            await deps.changes.closeMany(covered.map((change) => ({ id: change.id, reason: COVERED_KEPT_REASON, code: 'other' as const })))
            closedFirst = true
          } catch (error) {
            throw new Stop('not-recorded', `${plain(deps, error)} Nothing was changed.`)
          }
          await owned(deps)
        }
        try {
          await deps.folioVersions.recordDecision({ id: request.revision, row: request.row, choice: 'mine', part: a.part.path, seen: rowSeen(a, row) })
        } catch (error) {
          throw new Stop('not-recorded', closedFirst
            ? `${plain(deps, error)} Your text in the part was not changed. The suggestion${covered.length === 1 ? '' : 's'} of hers within this row ${covered.length === 1 ? 'was' : 'were'} closed, but the decision was not recorded: choose Keep mine again.`
            : `${plain(deps, error)} Nothing was changed.`, !closedFirst)
        }
        return { status: 'done', message: KEPT_MESSAGE, text: await view() }
      }
      if (request.choice === 'theirs') return { status: 'resolve', changeId: usable ?? await stageRow(deps, a, row, request.row, replacing), path: a.part.path, action: 'accept' }
      // Edit by hand: her text waits in the margin beside the writer's. Where it cannot be placed as a suggestion the writer still gets the part.
      let changeId = usable
      let message = handMessage(a.part.title)
      if (changeId === null) {
        try { changeId = await stageRow(deps, a, row, request.row, replacing) } catch (error) {
          if (!(error instanceof Stop) || error.code !== 'not-placeable') throw error
          message = `${error.message.replace(/ Nothing was changed\.$/, '')} The part is open for you.`
        }
      }
      return { status: 'hand', path: a.part.path, message, ...(changeId !== null ? { changeId } : {}) }
    })
  } catch (error) {
    if (error instanceof Stop) return refused(error.code, error.message, error.nothingWritten, error.text)
    return refused('not-recorded', `Something went wrong, and WriteFlex cannot say what was written. Check the part’s margin. ${plain(deps, error)}`, false)
  }
}
