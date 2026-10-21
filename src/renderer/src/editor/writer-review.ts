/**
 * Writer review: the Drafting capture (pending writer changes) and the Reviewing marks.
 *
 * Invariants of the ledger after ANY sequence of edits, untracked edits, reconciles, undos and redos
 * (tests/main/writer-pending-change-invariants.test.ts checks each over seeded random sequences):
 * - I1 Totality: nothing here throws; the repair guards (soundCapture, marksWithin, the stale-range
 *   report) never have to fire.
 * - I2 Preservation: a record or mark that no change touches survives with the same id, old text and
 *   new text, its position mapped by mapPos — through undo and redo too.
 * - I3 Undo then redo restores document, records, marks and mode exactly.
 * - I4 Locality in Reviewing: rejecting a record changes exactly its own range (its new text replaced
 *   by its old text), accepting removes exactly its strike, the record leaves the marks, and
 *   documentTextForPersistence is the buffer minus every old-role span.
 * - I5 (test-only) the random sequences run with a non-empty ledger on at least 40% of steps.
 * Mechanisms: every document change maps the ledger (nextDraftingCapture, writerReviewField); a change
 * nothing records maps by the untracked rules (mapUntracked, mapMarksUntracked); undo snapshots are
 * rebased by CodeMirror's own history changes (editor/history-snapshot.ts), never by diffing texts.
 */
import { Annotation, ChangeSet, EditorSelection, Transaction as TransactionClass, EditorState, Facet, StateEffect, StateField, type ChangeDesc, type ChangeSpec, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { historySnapshots } from './history-snapshot'

export type WriterReviewMode = 'drafting' | 'reviewing'

export type WriterTrackedRole = 'old' | 'new'

export type WriterTrackedMark = {
  id: string
  role: WriterTrackedRole
  from: number
  to: number
  createdAt: number
}

export type WriterPendingChange = {
  localId: string
  oldText: string
  newText: string
  anchor: { from: number; to: number }
  createdAt: number
}

type WriterReviewState = {
  mode: WriterReviewMode
  marks: WriterTrackedMark[]
  deco: DecorationSet
}

export const setWriterMode = StateEffect.define<WriterReviewMode>()
export const clearWriterReviewChanges = StateEffect.define<void>()
export const skipWriterReviewTracking = Annotation.define<boolean>()
const addWriterMarks = StateEffect.define<WriterTrackedMark[]>()
const setWriterMarks = StateEffect.define<WriterTrackedMark[]>()
const setDraftingCapture = StateEffect.define<WriterPendingChange[]>()
// Undo/redo snapshots of the marks and the Drafting capture, rebased exactly through CodeMirror's
// own history changes (editor/history-snapshot.ts). Their values map by the SAME untracked rules the
// live fields apply to a change nothing records: mapUntracked for the capture, mapMarksUntracked for
// the marks. The mappers are silent because history also maps snapshots that will never be
// restored (the older effects of a joined event); the one restored is checked on arrival
// (soundCapture, marksWithin), and any violation there is reported.
const markSnapshots = historySnapshots<WriterTrackedMark>({
  kind: 'writer marks',
  idOf: (mark) => mark.id,
  mapValue: (marks, changes) => mapMarksUntracked(
    marks.filter((mark) => rangeWithin(mark.from, mark.to, changes.length)), changes),
  report: (message) => console.error(message),
})
const captureSnapshots = historySnapshots<WriterPendingChange>({
  kind: 'drafting capture',
  idOf: (change) => change.localId,
  mapValue: (capture, changes) => capture.flatMap((change) =>
    rangeWithin(change.anchor.from, change.anchor.to, changes.length)
      ? mapPendingChange(change, changes, 'untracked') ?? []
      : []),
  report: (message) => console.error(message),
})
const restoreWriterMarks = markSnapshots.effect
const writerReviewInternal = Annotation.define<boolean>()
const writerInitialMode = Facet.define<WriterReviewMode, WriterReviewMode>({
  combine: (values) => values.at(-1) ?? 'drafting',
})

const makeWriterId = (): string =>
  `wr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

export function writerReviewModeForContent(_content: string): WriterReviewMode {
  // ADR-0025 §2 (supersedes ADR-0016 §20): opening ANY document — blank or existing — puts you in
  // Drafting. The default is safe now because Drafting records too, so defaulting here costs no history.
  // The per-file memo in modeForFile still honours a mode the writer explicitly chose for a document.
  return 'drafting'
}

function assertRange(doc: string, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > doc.length) {
    throw new RangeError(`Invalid writer review range ${from}:${to} for document length ${doc.length}`)
  }
}

function sortedMarks(marks: readonly WriterTrackedMark[]): WriterTrackedMark[] {
  return [...marks].sort((a, b) => a.from - b.from || a.to - b.to || (a.role === 'old' ? -1 : 1))
}

type PositionMapper = Pick<ChangeSet, 'mapPos'>

function rangeWithin(from: number, to: number, length: number): boolean {
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= length
}

/**
 * A range that points outside its document can no longer identify its text. It is dropped, never
 * mapped (ChangeSet.mapPos throws on it — the 2026-10-05 crash), and the drop is written to
 * renderer-errors.log so a path that lets a range go stale is found from the log.
 */
function reportStaleRange(what: string, from: number, to: number, length: number): void {
  const message = `[WriteFlex] Dropped stale ${what} ${from}:${to} — outside a document of length ${length}.`
  console.error(message)
  if (typeof window === 'undefined') return
  try {
    void window.writeflex?.reportRendererError?.({
      message,
      stack: new Error(message).stack ?? '',
      url: window.location.href,
    })?.catch(() => undefined)
  } catch {
    // The diagnostic must never become a second failure.
  }
}

function mapMarkThroughChanges(mark: WriterTrackedMark, changes: PositionMapper): WriterTrackedMark {
  if (mark.role === 'new') {
    return {
      ...mark,
      from: changes.mapPos(mark.from, -1),
      to: changes.mapPos(mark.to, 1),
    }
  }
  return {
    ...mark,
    from: changes.mapPos(mark.from, 1),
    to: changes.mapPos(mark.to, -1),
  }
}

/**
 * A change nothing records (a command edit, a reconcile, an undo step, a snapshot rebase) never
 * extends a mark: its ends hug inward, so text inserted at a mark's edge stays unattributed. The one
 * exception keeps each record contiguous: text inserted exactly between a record's struck and new
 * text joins the new reading, as it always has, rather than opening a gap inside the record.
 */
function mapMarksUntracked(marks: readonly WriterTrackedMark[], changes: PositionMapper): WriterTrackedMark[] {
  return marks.map((mark) => {
    // The junction applies only while the record's struck text survives the change: a change that
    // removes all of it supersedes the record, and both marks collapse.
    const junction = mark.role === 'new' &&
      marks.some((other) => other.id === mark.id && other.role === 'old' && other.to === mark.from &&
        changes.mapPos(other.from, 1) < changes.mapPos(other.to, -1))
    const from = changes.mapPos(mark.from, junction ? -1 : 1)
    // A mark whose whole text the change removed or replaced is superseded: it collapses to an empty
    // range here, which normalisation drops (the capture's rule, mapUntracked).
    return { ...mark, from, to: Math.max(from, changes.mapPos(mark.to, -1)) }
  })
}

function textMarkDecoration(mark: WriterTrackedMark): Decoration {
  return Decoration.mark({
    class: mark.role === 'old' ? 'writer-change you-del del' : 'writer-change you-ins ins',
    attributes: {
      'data-writer-change-id': mark.id,
      'data-role': mark.role,
    },
    inclusiveStart: mark.role === 'new',
    inclusiveEnd: mark.role === 'new',
  })
}

function buildDecorations(marks: readonly WriterTrackedMark[]): DecorationSet {
  return Decoration.set(
    sortedMarks(marks)
      .filter((mark) => mark.to > mark.from)
      .map((mark) => textMarkDecoration(mark).range(mark.from, mark.to)),
    true,
  )
}

function mergeSameRoleMarks(previous: WriterTrackedMark, mark: WriterTrackedMark): WriterTrackedMark {
  const earliest = previous.createdAt <= mark.createdAt ? previous : mark
  return {
    ...previous,
    id: earliest.id,
    from: Math.min(previous.from, mark.from),
    to: Math.max(previous.to, mark.to),
    createdAt: earliest.createdAt,
  }
}

type WriterBlock = { from: number; to: number }
type SameWriterBlock = (left: WriterTrackedMark, right: WriterTrackedMark) => boolean

function writerBlocksIn(state: EditorState): WriterBlock[] {
  const tree = syntaxTree(state)
  const blocks: WriterBlock[] = []
  let child = tree.topNode.firstChild
  while (child) {
    blocks.push({ from: child.from, to: child.to })
    child = child.nextSibling
  }
  return blocks
}

function writerBlockForMark(blocks: readonly WriterBlock[], mark: WriterTrackedMark): WriterBlock | null {
  const intersecting = blocks.find((block) => block.to > mark.from && block.from < mark.to)
  if (intersecting) return intersecting

  // Markdown blank-line separators are outside both neighbouring block nodes. Attach them to the
  // preceding block so the paragraph's trailing newlines stay with that paragraph's writer mark.
  // Leading whitespace, which has no preceding block, belongs to the first block that follows it.
  let previous: WriterBlock | null = null
  for (const block of blocks) {
    if (block.from > mark.from) return previous ?? block
    previous = block
  }
  return previous
}

/**
 * Block independence: a record's text merges with new text only inside one Markdown block. Existing
 * records and marks never extend by mapping, so this merge rule is the whole of it — there is no
 * clipping ceiling (clipping an existing span truncated multi-paragraph records on undo, redo and
 * reveal, round 7, 2026-10-06).
 */
function writerBlockResolver(state: EditorState): {
  sameBlock: SameWriterBlock
} {
  const blocks = writerBlocksIn(state)
  const blockFor = (mark: WriterTrackedMark) => writerBlockForMark(blocks, mark)
  return {
    sameBlock: (left, right) => {
      // Headless consumers may install writerReviewing without a Markdown language. With no syntax
      // blocks every record shares one block.
      if (blocks.length === 0) return true
      const leftBlock = blockFor(left)
      const rightBlock = blockFor(right)
      return leftBlock !== null && rightBlock !== null &&
        leftBlock.from === rightBlock.from && leftBlock.to === rightBlock.to
    },
  }
}

function pendingChangeMark(change: WriterPendingChange): WriterTrackedMark {
  return {
    id: change.localId,
    role: 'new',
    from: change.anchor.from,
    to: change.anchor.to,
    createdAt: change.createdAt,
  }
}

/**
 * Carry one pending change through a document change. Never throws.
 *
 * - 'tracked': the change is the writer's own edit, which the caller records. A range whose text is
 *   deleted collapses to a point and merges with that new record.
 * - 'untracked': nothing records the change (a command-owned edit, a disk reconcile, an undo step).
 *   A pending change whose text the change removed or replaced wholesale is dropped (null): no text
 *   of its own is left for it to point at.
 *
 * A range already outside the start document is dropped with a diagnostic in either mode.
 * The caller refreshes `newText` from the new document where it has one (constrainPendingChange).
 */
export function mapPendingChange(
  change: WriterPendingChange,
  changes: ChangeDesc,
  mode: 'tracked' | 'untracked' = 'tracked',
): WriterPendingChange | null {
  const { from, to } = change.anchor
  if (!rangeWithin(from, to, changes.length)) {
    reportStaleRange(`pending writer change ${change.localId}`, from, to, changes.length)
    return null
  }
  if (mode === 'untracked') return mapUntracked(change, changes)
  // An existing record never extends by mapping: text typed at its edge becomes a new record, which
  // normalisation merges back only inside the same Markdown block. A range whose text was deleted
  // collapses to a point and merges with that new record.
  const mappedFrom = changes.mapPos(from, from === to ? -1 : 1)
  const mappedTo = from === to ? mappedFrom : changes.mapPos(to, -1)
  if (mappedTo <= mappedFrom) {
    const at = changes.mapPos(from, -1)
    return { ...change, newText: '', anchor: { from: at, to: at } }
  }
  return { ...change, anchor: { from: mappedFrom, to: mappedTo } }
}

/**
 * Untracked mapping keeps a record on ITS OWN text only:
 * - a range hugs inward (from assoc 1, to assoc -1), so text inserted at either edge — `**` from ⌘B,
 *   a reconcile's insertion — joins no record, and two records that touch can never come to overlap;
 * - a range whose every character a change removed or replaced (equal boundaries included) is
 *   superseded and dropped: the replacement is not the writer's reading;
 * - a zero-width record (a writer deletion) stays a point, placed before text inserted at it, and is
 *   dropped only when a removal spans strictly across it.
 */
function mapUntracked(change: WriterPendingChange, changes: ChangeDesc): WriterPendingChange | null {
  const { from, to } = change.anchor
  let removed = false
  changes.iterChangedRanges((fromA, toA) => {
    if (from === to ? fromA < from && toA > from : fromA <= from && toA >= to) removed = true
  })
  if (removed) return null
  if (from === to) {
    const at = changes.mapPos(from, -1)
    return { ...change, newText: '', anchor: { from: at, to: at } }
  }
  const mappedFrom = changes.mapPos(from, 1)
  const mappedTo = changes.mapPos(to, -1)
  if (mappedTo <= mappedFrom) return null
  return { ...change, anchor: { from: mappedFrom, to: mappedTo } }
}

function changesTouch(changes: ChangeDesc, from: number, to: number): boolean {
  let touched = false
  changes.iterChangedRanges((fromA, toA) => { if (fromA <= to && toA >= from) touched = true })
  return touched
}

/**
 * The capture's invariants, checked on every value the field produces: each record lies inside the
 * document, no two records overlap (a zero-width record may sit on another's edge), and each record's
 * newText is the document text over its range. A violation is repaired — the record dropped, or its
 * newText re-read — and reported, never thrown. Returns the input itself when it is already sound.
 */
function soundCapture(changes: WriterPendingChange[], state: EditorState): WriterPendingChange[] {
  const doc = state.doc
  const sorted = [...changes].sort((a, b) =>
    a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to || a.createdAt - b.createdAt,
  )
  const sound: WriterPendingChange[] = []
  let repaired = false
  let cleanPos = 0
  for (const change of sorted) {
    const { from, to } = change.anchor
    if (!rangeWithin(from, to, doc.length)) {
      reportStaleRange(`pending writer change ${change.localId}`, from, to, doc.length)
      repaired = true
      continue
    }
    if (from < cleanPos) {
      console.error(`[WriteFlex] Dropped pending writer change ${change.localId} at ${from}:${to}: it overlaps the change before it, which ends at ${cleanPos}.`)
      repaired = true
      continue
    }
    const live = doc.sliceString(from, to)
    if (live !== change.newText) {
      console.error(`[WriteFlex] Re-read the text of pending writer change ${change.localId} at ${from}:${to}.`)
      sound.push({ ...change, newText: live })
      repaired = true
    } else {
      sound.push(change)
    }
    cleanPos = to
  }
  // Canonical order (position, then createdAt) — the order materialisation reinserts old text in.
  return repaired || sound.some((change, index) => change !== changes[index]) ? sound : changes
}

function marksWithin(marks: readonly WriterTrackedMark[], state: EditorState): WriterTrackedMark[] {
  return marks.filter((mark) => {
    const sound = rangeWithin(mark.from, mark.to, state.doc.length)
    if (!sound) reportStaleRange(`writer mark ${mark.id}`, mark.from, mark.to, state.doc.length)
    return sound
  })
}

/** A record's newText re-read from the document over its range. */
function withLiveText(change: WriterPendingChange, state: EditorState): WriterPendingChange {
  return { ...change, newText: state.doc.sliceString(change.anchor.from, change.anchor.to) }
}

function pendingChangesTouch(left: WriterPendingChange, right: WriterPendingChange): boolean {
  return left.anchor.from <= right.anchor.to && right.anchor.from <= left.anchor.to
}

function mergePendingChanges(
  left: WriterPendingChange,
  right: WriterPendingChange,
  state: EditorState,
): WriterPendingChange {
  const earliest = left.createdAt <= right.createdAt ? left : right
  const from = Math.min(left.anchor.from, right.anchor.from)
  const to = Math.max(left.anchor.to, right.anchor.to)
  const oldText = right.anchor.from < left.anchor.from
    ? right.oldText + left.oldText
    : left.oldText + right.oldText
  return {
    localId: earliest.localId,
    oldText,
    newText: to > from ? state.doc.sliceString(from, to) : '',
    anchor: { from, to },
    createdAt: earliest.createdAt,
  }
}

function normaliseDraftingChanges(
  changes: WriterPendingChange[],
  sameBlock: SameWriterBlock,
  state: EditorState,
  settled: ReadonlySet<WriterPendingChange> = new Set(),
): WriterPendingChange[] {
  const merged: WriterPendingChange[] = []
  const sorted = [...changes].sort((a, b) =>
    a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to || a.createdAt - b.createdAt,
  )
  // Records never overlap. One edit that partly covers two records in different Markdown blocks
  // leaves both claiming the inserted text, and the block rule forbids merging them; the earlier
  // record keeps the shared text and the later one starts where it ends. A later record left with
  // no text survives as a point only when it still holds removed text.
  let cleanPos = 0
  for (const candidate of sorted) {
    let change = candidate
    const previous = merged.at(-1)
    if (
      previous &&
      // Only this edit's records merge: a record it did not touch keeps its identity, even when an
      // earlier untracked change left it touching another.
      !(settled.has(previous) || settled.has(change)) &&
      pendingChangesTouch(previous, change) &&
      sameBlock(pendingChangeMark(previous), pendingChangeMark(change))
    ) {
      merged[merged.length - 1] = mergePendingChanges(previous, change, state)
      cleanPos = Math.max(cleanPos, merged[merged.length - 1]!.anchor.to)
      continue
    }
    if (change.anchor.from < cleanPos) {
      const to = Math.max(cleanPos, change.anchor.to)
      if (to === cleanPos && !change.oldText) continue
      change = { ...change, anchor: { from: cleanPos, to }, newText: state.doc.sliceString(cleanPos, to) }
    }
    merged.push(change)
    cleanPos = Math.max(cleanPos, change.anchor.to)
  }
  // A record with neither old nor new text (the writer typed something, then deleted it) records no
  // change: it goes, rather than surviving as a ledger entry no reveal can show.
  return oneRecordPerId(merged.filter((change) => change.oldText !== '' || change.newText !== ''), settled)
}

/**
 * I6 in Drafting: one record per id. Id adoption across a block boundary can leave an id on two
 * records; the record the change did not touch (else the first) keeps it, and every other one gets a
 * fresh id with the same createdAt.
 */
function oneRecordPerId(changes: WriterPendingChange[], settled: ReadonlySet<WriterPendingChange>): WriterPendingChange[] {
  const byId = new Map<string, WriterPendingChange[]>()
  for (const change of changes) byId.set(change.localId, [...(byId.get(change.localId) ?? []), change])
  if ([...byId.values()].every((group) => group.length === 1)) return changes
  const keeper = new Set<WriterPendingChange>()
  for (const group of byId.values()) keeper.add(group.find((change) => settled.has(change)) ?? group[0]!)
  return changes.map((change) => keeper.has(change) ? change : { ...change, localId: makeWriterId() })
}

/** A mark whose record and role already existed when the transaction began. */
type Established = (mark: WriterTrackedMark) => boolean

function normaliseWriterMarks(
  marks: WriterTrackedMark[],
  sameBlock: SameWriterBlock,
  isEstablished: Established,
): WriterTrackedMark[] {
  const merged: WriterTrackedMark[] = []
  // A merge that absorbed an established mark is established itself: otherwise an added mark could
  // carry one established neighbour into the next (a chain merge across untouched records).
  const absorbed = new Set<WriterTrackedMark>()
  const established: Established = (mark) => absorbed.has(mark) || isEstablished(mark)
  for (const rawMark of sortedMarks(marks.filter((candidate) => candidate.to > candidate.from))) {
    let mark: WriterTrackedMark = rawMark
    if (mark.role === 'new' && merged.some((old) => old.role === 'old' && mark.from < old.to && mark.to > old.from)) {
      continue
    }
    const previous = merged.at(-1)
    // Two marks that both existed before the transaction never merge: only a mark it added may join
    // an adjacent established one (identity stability for typing at a record's edge).
    const mayMerge = previous !== undefined && previous.role === mark.role && sameBlock(previous, mark) &&
      (previous.id === mark.id || !(established(previous) && established(mark)))
    if (previous && previous.role === mark.role && previous.to > mark.from && !mayMerge) {
      // Overlap without a merge: the earlier mark keeps the shared text.
      mark = { ...mark, from: previous.to }
      if (mark.to <= mark.from) continue
    }
    if (previous && mayMerge && previous.to >= mark.from) {
      const result = mergeSameRoleMarks(previous, mark)
      if (established(previous) || established(mark)) absorbed.add(result)
      merged[merged.length - 1] = result
      continue
    }
    merged.push(mark)
  }
  return oneSpanPerRecord(merged, established)
}

/**
 * I6 in Reviewing: per id at most one old and one new mark, and where both exist the old ends where
 * the new begins. A record left with a second span keeps its id on the new mark (one the change did
 * not touch, else the first) and the old mark that ends where it begins; every other span gets a
 * fresh id with the same createdAt, an old span directly followed by a new one sharing it.
 */
function oneSpanPerRecord(marks: WriterTrackedMark[], established: Established): WriterTrackedMark[] {
  const byId = new Map<string, WriterTrackedMark[]>()
  for (const mark of marks) byId.set(mark.id, [...(byId.get(mark.id) ?? []), mark])
  const out: WriterTrackedMark[] = []
  let split = false
  for (const group of byId.values()) {
    const olds = group.filter((mark) => mark.role === 'old')
    const news = group.filter((mark) => mark.role === 'new')
    if (olds.length <= 1 && news.length <= 1 && (!olds[0] || !news[0] || olds[0].to === news[0].from)) {
      out.push(...group)
      continue
    }
    split = true
    const primaryNew = news.find(established) ?? news[0]
    const primaryOld = primaryNew
      ? olds.find((mark) => mark.to === primaryNew.from)
      : olds.find(established) ?? olds[0]
    const rest = sortedMarks(group.filter((mark) => mark !== primaryNew && mark !== primaryOld))
    out.push(...[primaryOld, primaryNew].filter((mark): mark is WriterTrackedMark => mark !== undefined))
    for (let index = 0; index < rest.length; index += 1) {
      const mark = rest[index]!
      const next = rest[index + 1]
      const id = makeWriterId()
      out.push({ ...mark, id })
      if (mark.role === 'old' && next?.role === 'new' && next.from === mark.to) {
        out.push({ ...next, id })
        index += 1
      }
    }
  }
  return split ? sortedMarks(out) : marks
}

export function pendingFromMarks(doc: string, marks: readonly WriterTrackedMark[]): WriterPendingChange[] {
  const byId = new Map<string, WriterTrackedMark[]>()
  for (const mark of marks) {
    if (!Number.isInteger(mark.from) || !Number.isInteger(mark.to) || mark.from < 0 || mark.to < mark.from || mark.to > doc.length) {
      console.warn(`[WriteFlex] Skipping invalid writer review mark ${mark.from}:${mark.to} for document length ${doc.length}.`)
      continue
    }
    const group = byId.get(mark.id) ?? []
    group.push(mark)
    byId.set(mark.id, group)
  }

  const changes: WriterPendingChange[] = []
  for (const [id, group] of byId) {
    const oldMark = group.find((mark) => mark.role === 'old')
    const newMark = group.find((mark) => mark.role === 'new')
    if (!oldMark && !newMark) continue
    const from = Math.min(oldMark?.from ?? newMark!.from, newMark?.from ?? oldMark!.from)
    const to = Math.max(oldMark?.to ?? newMark!.to, newMark?.to ?? oldMark!.to)
    changes.push({
      localId: id,
      oldText: oldMark ? doc.slice(oldMark.from, oldMark.to) : '',
      newText: newMark ? doc.slice(newMark.from, newMark.to) : '',
      anchor: { from, to },
      createdAt: Math.min(...group.map((mark) => mark.createdAt)),
    })
  }
  return changes.sort((a, b) => a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to)
}

export type MaterialisedWriterRecords = {
  changes: ChangeSpec[]
  marks: WriterTrackedMark[]
}

/** Reinsert a record set's old text over its after-state buffer and describe the Reviewing marks. */
export function materialiseRecords(
  records: readonly WriterPendingChange[],
  buffer: string,
): MaterialisedWriterRecords {
  const changes: ChangeSpec[] = []
  const marks: WriterTrackedMark[] = []
  let cleanPos = 0
  let insertedBefore = 0

  for (const record of [...records].sort((a, b) =>
    a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to || a.createdAt - b.createdAt,
  )) {
    const { from, to } = record.anchor
    const validRange = Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= buffer.length
    const resolves = validRange && from >= cleanPos && buffer.slice(from, to) === record.newText
    if (!resolves) {
      console.warn(`[WriteFlex] Skipping unresolved writer review record ${record.localId} at ${from}:${to}.`)
      continue
    }

    if (record.oldText) changes.push({ from, insert: record.oldText })
    const oldFrom = from + insertedBefore
    const oldTo = oldFrom + record.oldText.length
    const newFrom = oldTo
    const newTo = newFrom + record.newText.length

    if (oldTo > oldFrom) {
      marks.push({ id: record.localId, role: 'old', from: oldFrom, to: oldTo, createdAt: record.createdAt })
    }
    if (newTo > newFrom) {
      marks.push({ id: record.localId, role: 'new', from: newFrom, to: newTo, createdAt: record.createdAt })
    }
    cleanPos = to
    insertedBefore += record.oldText.length
  }

  return { changes, marks }
}

/** A mode switch with nothing to carry (no text change, no marks, no captured edits) stays out of the undo history:
 *  ⌘Z is never spent on it. With any of those, the switch is its own undo step so the ledgers can be restored. */
const noStateHistory = (nothingToCarry: boolean): Array<ReturnType<typeof TransactionClass.addToHistory.of>> => (nothingToCarry ? [TransactionClass.addToHistory.of(false)] : [])

/** Apply an already-safe record materialisation as Reviewing state without enabling edit tracking. */
export function materialiseRecordsTransaction(
  records: readonly WriterPendingChange[],
  buffer: string,
): TransactionSpec {
  const { changes, marks } = materialiseRecords(records, buffer)
  return {
    changes,
    effects: [
      setDraftingCapture.of([]),
      setWriterMarks.of(marks),
      setWriterMode.of('reviewing'),
    ],
    // A mode switch is its own undo step: joined with an adjacent edit, one undo would revert both and
    // mix the two modes' ledgers.
    annotations: [writerReviewInternal.of(true), skipWriterReviewTracking.of(true), isolateHistory.of('full'), ...noStateHistory(records.length === 0)],
  }
}

export function deriveCleanWriterDocument(doc: string, changes: readonly WriterPendingChange[]): string {
  let clean = ''
  let pos = 0
  for (const change of [...changes].sort((a, b) => a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to)) {
    let from = Math.max(0, Math.min(doc.length, change.anchor.from))
    const to = Math.max(from, Math.min(doc.length, change.anchor.to))
    if (change.anchor.from !== from || change.anchor.to !== to) {
      console.warn(`[WriteFlex] Clipped invalid writer review change ${change.anchor.from}:${change.anchor.to} for document length ${doc.length}.`)
    }
    if (to <= pos) {
      console.warn(`[WriteFlex] Skipped overlapping writer review change ${change.localId}.`)
      continue
    }
    if (from < pos) {
      console.warn(`[WriteFlex] Coalesced overlapping writer review change ${change.localId}.`)
      from = pos
    }
    clean += doc.slice(pos, from)
    if (from === change.anchor.from) clean += change.newText
    pos = to
  }
  clean += doc.slice(pos)
  return clean
}

/** Reveal the Drafting session as Reviewing marks without diffing the document. */
export function materialiseDraftingChanges(state: EditorState): TransactionSpec {
  if (writerReviewModeOf(state) !== 'drafting') {
    return { annotations: [writerReviewInternal.of(true), skipWriterReviewTracking.of(true)] }
  }
  const doc = state.doc.toString()
  const capture = state.field(draftingCaptureField, false) ?? []
  const records = [...capture].sort((a, b) =>
    a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to || a.createdAt - b.createdAt,
  )
  let cleanPos = 0

  for (const record of records) {
    assertRange(doc, record.anchor.from, record.anchor.to)
    if (record.anchor.from < cleanPos) {
      throw new RangeError(`Overlapping drafting capture ${record.localId} at ${record.anchor.from}:${record.anchor.to}`)
    }
    const liveNewText = doc.slice(record.anchor.from, record.anchor.to)
    if (liveNewText !== record.newText) {
      throw new Error(`Drafting capture ${record.localId} no longer matches the clean buffer`)
    }
    cleanPos = record.anchor.to
  }
  return materialiseRecordsTransaction(records, doc)
}

/** Fold Reviewing marks to the clean Drafting buffer while retaining the unreviewed records. */
export function foldReviewingChanges(state: EditorState): TransactionSpec {
  if (writerReviewModeOf(state) !== 'reviewing') {
    return { annotations: [writerReviewInternal.of(true), skipWriterReviewTracking.of(true)] }
  }
  const doc = state.doc.toString()
  const marks = state.field(writerReviewField, false)?.marks ?? []
  const reviewingRecords = pendingFromMarks(doc, marks)
  const oldMarks = sortedMarks(marks.filter((mark) => mark.role === 'old'))
  const capture = reviewingRecords.map((record) => {
    const removedBefore = oldMarks.reduce(
      (total, mark) => total + (mark.to <= record.anchor.from ? mark.to - mark.from : 0),
      0,
    )
    const from = record.anchor.from - removedBefore
    return {
      ...record,
      anchor: { from, to: from + record.newText.length },
    }
  })
  // Use the same derivation path as persistence so the corruption tripwire remains active during fold.
  documentTextForPersistence(state)

  return {
    changes: oldMarks.map((mark) => ({ from: mark.from, to: mark.to, insert: '' })),
    effects: [
      clearWriterReviewChanges.of(),
      setDraftingCapture.of(capture),
      setWriterMode.of('drafting'),
    ],
    annotations: [writerReviewInternal.of(true), skipWriterReviewTracking.of(true), isolateHistory.of('full'), ...noStateHistory(marks.length === 0 && capture.length === 0)],
  }
}

export function writerReviewModeOf(state: EditorState): WriterReviewMode {
  return state.field(writerReviewField, false)?.mode ?? 'drafting'
}

/** Writer-authored revision layers are visible only in Reviewing; agent proposals use their own emergent surface. */
export function revisionDecorationsVisible(state: EditorState): boolean {
  return writerReviewModeOf(state) === 'reviewing'
}

/** The writer's tracked marks while they are visible (Reviewing); none in Drafting. Read by the
 *  checkbox layer, which draws a box whose tick is a pending writer change (editor/task-boxes.ts). */
export function visibleWriterMarks(state: EditorState): readonly WriterTrackedMark[] {
  return revisionDecorationsVisible(state) ? state.field(writerReviewField, false)?.marks ?? [] : []
}

export function pendingWriterChanges(state: EditorState): WriterPendingChange[] {
  if (writerReviewModeOf(state) === 'drafting') {
    return state.field(draftingCaptureField, false) ?? []
  }
  const field = state.field(writerReviewField, false)
  return field ? pendingFromMarks(state.doc.toString(), field.marks) : []
}

export function documentTextForPersistence(state: EditorState): string {
  const doc = state.doc.toString()
  // ADR-0025 §1: Drafting's buffer already IS the file. Applying captured ledger records to it would
  // replay the writer's edits and corrupt the document, so the derivation path is Reviewing-only.
  if (writerReviewModeOf(state) === 'drafting') {
    const draftMarks = state.field(writerReviewField, false)?.marks ?? []
    if (draftMarks.length === 0) return doc
    // Invariant violation: Drafting must carry NO marks. A fold that didn't run leaves struck old text in
    // the buffer, and returning it verbatim persists that struck text (the silent corruption found in the
    // stage-5 usability review, 2026-07-18). Strip it the way Reviewing does, and log loudly so it is never silent.
    console.error(`[WriteFlex] Drafting buffer carries ${draftMarks.length} writer marks — the fold did not run; stripping struck text before persist.`)
    return deriveCleanWriterDocument(doc, pendingFromMarks(doc, draftMarks))
  }
  const changes = pendingWriterChanges(state)
  const clean = changes.length > 0 ? deriveCleanWriterDocument(doc, changes) : doc
  // Corruption tripwire (2026-07-11 truncation incidents): a derivation that shreds most of a real
  // document means the marks are inconsistent. The save guard blocks the empty case; this logs the
  // evidence (mark ranges) the moment it happens so the root cause stops being a post-mortem.
  if (doc.length > 200 && clean.length < doc.length * 0.2) {
    console.error(
      `[WriteFlex] Writer-review derivation shrank the document ${doc.length} → ${clean.length} chars — inconsistent marks:`,
      changes.map((c) => `${c.localId}@${c.anchor.from}-${c.anchor.to} new:${JSON.stringify(c.newText.slice(0, 20))}`).join(' '),
    )
  }
  return clean
}

export type WriterChangeResolution = 'accept' | 'reject' | 'hold'

/**
 * Resolve ONE tracked writer edit (identified by its mark-group id) the same three ways an agent proposal
 * resolves: accept keeps the NEW text, reject restores the OLD text, hold leaves BOTH readings in the
 * document (dropping the tracking so it reads as settled text). Returns the transaction spec to dispatch,
 * or null when the id is not a live writer edit. Annotated so the review filter does not re-track the
 * collapse, and carrying setWriterMarks so undo restores the marks (ADR-0004/0016 parity with agent review).
 */
export function resolveWriterChangeSpec(
  state: EditorState,
  localId: string,
  action: WriterChangeResolution,
): TransactionSpec | null {
  const field = state.field(writerReviewField, false)
  if (!field) return null
  const group = field.marks.filter((mark) => mark.id === localId)
  if (group.length === 0) return null
  const oldMark = group.find((mark) => mark.role === 'old')
  const newMark = group.find((mark) => mark.role === 'new')
  const from = Math.min(oldMark?.from ?? newMark!.from, newMark?.from ?? oldMark!.from)
  const to = Math.max(oldMark?.to ?? newMark!.to, newMark?.to ?? oldMark!.to)
  const remainingMarks = field.marks.filter((mark) => mark.id !== localId)

  if (action === 'hold') {
    // Keep both readings verbatim: no buffer edit, just drop this group's tracking. Other marks do not move.
    return {
      // The field effect handler normalises against the transaction's final syntax tree.
      effects: [setWriterMarks.of(remainingMarks)],
      annotations: [writerReviewInternal.of(true), skipWriterReviewTracking.of(true)],
    }
  }

  const keepText = action === 'accept'
    ? (newMark ? state.doc.sliceString(newMark.from, newMark.to) : '')
    : (oldMark ? state.doc.sliceString(oldMark.from, oldMark.to) : '')
  const changes = { from, to, insert: keepText }
  const changeSet = ChangeSet.of([changes], state.doc.length)
  const mapped = remainingMarks.map((mark) => mapMarkThroughChanges(mark, changeSet))
  return {
    changes,
    effects: [setWriterMarks.of(mapped)],
    annotations: [writerReviewInternal.of(true), skipWriterReviewTracking.of(true)],
  }
}

export function writerReviewChanged(update: Pick<ViewUpdate, 'transactions'>): boolean {
  return update.transactions.some((tr) =>
    tr.effects.some((effect) => effect.is(addWriterMarks) || effect.is(setWriterMarks) || effect.is(restoreWriterMarks) || effect.is(clearWriterReviewChanges) || effect.is(setWriterMode)) ||
    tr.startState.field(draftingCaptureField, false) !== tr.state.field(draftingCaptureField, false),
  )
}

export const writerReviewField = StateField.define<WriterReviewState>({
  create: (state) => ({ mode: state.facet(writerInitialMode), marks: [], deco: Decoration.none }),
  update(value, tr) {
    let mode = value.mode
    const blocks = writerBlockResolver(tr.state)
    // Every normalisation below shares one rule: marks that existed when the transaction began never
    // merge with each other.
    const startKeys = new Set(value.marks.map(markKey))
    const established: Established = (mark) => startKeys.has(markKey(mark))
    let marks = value.marks
    if (tr.docChanged) {
      // Existing marks never extend by mapping (the writer's typing arrives as added marks, which
      // merge only inside one block), so no mark ever needs clipping back to its block.
      marks = normaliseWriterMarks(mapMarksUntracked(value.marks, tr.changes), blocks.sameBlock, established)
    }
    for (const effect of tr.effects) {
      if (effect.is(setWriterMode)) mode = effect.value
      else if (effect.is(clearWriterReviewChanges)) marks = []
      // A mark set (reveal, resolution, hold) describes records that already exist: none merges, and
      // each keeps its span exactly.
      else if (effect.is(setWriterMarks)) marks = normaliseWriterMarks(marksWithin(effect.value, tr.state), blocks.sameBlock, () => true)
      else if (effect.is(addWriterMarks)) marks = normaliseWriterMarks([...marks, ...effect.value], blocks.sameBlock, established)
    }
    // An undo/redo restores the records its step touched from the youngest snapshot; every other live
    // mark stays and wins any overlap. A snapshot that does not fit keeps all live marks.
    const snapshot = markSnapshots.pick(tr)
    const split = snapshot && markSnapshots.restore(snapshot, tr, marks)
    if (split) {
      const keep = split.keep
      // Restored spans come back exactly as the snapshot holds them.
      const restored = marksWithin(split.restored.filter((mark) => mark.to > mark.from), tr.state)
        .filter((mark) => !keep.some((kept) => rangesOverlap(kept, mark)))
      // Restored marks are records as they were, so they count as established too: restore merges
      // nothing (a restored mark merging into a kept neighbour changed an untouched record).
      marks = normaliseWriterMarks([...keep, ...restored], blocks.sameBlock, () => true)
    }
    return { mode, marks, deco: mode === 'reviewing' ? buildDecorations(marks) : Decoration.none }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

const markKey = (mark: WriterTrackedMark): string => `${mark.id}:${mark.role}`

/** Two ranges claim the same text: they intersect, or a point lies strictly inside the other. */
function rangesOverlap(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  if (a.from < b.to && b.from < a.to) return true
  if (a.from === a.to) return b.from < a.from && a.from < b.to
  if (b.from === b.to) return a.from < b.from && b.from < a.to
  return false
}

/**
 * The ids a transaction changed, for its undo snapshot: a record counts as touched when it appears
 * or disappears, or its text or range differs from its start range carried by plain mapPos. A record
 * that merely shifted is untouched. A mark's text is the document text it covers. A record whose
 * text the step replaced counts as touched even when the replacement is identical: the live mapping
 * drops such a record, so its undo or redo must bring it back.
 */
function touchedIdsOf<I>(
  before: readonly I[],
  after: readonly I[],
  tr: Transaction,
  idOf: (item: I) => string,
  shape: (item: I, map: (pos: number) => number, doc: EditorState['doc']) => string,
  rangeOf: (item: I) => { from: number; to: number },
): Set<string> {
  const group = (items: readonly I[], map: (pos: number) => number, doc: EditorState['doc']) => {
    const byId = new Map<string, string[]>()
    for (const item of items) byId.set(idOf(item), [...(byId.get(idOf(item)) ?? []), shape(item, map, doc)])
    for (const [id, shapes] of byId) byId.set(id, shapes.sort())
    return byId
  }
  const start = group(before, (pos) => tr.changes.mapPos(pos), tr.startState.doc)
  const end = group(after, (pos) => pos, tr.state.doc)
  const touched = new Set<string>()
  for (const item of before) {
    const { from, to } = rangeOf(item)
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (fromA < toA && rangesOverlap({ from: fromA, to: toA }, { from, to })) touched.add(idOf(item))
    })
  }
  for (const id of new Set([...start.keys(), ...end.keys()])) {
    if (JSON.stringify(start.get(id)) !== JSON.stringify(end.get(id))) touched.add(id)
  }
  return touched
}

const draftingCaptureField = StateField.define<WriterPendingChange[]>({
  create: () => [],
  update(value, tr) {
    markSnapshots.note(tr)
    captureSnapshots.note(tr)
    const next = nextDraftingCapture(value, tr)
    return next === value ? value : soundCapture(next, tr.state)
  },
})

/** The capture carried through a change that records nothing new (the untracked rule). */
function mapCaptureUntracked(value: WriterPendingChange[], tr: Transaction): WriterPendingChange[] {
  if (value.length === 0 || !tr.docChanged) return value
  return value.flatMap((change) => {
    const mapped = mapPendingChange(change, tr.changes, 'untracked')
    if (!mapped) return []
    return [changesTouch(tr.changes, change.anchor.from, change.anchor.to) ? withLiveText(mapped, tr.state) : mapped]
  })
}

function nextDraftingCapture(value: WriterPendingChange[], tr: Transaction): WriterPendingChange[] {
  let effected = false
  let next = value
  for (const effect of tr.effects) {
    if (effect.is(clearWriterReviewChanges)) {
      effected = true
      next = []
    }
    if (effect.is(setDraftingCapture)) {
      effected = true
      next = effect.value
    }
  }
  // An undo/redo restores the youngest capture snapshot. One that fits is taken in the undo's
  // coordinates with each newText re-read (soundCapture then checks every invariant); one that does
  // not fit keeps the live-mapped capture.
  const snapshot = captureSnapshots.pick(tr)
  if (snapshot) {
    const live = mapCaptureUntracked(value, tr)
    const split = captureSnapshots.restore(snapshot, tr, live)
    if (!split) return live
    // The records the step touched come back from the snapshot exactly — the same spans — with each
    // newText re-read. Untouched live records stay and win any overlap;
    // nothing merges.
    const blocks = writerBlockResolver(tr.state)
    const restored = split.restored
      .filter((change) => rangeWithin(change.anchor.from, change.anchor.to, tr.newDoc.length))
      .map((change) => withLiveText(change, tr.state))
      .filter((change) => !split.keep.some((kept) => rangesOverlap(kept.anchor, change.anchor)))
    const combined = [...split.keep, ...restored]
    return normaliseDraftingChanges(combined, blocks.sameBlock, tr.state, new Set(combined))
  }
  if (effected) return next
  if (!tr.docChanged) return value

  // INVARIANT (2026-10-05 crash): every document change maps the capture. The transactions below
  // record no new change, but they still move text, so the existing records move with it. Returning
  // them untouched left a record pointing past the end of a document a cut or a reconcile had
  // shortened, and the writer's next keystroke threw in mapPos.
  if (
    writerReviewModeOf(tr.startState) !== 'drafting' ||
    tr.annotation(writerReviewInternal) ||
    tr.annotation(skipWriterReviewTracking) ||
    tracksHistory(tr)
  ) {
    return mapCaptureUntracked(value, tr)
  }

  const blocks = writerBlockResolver(tr.state)

  const startChanges = value
  const settled = new Set<WriterPendingChange>()
  const captured = value.flatMap((change) => {
    const mapped = mapPendingChange(change, tr.changes)
    if (!mapped) return []
    if (!changesTouch(tr.changes, change.anchor.from, change.anchor.to)) {
      settled.add(mapped)
      return [mapped]
    }
    return [withLiveText(mapped, tr.state)]
  })
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const touched = startChanges.find((change) => (
      fromA === toA
        ? fromA > change.anchor.from && fromA < change.anchor.to
        : fromA < change.anchor.to && toA > change.anchor.from
    ))
    const adjacent = touched ?? startChanges.find((change) =>
      fromA === change.anchor.to || toA === change.anchor.from,
    )
    const createdAt = touched?.createdAt ?? (
      adjacent ? Math.max(Date.now(), adjacent.createdAt + 1) : Date.now()
    )
    captured.push({
      localId: touched?.localId ?? makeWriterId(),
      // Text removed from a prior Drafting insertion belongs to that insertion's evolving NEW
      // reading, not to the record's original OLD reading.
      oldText: touched ? '' : tr.startState.doc.sliceString(fromA, toA),
      newText: inserted.toString(),
      anchor: { from: fromB, to: toB },
      createdAt,
    })
  })
  return normaliseDraftingChanges(captured, blocks.sameBlock, tr.state, settled)
}

function intersects(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from < a.to && a.from < b.to && a.to > b.from
}

function overlappingNewIntervals(marks: readonly WriterTrackedMark[], from: number, to: number): Array<{ from: number; to: number }> {
  return sortedMarks(marks)
    .filter((mark) => mark.role === 'new' && intersects({ from, to }, mark))
    .map((mark) => ({ from: Math.max(from, mark.from), to: Math.min(to, mark.to) }))
    .filter((range) => range.to > range.from)
}

function originalSegments(from: number, to: number, erasedNew: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const segments: Array<{ from: number; to: number }> = []
  let pos = from
  for (const range of erasedNew) {
    if (range.from > pos) segments.push({ from: pos, to: range.from })
    pos = Math.max(pos, range.to)
  }
  if (pos < to) segments.push({ from: pos, to })
  return segments
}

/** A document change nothing records: command-owned, a disk reconcile, or an undo/redo step. */
function isUntracked(tr: Transaction): boolean {
  return Boolean(tr.annotation(skipWriterReviewTracking)) || tracksHistory(tr) || tr.annotation(TransactionClass.addToHistory) === false
}

function tracksHistory(tr: Transaction): boolean {
  return tr.isUserEvent('undo') || tr.isUserEvent('redo')
}

type ReplacementInsertSpan = {
  fromB: number
  toB: number
  syntheticFrom: number
}

function mapReviewSelection(tr: Transaction, syntheticChanges: ChangeSet, inserts: readonly ReplacementInsertSpan[]): EditorSelection | undefined {
  if (!tr.selection) return undefined
  const mapPos = (pos: number, assoc: number): number => {
    for (const insert of inserts) {
      const atStart = pos === insert.fromB && assoc < 0
      const atEnd = pos === insert.toB && assoc > 0
      if ((pos > insert.fromB && pos < insert.toB) || atStart || atEnd) {
        return insert.syntheticFrom + (pos - insert.fromB)
      }
    }
    return syntheticChanges.mapPos(tr.changes.invertedDesc.mapPos(pos, assoc), assoc)
  }
  const ranges = tr.selection.ranges.map((range) => {
    const bidiLevel = range.bidiLevel ?? undefined
    if (range.empty) return EditorSelection.cursor(mapPos(range.head, range.assoc), range.assoc, bidiLevel, range.goalColumn)
    return EditorSelection.range(mapPos(range.anchor, range.assoc), mapPos(range.head, range.assoc), range.goalColumn, bidiLevel, range.assoc)
  })
  return EditorSelection.create(ranges, tr.selection.mainIndex)
}

function isolation(tr: Transaction): Array<ReturnType<typeof isolateHistory.of>> {
  const isolate = tr.annotation(isolateHistory)
  return isolate ? [isolateHistory.of(isolate)] : []
}

function writerReviewFilter(tr: Transaction): Transaction | readonly TransactionSpec[] {
  if (!tr.docChanged || tr.annotation(writerReviewInternal) || tr.annotation(skipWriterReviewTracking) || tracksHistory(tr)) return tr
  const mode = writerReviewModeOf(tr.startState)
  if (mode !== 'reviewing') return tr

  const startMarks = tr.startState.field(writerReviewField, false)?.marks ?? []
  const changes: ChangeSpec[] = []
  const added: WriterTrackedMark[] = []
  const insertedSpans: Array<{ fromB: number; toB: number; toA: number }> = []
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const insertedText = inserted.toString()
    const erasedNew = overlappingNewIntervals(startMarks, fromA, toA)
    // IDENTITY STABILITY (2026-07-11 fragmentation bug): an edit inside the writer's OWN tracked
    // insertion erases the overlap and re-adds a mark, so it must adopt that mark's id. An edit flush
    // with an edge starts provisionally fresh: normalisation restores the established id inside the
    // same Markdown block, while a block boundary keeps the new identity separate.
    const touched = startMarks.find((mark) => mark.role === 'new' && (
      fromA === toA
        ? fromA > mark.from && fromA < mark.to
        : fromA < mark.to && toA > mark.from
    ))
    const adjacent = touched ?? startMarks.find((mark) => mark.role === 'new' && (fromA === mark.to || toA === mark.from))
    const id = touched?.id ?? makeWriterId()
    // Edge continuations start with a fresh id so a new block stays independent. Within the same
    // block normalisation merges it back into the older identity. Make its timestamp
    // strictly later so prepending at the left edge also retains the established id after that merge.
    const createdAt = touched?.createdAt ?? (adjacent ? Math.max(Date.now(), adjacent.createdAt + 1) : Date.now())
    for (const range of erasedNew) changes.push({ from: range.from, to: range.to, insert: '' })

    if (insertedText.length > 0) {
      changes.push({ from: toA, insert: insertedText })
      insertedSpans.push({ fromB, toB, toA })
    }
    // Text already struck stays struck under its own record: striking it again overlapped two
    // records' old marks, and persistence then lost text.
    const alreadyStruck = sortedMarks(startMarks)
      .filter((mark) => mark.role === 'old' && intersects({ from: fromA, to: toA }, mark))
      .map((mark) => ({ from: Math.max(fromA, mark.from), to: Math.min(toA, mark.to) }))
    const kept = [...erasedNew, ...alreadyStruck].sort((a, b) => a.from - b.from || a.to - b.to)
    const segments = originalSegments(fromA, toA, kept)
    if (segments.length > 0) {
      // I6: the struck text joins the touched record only when it becomes that record's old reading
      // — the record has none yet, and the strike ends exactly where the record's new text begins
      // once the erasures and the reinsertion are applied. Anything else is its own record.
      const struckTo = segments[segments.length - 1]!.to
      const joinsTouched = touched !== undefined &&
        !startMarks.some((mark) => mark.id === touched.id && mark.role === 'old') &&
        struckTo <= touched.from &&
        !startMarks.some((mark) => mark.role === 'new' && mark.from >= struckTo && mark.from < touched.from) &&
        originalSegments(struckTo, touched.from, erasedNew).length === 0
      const struckId = touched === undefined || joinsTouched ? id : makeWriterId()
      // One mark per struck segment; normalisation (I6) keeps the id on the one that meets the new
      // text and gives the others their own.
      for (const segment of segments) added.push({ id: struckId, role: 'old', from: segment.from, to: segment.to, createdAt })
    }
    if (insertedText.length > 0) {
      added.push({ id, role: 'new', from: toA, to: toA, createdAt })
    }
  })

  if (changes.length === 0 && added.length === 0) {
    // The deletion fell only on text already struck: it changes nothing. Never pass the original
    // deletion through (that erased the struck text and its record's old reading); keep the buffer
    // and the strike, keep the transaction's effects, and move each cursor across its strike:
    // forward to the strike's end, backward to its start.
    const forward = tr.isUserEvent('delete.forward')
    const struck = startMarks.filter((mark) => mark.role === 'old')
    const ranges = tr.startState.selection.ranges.map((range) => {
      let target = range.head
      tr.changes.iterChangedRanges((fromA, toA) => {
        const ownsRange = (fromA <= range.head && range.head <= toA) || (range.from <= fromA && toA <= range.to)
        if (!ownsRange) return
        const hits = struck.filter((mark) => mark.from < toA && mark.to > fromA)
        if (hits.length > 0) target = forward ? Math.max(...hits.map((mark) => mark.to)) : Math.min(...hits.map((mark) => mark.from))
      })
      return EditorSelection.cursor(target)
    })
    return [{
      effects: tr.effects,
      annotations: [writerReviewInternal.of(true), ...isolation(tr)],
      selection: EditorSelection.create(ranges, tr.startState.selection.mainIndex),
      scrollIntoView: tr.scrollIntoView,
    }]
  }
  const syntheticChanges = ChangeSet.of(changes, tr.startState.doc.length)
  const selection = mapReviewSelection(
    tr,
    syntheticChanges,
    insertedSpans.map((span) => ({
      fromB: span.fromB,
      toB: span.toB,
      syntheticFrom: syntheticChanges.mapPos(span.toA, -1),
    })),
  )
  const addedMarks = added.flatMap((mark) => {
      if (mark.role === 'new') {
        const from = syntheticChanges.mapPos(mark.from, -1)
        const to = syntheticChanges.mapPos(mark.to, 1)
        return to > from ? [{ ...mark, from, to }] : []
      }
      const from = syntheticChanges.mapPos(mark.from, 1)
      const to = syntheticChanges.mapPos(mark.to, -1)
      return to > from ? [{ ...mark, from, to }] : []
    })
  return [
    {
      changes,
      // Carry the ORIGINAL transaction's effects through the rewrite — dropping them silently ate
      // any effect dispatched alongside a doc change in Reviewing mode (found 2026-07-12 when the
      // insert-object flow's open-block effect vanished; scrollIntoView was being lost the same way).
      // Existing marks map through `changes` in the field update (never extending). Add only the
      // transaction's new marks here; normalisation merges them only inside one block.
      effects: [...tr.effects, addWriterMarks.of(addedMarks)],
      // A deliberately isolated edit (a checkbox tick: editor/task-boxes.ts) stays its own undo step
      // through the rewrite; every other annotation keeps today's behaviour.
      annotations: [writerReviewInternal.of(true), ...isolation(tr)],
      selection,
      scrollIntoView: tr.scrollIntoView,
    },
  ]
}

export function writerReviewing(opts: { initialMode?: WriterReviewMode } = {}): Extension {
  return [
    writerInitialMode.of(opts.initialMode ?? 'drafting'),
    writerReviewField,
    draftingCaptureField,
    EditorState.transactionFilter.of(writerReviewFilter),
    invertedEffects.of((tr) => {
      const field = tr.startState.field(writerReviewField, false)
      const draftingCapture = tr.startState.field(draftingCaptureField, false)
      const effects = []
      // A snapshot for EVERY document change, not only ones that touch the ledger: CodeMirror may join
      // this event to the previous one, and the joined event is restored exactly only when each step
      // of the group has a snapshot (editor/history-snapshot.ts, case b).
      const marksTouched = tr.effects.some((effect) =>
        effect.is(addWriterMarks) || effect.is(setWriterMarks) || effect.is(restoreWriterMarks) || effect.is(clearWriterReviewChanges),
      )
      if (field && (tr.docChanged || marksTouched)) {
        const after = tr.state.field(writerReviewField, false)?.marks ?? []
        effects.push(markSnapshots.snapshot(field.marks, tr, touchedIdsOf(field.marks, after, tr, (mark) => mark.id,
          (mark, map, doc) => JSON.stringify([mark.role, map(mark.from), map(mark.to), mark.createdAt, doc.sliceString(mark.from, mark.to)]),
          (mark) => mark)))
      }
      const modeEffect = tr.effects.find((effect) => effect.is(setWriterMode))
      if (modeEffect && field) effects.push(setWriterMode.of(field.mode))
      if (draftingCapture && (tr.docChanged || draftingCapture !== tr.state.field(draftingCaptureField, false))) {
        const after = tr.state.field(draftingCaptureField, false) ?? []
        effects.push(captureSnapshots.snapshot(draftingCapture, tr, touchedIdsOf(draftingCapture, after, tr, (change) => change.localId,
          (change, map) => JSON.stringify([change.oldText, change.newText, map(change.anchor.from), map(change.anchor.to), change.createdAt]),
          (change) => change.anchor)))
      }
      return effects
    }),
  ]
}
