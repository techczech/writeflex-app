/**
 * The decide step of Import, main's side (ADR-0052 § The eight changes 4 and 5, § Rules that must hold; journey J3; Folio versions
 * ticket 16). Electron-free: the stores, the window's binding and the running-order options are passed in.
 *
 * TWO OPERATIONS.
 *  - `readDecideList` READS and writes nothing. It folds the incoming record, the version she started from, the writer's decisions in the
 *    Folio journal, the staged suggestions in the change ledger and the running order as it stands into the list the step draws.
 *  - `decideStructure` is the only writer, and it runs only on the writer's own click. One structure decision per call: add her new section
 *    as a part (or leave it out), use her order for a part that moved (or keep theirs), take a part her file lacks out of the running order
 *    (or keep it). It writes through the Plan's own routes, the ones the Folio page's Put back, move and Take out use (`adoptParts`,
 *    `movePart`, `removePlanParts`), each checked against the running order the writer saw on the very read it is written from, and
 *    records the decision in the Folio journal. (Not the Outline's routes: those refuse a Folio with no manifest, which this step must
 *    still serve.) Nothing here is a verb for an agent.
 *
 * RULES THIS KEEPS (lessons of the reviews of tickets 09 to 15).
 *  - Bound to what the writer saw. The request names the revision, the row and the running order the list showed; if the order has moved,
 *    nothing is written and the list is given again. A row is decided once: a second decision for it is refused.
 *  - Decided under the write turn, from the state NOW. The row, the order and whether it is already decided are all read again inside the
 *    Folio's lock and the Collection's write turn (the lock first, as every Plan write takes them), never taken from the window.
 *  - The window's binding is asked before every write (`confirmOwner`): the new file, the Index Note, the decision. A window that let go of the
 *    Collection part-way stops there.
 *  - Whole or nothing, where it can be. Adding a part is an intent line, a new file, then the running order, then the decision; a stop between
 *    them leaves the file as an ordinary file under Not in the outline (never deleted), the row open, and deciding it again finds that file
 *    and carries on. The intent (the file name chosen and the hash of its bytes, written to the decisions file before the file is made) is what
 *    tells a file this step made from a file the writer made herself: only a file a recorded intent of this revision and row names, holding
 *    those exact bytes, is ever taken up again; a file of hers with the same name and the same bytes is left alone and a fresh name is used.
 *    Taking out and moving write one document each.
 *  - Placing a section of hers stages its suggestions against the part she names. Once any have been filed for that section, the section can
 *    only be placed as that same part: a retry that names another part is refused with a sentence (nothing is staged against the wrong part
 *    and recorded for the right one).
 *  - Never deletes. A part taken out of the running order stays on disk and is listed under Not in the outline. A new part is created
 *    exclusively: an existing file is never overwritten.
 *  - Never falls back to "the same text elsewhere". A part is found by its file (its per-file history follows a move), not by its words.
 *
 * judgement-vs-code: which part a section is was settled in step 2 (matching) or is the writer's answer; this file acts on the answer.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { FolioDecisionChoice, FolioVersion } from '../shared/folio-version-records'
import { isDecisionRow } from '../shared/folio-version-records'
import {
  ALREADY_DECIDED, REVISION_GONE, placedWords, REVISION_WITHDRAWN, STALE_DECISION, STRUCTURE_CHOICES, baseOrder, decidedWords, deriveStructure, finishedVersionName, progressOf,
  type DecideAnswer, type DecideList, type DecidePart, type DecideRefusalCode, type DecideRequest, type DecideSuggestion, type Derived, type StructureRow,
} from '../shared/folio-version-decide'
import { resolveMove } from '../shared/folio-running-order'
import { IMPORT_MAX_DOCX_BYTES } from '../shared/folio-version-import'
import { folioRevisionOf, stagedLine } from '../shared/folio-version-stage'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import { closedReasonOf, undecided, type ChangeStore } from './changes'
import { indexNotePath } from './folio'
import { MANIFEST_NAME } from './folio'
import { planStaging, resolveMatchedParts } from './folio-version-stage'
import { readTextParts } from './folio-version-text'
import { readWordFile } from './word-reader'
import type { VersionReaderSources } from './folio-version-reader'
import type { FolioVersionStore } from './folio-versions'
import { adoptParts, movePart as planMovePart, readPlan, removePlanParts, type Plan, type PlanWriteOptions } from './plan'
import { withPlanLock } from './plan-lock'
import { slugifyFileName, type Workspace } from './workspace'

export type DecideDeps = {
  workspace: Workspace
  folioVersions: Pick<FolioVersionStore, 'get' | 'list' | 'getObject' | 'recordDecision' | 'listDecisions' | 'recordDecisionIntent' | 'listDecisionIntents'>
  changes: Pick<ChangeStore, 'list' | 'addMany' | 'replaceMany' | 'closeMany'>
  reader: VersionReaderSources
  /** A part's bytes as they stand on disk now (the guarded reader); null when it is not there. */
  readWorking: (path: string) => Promise<Buffer | null>
  /** Throws when the window no longer holds the Collection it held when the request began. Asked before every write. */
  confirmOwner: () => Promise<void>
  /** The Plan writes' own options (the checkpoint taken before an Index Note or manifest write). */
  planOptions?: PlanWriteOptions
  /** Told which paths a write touched, so open buffers and the Outline read again. */
  published?: (paths: string[]) => void
}

const MAX_SHOWN_TEXT = 600
const MAX_EXPECTED = 5000

const clip = (text: string): string => (text.length > MAX_SHOWN_TEXT ? `${text.slice(0, MAX_SHOWN_TEXT - 1)}…` : text)
const plain = (deps: DecideDeps, error: unknown): string => withoutAbsolutePaths(error instanceof Error ? error.message : String(error), deps.workspace.root)

class Stop extends Error {
  constructor(readonly code: DecideRefusalCode, message: string, readonly nothingWritten = true) { super(message) }
}

// ---- Reading --------------------------------------------------------------------------------

type Loaded = { version: FolioVersion & { withdrawn?: true }; derived: Derived; list: DecideList; plan: Plan | null }

/** The revision at `dir` and everything the list needs, or why not. Writes nothing. */
async function load(deps: DecideDeps, dir: string, revisionId: string): Promise<Loaded | Stop> {
  let indexPath: string
  try { indexPath = indexNotePath(deps.workspace, dir) } catch { return new Stop('not-found', REVISION_GONE) }
  const own = await deps.folioVersions.list(indexPath).catch(() => null)
  const version = own?.find((entry) => entry.id === revisionId)
  if (!version || !version.incoming) return new Stop('not-found', REVISION_GONE)
  const base = await deps.folioVersions.get(version.incoming.base)
  if (!base) return new Stop('not-found', 'The version this revision started from is not in the history, so its decisions cannot be listed. Nothing was changed.')
  const decisions = await deps.folioVersions.listDecisions(revisionId)
  const derived = deriveStructure(version.incoming, baseOrder(base.members), decisions)
  const plan = await readPlan(deps.workspace, dir).catch(() => null)
  const order = plan ? plan.parts.flatMap((part) => (part.path ? [part.path] : [])) : []
  const titles = new Map([...(plan?.parts ?? []), ...(plan?.unlisted ?? [])].flatMap((part) => (part.path ? [[part.path, part.title] as const] : [])))

  const ledger = (await deps.changes.list()).filter((change) => folioRevisionOf(change)?.revisionId === revisionId)
  const byPath = new Map<string, DecideSuggestion[]>()
  for (const change of ledger) {
    const why = closedReasonOf(change)
    const outcome: DecideSuggestion['outcome'] = undecided(change) ? 'waiting' : change.status === 'accepted' ? 'accepted' : why !== null ? 'closed' : 'declined'
    const kind: DecideSuggestion['kind'] = change.oldText === '' ? 'insert' : change.newText === '' ? 'delete' : 'replace'
    byPath.set(change.path, [...(byPath.get(change.path) ?? []), { id: change.id, kind, oldText: clip(change.oldText.trim()), newText: clip(change.newText.trim()), outcome, ...(why !== null ? { why } : {}) }])
  }
  const parts: DecidePart[] = [...byPath].map(([path, suggestions]) => {
    const at = order.indexOf(path)
    return { path, title: titles.get(path) ?? (posix.basename(path).replace(/\.(md|markdown|mdx)$/i, '')), position: at >= 0 ? at + 1 : null, suggestions }
  }).sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.path.localeCompare(b.path))

  const suggestionTotal = ledger.length
  const suggestionDecided = ledger.filter((change) => !undecided(change)).length
  // Ticket 17: the parts both of you changed, and the rows in them that are yours to decide and are no suggestion in a margin.
  const text = await readTextParts(deps, dir, version, order, ledger).catch(() => ({ parts: [], unmapped: { total: 0, decided: 0 } }))
  const progress = progressOf({ total: suggestionTotal, decided: suggestionDecided }, derived.rows, text.unmapped)
  const withdrawn = version.withdrawn === true
  const complete = !withdrawn && progress.total > 0 && progress.decided === progress.total && derived.matches.every((match) => match.choice !== undefined)
  const list: DecideList = {
    revision: { id: version.id, name: version.name, from: version.incoming.author, by: version.author.name !== version.incoming.author ? version.author.name : null, ts: version.ts, file: version.incoming.docx.name, withdrawn },
    parts, texts: text.parts, rows: derived.rows, matches: derived.matches, placeable: derived.free.map((entry) => ({ label: entry.label, title: entry.title, role: entry.role })), order, progress, complete, offer: complete ? finishedVersionName(version.incoming.author) : null,
  }
  return { version, derived, list, plan }
}

/** The decide list of one incoming revision of the Folio at `dir`; null when there is no such revision. Writes nothing. */
export async function readDecideList(deps: DecideDeps, dir: string, revisionId: string): Promise<DecideList | null> {
  if (typeof revisionId !== 'string') return null
  const loaded = await load(deps, dir, revisionId)
  return loaded instanceof Stop ? null : loaded.list
}

// ---- Deciding -------------------------------------------------------------------------------

const refused = (code: DecideRefusalCode, message: string, nothingWritten = true, list?: DecideList): DecideAnswer => ({ status: 'refused', code, message, nothingWritten, ...(list ? { list } : {}) })

/** The request as main accepts it, or the refusal. Nothing the window sent is trusted: a row, a choice, an order. */
export function checkedDecideRequest(input: unknown): Omit<DecideRequest, 'dir'> | DecideAnswer {
  const bad = refused('bad-request', 'That request was not understood, so nothing was changed.')
  const request = (input ?? {}) as Record<string, unknown>
  if (typeof request.revision !== 'string' || request.revision.length > 100 || !isDecisionRow(request.row) || typeof request.choice !== 'string') return bad
  if (!Array.isArray(request.expected) || request.expected.length > MAX_EXPECTED || request.expected.some((path) => typeof path !== 'string' || path.length > 1000)) return bad
  const kind = request.row.split(':')[0] as 'new' | 'moved' | 'removed' | 'match'
  if (kind === 'match') {
    // Placing a section of hers: `confirm` names the part (a path as the version she started from named it), `none` says it is a new section.
    if (request.choice !== 'confirm' && request.choice !== 'none') return bad
    if (request.choice === 'confirm' && (typeof request.part !== 'string' || request.part === '' || request.part.length > 1000)) return bad
    if (request.choice === 'none' && request.part !== undefined) return bad
    return { revision: request.revision, row: request.row, choice: request.choice, expected: request.expected as string[], ...(request.choice === 'confirm' ? { part: request.part as string } : {}) }
  }
  if (!STRUCTURE_CHOICES[kind].some((entry) => entry.choice === request.choice)) return bad
  return { revision: request.revision, row: request.row, choice: request.choice as FolioDecisionChoice, expected: request.expected as string[] }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((path, at) => path === b[at])

/** Where a part of hers belongs now: the part that follows the nearest earlier section that is in the running order, or null (the very start). */
function placeAfter(derived: Derived, section: number, order: readonly string[], currentPath: (label: string) => string | null, added: ReadonlyMap<number, string>): { after: string | null } | 'none' {
  for (let at = section - 1; at >= 0; at -= 1) {
    const before = derived.sections[at]!
    const path = before.match === 'new' ? added.get(at) ?? null : (before.match === 'exact' || before.match === 'confirmed') && before.part !== undefined ? currentPath(before.part) : null
    if (path !== null && order.includes(path)) return { after: path }
  }
  return { after: null }
}

const beforeOf = (order: readonly string[], after: string | null, moving: string): string | null => {
  const rest = order.filter((path) => path !== moving)
  if (after === null) return rest[0] ?? null
  const at = rest.indexOf(after)
  return at < 0 ? null : rest[at + 1] ?? null
}

const normaliseTitle = (title: string): string => title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/** The heading as it becomes the new part's title line: one line, no markup that would change its meaning. */
function titleOfSection(heading: string): string {
  const one = heading.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return one === '' ? 'Untitled section' : one
}

const sha256Of = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The file a new part is made in: the first name (heading, then heading-2…) that is free, or that holds exactly these bytes AND that a recorded
 * intent of this revision and row names with this hash (a stop part-way). A writer's own file of the same name is never adopted, even with
 * identical bytes: that name is skipped. `intended`: an intent already says this free name will be made with these bytes (no second line).
 */
async function chooseNewPath(deps: DecideDeps, dir: string, title: string, content: string, revision: string, row: string): Promise<{ path: string; exists: boolean; intended: boolean }> {
  const stem = slugifyFileName(title).replace(/\.md$/, '')
  const hash = sha256Of(content)
  const intents = (await deps.folioVersions.listDecisionIntents(revision)).filter((intent) => intent.row === row && intent.sha256 === hash)
  for (let n = 1; n <= 60; n += 1) {
    const name = `${n === 1 ? stem : `${stem}-${n}`}.md`
    const path = dir === '' ? name : `${dir}/${name}`
    const there = await deps.readWorking(path)
    const intended = intents.some((intent) => intent.file === path)
    if (there === null) return { path, exists: false, intended }
    if (intended && sha256Of(there) === hash) return { path, exists: true, intended }
  }
  throw new Stop('not-placeable', 'WriteFlex could not find a free file name for the new part. Nothing was changed.')
}

/** The new parts already added from earlier sections of hers: they were recorded with the file they made, keyed by the section's index. */
async function addedParts(deps: DecideDeps, revision: string): Promise<Map<number, string>> {
  const added = new Map<number, string>()
  for (const entry of await deps.folioVersions.listDecisions(revision)) if (entry.choice === 'add' && entry.part !== undefined && entry.row.startsWith('new:')) added.set(Number(entry.row.slice(4)), entry.part)
  return added
}

type Context = { deps: DecideDeps; dir: string; loaded: Loaded; row: StructureRow; request: Omit<DecideRequest, 'dir'> }

async function owned(deps: DecideDeps): Promise<void> {
  try { await deps.confirmOwner() } catch { throw new Stop('collection-closed', 'WriteFlex no longer has this Collection open in that window. Nothing more was written.', false) }
}

async function currentPathOf(deps: DecideDeps, dir: string, baseId: string, labels: readonly string[]): Promise<Map<string, string | null>> {
  const exists = async (path: string): Promise<boolean> => (await deps.readWorking(path)) !== null
  const parts = await resolveMatchedParts(deps.reader, dir, baseId, labels, exists)
  return new Map(labels.map((label) => [label, parts.get(label)?.path ?? null]))
}

async function record(deps: DecideDeps, revision: string, row: string, choice: FolioDecisionChoice, part?: string): Promise<void> {
  await owned(deps)
  try {
    await deps.folioVersions.recordDecision({ id: revision, row, choice, ...(part !== undefined ? { part } : {}) })
  } catch (error) {
    throw new Stop('not-recorded', `${plain(deps, error)} What you chose was done, but it is not recorded as decided; decide it again and WriteFlex will find it done.`, false)
  }
}

/** Thrown from inside a Plan write's own check (`verifyPlan`) when the running order on the read it is made from is not the one the writer saw. */
class StaleOrder extends Error {}

const orderOf = (plan: Pick<Plan, 'parts'>): string[] => plan.parts.flatMap((part) => (part.path ? [part.path] : []))
/** Every running-order line, an unwritten card as null: the Plan's moves are by this index, not by the files alone. */
const linesOf = (plan: Pick<Plan, 'parts'>): Array<string | null> => plan.parts.map((part) => part.path)

/** The Plan write's own check: refuses, writing nothing, unless the running order on the read the write is made from is `expected` (and, for an add, the file is a part it can put back). */
const verifying = (expected: readonly string[], also?: (plan: Plan) => void): NonNullable<PlanWriteOptions['verifyPlan']> => (plan) => {
  if (!sameList(orderOf(plan), expected)) throw new StaleOrder()
  also?.(plan)
}

/** A Plan write's refusal, as a stop. `written`: the new part's file already exists, so the writer is told where it is. */
function planStop(deps: DecideDeps, error: unknown, written: boolean): Stop {
  if (error instanceof Stop) return error
  if (error instanceof StaleOrder) return new Stop('stale', written ? `${STALE_DECISION} The new part’s file was made and is under Not in the outline; deciding it again will carry on from there.` : STALE_DECISION, !written)
  const message = plain(deps, error)
  return new Stop('not-placeable', written ? `${message} The new part’s file was made and is under Not in the outline; deciding it again will carry on from there.` : `${message} Nothing was changed.`, !written)
}

const publishedBy = (deps: DecideDeps, dir: string, plan: Plan | null, indexPath: string): void => deps.published?.([plan?.indexPath ?? indexPath, dir === '' ? MANIFEST_NAME : `${dir}/${MANIFEST_NAME}`])

async function addPart({ deps, dir, loaded, row, request }: Context): Promise<string> {
  const section = loaded.derived.sections[row.section!]!
  const object = section.object !== undefined ? await deps.folioVersions.getObject(section.object).catch(() => null) : null
  if (section.object !== undefined && object === null) throw new Stop('not-found', 'Her section’s text is not in the history any more, so it cannot be added. Nothing was changed.')
  const title = titleOfSection(section.heading)
  const body = (object?.toString('utf8') ?? '').trim()
  const content = body === '' ? `# ${title}\n` : `# ${title}\n\n${body}\n`
  const plan = loaded.plan
  if (!plan) throw new Stop('not-placeable', 'This Folio’s outline could not be read, so nothing was changed.')
  const target = await chooseNewPath(deps, dir, title, content, request.revision, request.row)
  const order = loaded.list.order
  if (!target.exists) {
    // A part with this title is already in the Folio: two parts with one title cannot be told apart in the running order.
    const clash = [...plan.parts, ...plan.unlisted].some((part) => part.path !== target.path && normaliseTitle(part.title) === normaliseTitle(title))
    if (clash) throw new Stop('not-placeable', `A part called “${title}” is already in this Folio, and two parts with one title cannot be told apart. Leave her section out, or rename that part first. Nothing was changed.`)
  }
  const added = await addedParts(deps, request.revision)
  const baseLabels = loaded.derived.sections.flatMap((entry) => ((entry.match === 'exact' || entry.match === 'confirmed') && entry.part !== undefined ? [entry.part] : []))
  const now = await currentPathOf(deps, dir, loaded.version.incoming!.base, baseLabels)
  const spot = placeAfter(loaded.derived, row.section!, order, (label) => now.get(label) ?? null, added)

  let at = order
  let lines = plan ? linesOf(plan) : order
  if (!target.exists) {
    await owned(deps)
    // The intent first: if this stops after the file is made, the retry can tell this file from one the writer made herself.
    if (!target.intended) {
      try { await deps.folioVersions.recordDecisionIntent({ id: request.revision, row: request.row, file: target.path, sha256: sha256Of(content) }) } catch (error) {
        throw new Stop('not-placeable', `${plain(deps, error)} Nothing was changed.`)
      }
    }
    try { await deps.workspace.createFile(target.path, content, { documentOnly: true }) } catch (error) {
      throw new Stop('not-placeable', `The new part could not be made: ${plain(deps, error)} Nothing was changed.`)
    }
    deps.published?.([target.path])
  }
  if (!order.includes(target.path)) {
    // Put back at the end of the running order, as the Folio page's Put back does: the same Plan write, over the order the writer saw.
    const listed = (await readPlan(deps.workspace, dir).catch(() => null))?.unlisted.findIndex((part) => part.path === target.path) ?? -1
    if (listed < 0) throw new Stop('not-placeable', 'The new part’s file was made, but this Folio cannot list it in its running order. It is under Not in the outline; add it there. Nothing was recorded.', false)
    await owned(deps)
    try {
      const plan = await adoptParts(deps.workspace, dir, [listed], { ...(deps.planOptions ?? {}), verifyPlan: verifying(order, (seen) => { if (seen.unlisted[listed]?.path !== target.path) throw new StaleOrder() }) })
      at = orderOf(plan)
      lines = linesOf(plan)
      publishedBy(deps, dir, plan, loaded.plan?.indexPath ?? '')
    } catch (error) { throw planStop(deps, error, true) }
  }
  if (spot !== 'none' && at.includes(target.path)) {
    const before = beforeOf(at, spot.after, target.path)
    const move = resolveMove(lines, target.path, before)
    if (move && move.from !== move.to) {
      await owned(deps)
      try {
        const plan = await planMovePart(deps.workspace, dir, move.from, move.to, { ...(deps.planOptions ?? {}), verifyPlan: verifying(at) })
        publishedBy(deps, dir, plan, loaded.plan?.indexPath ?? '')
      } catch (error) { throw planStop(deps, error, true) }
    }
  }
  return target.path
}

/**
 * Place a section of hers that matched no part (an agent's import leaves these: it never confirms a match). The writer says which part it is, or
 * that it is a new section. Saying which part STAGES that section's changes as suggestions (the second pass over her stored Word file, by the
 * same planner the import used), and only then records the decision, so a stop in between leaves suggestions and no decision, and deciding
 * again finds them there (they are found by revision and section, never staged twice). Writes no part file.
 */
async function placeSection(deps: DecideDeps, dir: string, loaded: Loaded, request: Omit<DecideRequest, 'dir'>, fresh: () => Promise<DecideList>): Promise<DecideAnswer> {
  const incoming = loaded.version.incoming!
  const row = loaded.derived.matches.find((entry) => entry.key === request.row)
  if (!row) throw new Stop('not-found', 'That is not a section waiting to be placed, so nothing was changed.')
  // A section already placed is no longer unmatched (the decision turns it into a matched or a new section), so it is not listed here: a second placement finds no row.
  if (request.choice === 'none') {
    await record(deps, request.revision, request.row, 'none')
    const list = await fresh()
    return { status: 'done', message: placedWords({ heading: row.heading, choice: 'none' }, null), list }
  }
  const label = request.part!
  const target = loaded.derived.free.find((entry) => entry.label === label)
  if (!target) throw new Stop('not-placeable', 'That part is already matched to another section, or is not a part of the version she started from, so nothing was changed.')
  const bytes = await deps.folioVersions.getObject(incoming.docx.sha256).catch(() => null)
  if (bytes === null) throw new Stop('not-found', 'The Word file of this revision is not in the history any more, so its section cannot be placed. Nothing was changed.')
  const reading = readWordFile(bytes, { maxFileBytes: IMPORT_MAX_DOCX_BYTES })
  if (!reading.ok) throw new Stop('not-placeable', `The stored Word file could not be read again: ${reading.message} Nothing was changed.`)
  const section = reading.sections[row.section]
  if (!section || (section.heading ?? '').slice(0, 500) !== incoming.sections[row.section]!.heading.slice(0, 500)) throw new Stop('not-placeable', 'The stored Word file no longer reads as it did when the revision was brought in, so this section cannot be placed. Nothing was changed.')
  const exists = async (path: string): Promise<boolean> => (await deps.readWorking(path)) !== null
  const parts = await resolveMatchedParts(deps.reader, dir, incoming.base, [label], exists)
  const filed = (await deps.changes.list()).filter((change) => { const marker = folioRevisionOf(change); return marker !== null && marker.revisionId === request.revision && marker.section === row.section })
  const earlier = filed.length > 0
  // Suggestions already filed for this section are against one part. A retry that names another part would record the other part as the answer
  // and leave these waiting in the first one's margin, so it is refused: the section can only be placed as the part they were filed against.
  if (earlier) {
    const against = new Set(filed.map((change) => change.path))
    const now = await currentPathOf(deps, dir, incoming.base, loaded.derived.free.map((entry) => entry.label))
    const here = now.get(label) ?? null
    if (here === null || !against.has(here)) {
      const other = loaded.derived.free.find((entry) => { const path = now.get(entry.label) ?? null; return path !== null && against.has(path) })
      throw new Stop('not-placeable', other
        ? `The suggestions from “${row.heading}” are already filed in the margin of “${other.title}”, so this section can only be placed as that part. Nothing was changed.`
        : `The suggestions from “${row.heading}” are already filed against a different part than the one you chose, so this section cannot be placed as another. Nothing was changed.`)
    }
  }
  let staged = { changes: 0, parts: 0, notStaged: [] as unknown[] }
  if (!earlier) {
    const plan = await planStaging({
      reading, from: incoming.author, revisionId: request.revision, file: incoming.docx.sha256.slice(0, 12), parts, readWorking: deps.readWorking,
      matched: { items: [{ status: 'confirmed', section: { index: row.section, heading: section.heading ?? null }, part: { path: label, title: target.title }, source: 'writer', moved: false }] },
    }).catch((error: unknown) => { throw new Stop('not-placeable', `${plain(deps, error)} Nothing was changed.`) })
    await owned(deps)
    if (plan.changes.length > 0) {
      try { await deps.changes.addMany(plan.changes) } catch (error) { throw new Stop('not-placeable', `The suggestions could not be filed: ${plain(deps, error)} Nothing was changed.`) }
    }
    staged = { changes: plan.changes.length, parts: new Set(plan.entries.map((entry) => entry.part)).size, notStaged: plan.notStaged }
  }
  await record(deps, request.revision, request.row, 'confirm', label)
  const list = await fresh()
  const lead = placedWords({ heading: row.heading, choice: 'confirm', part: label }, target.title)
  return { status: 'done', message: earlier ? lead : `${lead} ${stagedLine({ changes: staged.changes, parts: staged.parts, notStaged: staged.notStaged as never })}`, list }
}

/** Run one structure decision. See the header for what it keeps. */
export async function decideStructure(deps: DecideDeps, dir: string, input: unknown): Promise<DecideAnswer> {
  const request = checkedDecideRequest(input)
  if ('status' in request) return request
  try {
    // The Folio's lock first, then the Collection's write turn: the order every Plan write takes them in.
    return await withPlanLock(deps.workspace, dir, () => deps.workspace.exclusiveAll(async (): Promise<DecideAnswer> => {
      await owned(deps)
      const loaded = await load(deps, dir, request.revision)
      if (loaded instanceof Stop) throw loaded
      if (loaded.list.revision.withdrawn) throw new Stop('withdrawn', REVISION_WITHDRAWN)
      const fresh = (): Promise<DecideList> => load(deps, dir, request.revision).then((again) => (again instanceof Stop ? loaded.list : again.list))
      if (request.row.startsWith('match:')) return await placeSection(deps, dir, loaded, request, fresh)
      const row = loaded.derived.rows.find((entry) => entry.key === request.row)
      if (!row) throw new Stop('not-found', 'That is not a decision this revision asks for, so nothing was changed.')
      if (row.choice !== undefined) throw Object.assign(new Stop('already-decided', ALREADY_DECIDED), { list: await fresh() })
      // Bound to what the writer saw: the running order the list showed is the one this decision is made against.
      if (!sameList(request.expected, loaded.list.order)) throw Object.assign(new Stop('stale', STALE_DECISION), { list: loaded.list })

      const context: Context = { deps, dir, loaded, row, request }
      let part: string | undefined
      let said = ''
      if (row.kind === 'new' && request.choice === 'add') part = await addPart(context)
      else if (row.kind === 'moved' && request.choice === 'hers') part = await movePart(context)
      else if (row.kind === 'removed' && request.choice === 'take-out') ({ part, said } = await takeOut(context))
      await record(deps, request.revision, request.row, request.choice, part)
      const list = await fresh()
      const decided = list.rows.find((entry) => entry.key === request.row) ?? { ...row, choice: request.choice }
      return { status: 'done', message: said || decidedWords(decided), list }
    }))
  } catch (error) {
    if (error instanceof Stop) return refused(error.code, error.message, error.nothingWritten, (error as Stop & { list?: DecideList }).list)
    return refused('not-recorded', `Something went wrong, and WriteFlex cannot say what was written. Check the running order. ${plain(deps, error)}`, false)
  }
}

async function movePart({ deps, dir, loaded, row, request }: Context): Promise<string | undefined> {
  const now = await currentPathOf(deps, dir, loaded.version.incoming!.base, [row.part!, ...loaded.derived.sections.flatMap((entry) => ((entry.match === 'exact' || entry.match === 'confirmed') && entry.part !== undefined ? [entry.part] : []))])
  const path = now.get(row.part!) ?? null
  const order = loaded.list.order
  if (path === null || !order.includes(path)) throw new Stop('not-placeable', `“${row.title}” is not in the outline now, so there is nothing to move. Keep your order, or put it back in the Outline first. Nothing was changed.`)
  // A new section of hers that came before this part in her file and was added as a part is already in the running order: it counts as the part this one follows.
  const spot = placeAfter(loaded.derived, row.section!, order.filter((entry) => entry !== path), (label) => now.get(label) ?? null, await addedParts(deps, request.revision))
  if (spot === 'none') throw new Stop('not-placeable', 'WriteFlex cannot tell where her file puts that part among the parts that are in your running order. Nothing was changed.')
  const before = beforeOf(order, spot.after, path)
  const move = resolveMove(loaded.plan ? linesOf(loaded.plan) : order, path, before)
  if (move && move.from !== move.to) {
    await owned(deps)
    try {
      const plan = await planMovePart(deps.workspace, dir, move.from, move.to, { ...(deps.planOptions ?? {}), verifyPlan: verifying(order) })
      publishedBy(deps, dir, plan, loaded.plan?.indexPath ?? '')
    } catch (error) { throw planStop(deps, error, false) }
  }
  return path
}

async function takeOut({ deps, dir, loaded, row }: Context): Promise<{ part: string | undefined; said: string }> {
  const now = await currentPathOf(deps, dir, loaded.version.incoming!.base, [row.part!])
  const path = now.get(row.part!) ?? null
  const plan = loaded.plan
  if (path === null) return { part: undefined, said: `“${row.title}” is not a file in this Folio any more, so there was nothing to take out. Recorded as decided.` }
  const index = plan ? plan.parts.findIndex((part) => part.path === path) : -1
  if (!plan || index < 0) return { part: path, said: `“${row.title}” was already out of the running order. Its file is under Not in the outline. Recorded as decided.` }
  await owned(deps)
  try {
    // The cards the Plan holds now are the ones `expected` was checked against; removePlanParts checks them again on its own read, and the
    // running order on that read must still be the one the writer saw.
    await removePlanParts(deps.workspace, dir, [index], plan.parts, { ...(deps.planOptions ?? {}), verifyPlan: verifying(loaded.list.order) })
  } catch (error) { throw planStop(deps, error, false) }
  publishedBy(deps, dir, null, plan.indexPath)
  return { part: path, said: '' }
}

