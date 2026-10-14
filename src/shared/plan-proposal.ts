/**
 * The running-order proposal model (ticket 09; design
 * docs/design/2026-08-10-agent-and-multi-part-works/2026-09-27-proposal-card-states.html).
 *
 * Pure: the report's plan as it stood when the agent proposed (the Basis), plus the agent's changes
 * and the writer's edits, give the proposed order with every change marked, the files left outside
 * it, the count of changes Accept will apply, and the sequence of existing Plan operations that
 * writes it. The staleness and undo checks compare file fingerprints. Nothing here touches disk;
 * main executes the operation sequence through `src/main/plan.ts`.
 */

import { PLAN_ROLES } from './plan-line'
import { preferOriginal } from './conflict-copy'

export type PlanProposalChange =
  | { op: 'insert'; title: string; at?: number; gloss?: string; role?: string }
  | { op: 'move'; title: string; to: number }
  | { op: 'remove'; title: string }
  | { op: 'adopt'; path: string; at?: number; role?: string }
  | { op: 'materialise'; title: string }
  | { op: 'setRole'; title: string; role: string }

export type PlanProposalInput = { dir: string; changes: PlanProposalChange[]; summary?: string }

export type BasisPart = { title: string; gloss: string | null; role: string; path: string | null; words: number | null }
export type BasisStray = { path: string; title: string; words: number; role?: string }
/** The report's plan when the proposal was made: what every mark is measured against. */
export type ProposalBasis = {
  dir: string
  hasIndexNote: boolean
  /** The canonical Index Note path, whether or not it exists yet. */
  indexPath: string
  parts: BasisPart[]
  strays: BasisStray[]
}

export type ChangeOrigin = 'agent' | 'writer'
/** One change as the card holds it: the writer may drop (×) and restore (↺) it in Edit first. */
export type ProposalEntry = { id: string; change: PlanProposalChange; origin: ChangeOrigin; enabled: boolean }

export type RowMark = 'add' | 'move' | 'out' | null
export type ProposalRow = {
  /** Stable identity across edits: `part:<title>`, `stray:<path>` or `new:<title>`. */
  key: string
  title: string
  gloss: string | null
  role: string
  /** True when this proposal sets the role (the card shows it only then). */
  roleSet: boolean
  words: number | null
  /** The file this row resolves to, or null for an unwritten part. */
  path: string | null
  mark: RowMark
  /** This proposal writes the unwritten part out into a file. */
  materialise: boolean
  /** Enabled changes that touch this row. */
  changeIds: string[]
}
export type ResolvedEntry = { id: string; ok: boolean; error?: string; rowKey?: string; counted: boolean }
export type ProposedPlan = {
  /** The folder has no Index Note: the proposal's first line is "Create the Index Note". */
  createsIndexNote: boolean
  /** The proposed running order. */
  rows: ProposalRow[]
  /** Parts taken out of the order (−). Their files stay in the folder. */
  removed: ProposalRow[]
  /** Files left outside the order: listed, never counted. */
  outside: BasisStray[]
  entries: ResolvedEntry[]
  /** How many changes Accept will apply. */
  count: number
  errors: string[]
}

const ROLES = new Set<string>(PLAN_ROLES)
const same = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
const clamp = (value: number | undefined, length: number) => (
  value === undefined || !Number.isFinite(value) ? length : Math.max(0, Math.min(length, Math.trunc(value)))
)

function describe(change: PlanProposalChange): string {
  switch (change.op) {
    case 'insert': return `insert "${change.title}"`
    case 'move': return `move "${change.title}"`
    case 'remove': return `remove "${change.title}"`
    case 'adopt': return `adopt ${change.path}`
    case 'materialise': return `write out "${change.title}"`
    case 'setRole': return `set the role of "${change.title}"`
  }
}

/** The stray a title names; a sync conflict copy never wins over its original. */
function strayByTitle(basis: ProposalBasis, title: string): BasisStray | undefined {
  const matches = basis.strays.filter((item) => same(item.title, title))
  const path = preferOriginal(matches.map((item) => item.path))
  return matches.find((item) => item.path === path)
}

/** Number the agent's changes `c1…`; the card appends the writer's own moves as `w1…`. */
export function proposalEntries(changes: PlanProposalChange[]): ProposalEntry[] {
  return changes.map((change, index) => ({ id: `c${index + 1}`, change, origin: 'agent', enabled: true }))
}

/**
 * Apply the enabled entries, in order, to the Basis order. Each change names a part by its
 * running-order title (case-insensitive) and positions are 0-based places in the order as it stands
 * at that point in the list. An invalid change is skipped and reported; it is never half-applied.
 */
export function resolveProposal(basis: ProposalBasis, entries: ProposalEntry[]): ProposedPlan {
  const rows: ProposalRow[] = basis.parts.map((part) => ({
    key: `part:${part.title.toLocaleLowerCase()}`,
    title: part.title,
    gloss: part.gloss,
    role: part.role,
    roleSet: false,
    words: part.words,
    path: part.path,
    mark: null,
    materialise: false,
    changeIds: [],
  }))
  const removed: ProposalRow[] = []
  const resolved: ResolvedEntry[] = []
  const errors: string[] = []
  const addedBy = new Map<string, string>()
  const movedByWriter = new Set<string>()
  const find = (title: string) => rows.findIndex((row) => same(row.title, title))
  const fail = (entry: ProposalEntry, error: string) => {
    resolved.push({ id: entry.id, ok: false, error, counted: false })
    if (entry.enabled) errors.push(`${describe(entry.change)}: ${error}`)
  }

  for (const entry of entries) {
    if (!entry.enabled) {
      resolved.push({ id: entry.id, ok: true, counted: false })
      continue
    }
    const change = entry.change
    const touch = (row: ProposalRow) => {
      row.changeIds.push(entry.id)
      resolved.push({ id: entry.id, ok: true, rowKey: row.key, counted: true })
    }
    if (change.op === 'insert' || change.op === 'adopt') {
      const stray = change.op === 'adopt'
        ? basis.strays.find((item) => item.path === change.path)
        : strayByTitle(basis, change.title)
      const title = stray?.title ?? (change.op === 'insert' ? change.title.trim() : '')
      if (change.op === 'adopt' && !stray) {
        fail(entry, basis.parts.some((part) => part.path === change.path)
          ? 'that file is already in the running order'
          : 'that file is not a stray in this folder')
        continue
      }
      if (!title) { fail(entry, 'a part needs a title'); continue }
      if (/[|#\r\n]|\]\]/.test(title)) { fail(entry, 'that title cannot be written as a running-order link'); continue }
      if (find(title) >= 0 || removed.some((row) => same(row.title, title))) {
        fail(entry, 'a part with that title is already in the running order')
        continue
      }
      const role = (change.role ?? stray?.role ?? 'section').toLocaleLowerCase()
      if (!ROLES.has(role)) { fail(entry, `unknown role "${change.role}"; use one of ${PLAN_ROLES.join(', ')}`); continue }
      const row: ProposalRow = {
        key: stray ? `stray:${stray.path}` : `new:${title.toLocaleLowerCase()}`,
        title,
        gloss: change.op === 'insert' ? change.gloss?.trim() || null : null,
        role,
        roleSet: change.role !== undefined && role !== 'section',
        words: stray?.words ?? null,
        path: stray?.path ?? null,
        mark: 'add',
        materialise: false,
        changeIds: [],
      }
      rows.splice(clamp(change.at, rows.length), 0, row)
      addedBy.set(row.key, entry.id)
      touch(row)
      continue
    }
    const index = find(change.title)
    if (index < 0) {
      fail(entry, removed.some((row) => same(row.title, change.title))
        ? 'that part is already taken out of the order'
        : 'no part with that title is in the running order')
      continue
    }
    const row = rows[index]
    if (change.op === 'move') {
      rows.splice(index, 1)
      rows.splice(clamp(change.to, rows.length), 0, row)
      if (entry.origin === 'writer') movedByWriter.add(row.key)
      if (!addedBy.has(row.key) || entry.origin === 'writer') row.mark = 'move'
      touch(row)
    } else if (change.op === 'remove') {
      if (addedBy.has(row.key)) { fail(entry, 'that part is only added by this proposal; drop the insertion instead'); continue }
      rows.splice(index, 1)
      row.mark = 'out'
      removed.push(row)
      touch(row)
    } else if (change.op === 'materialise') {
      if (row.path) { fail(entry, 'that part is already written'); continue }
      row.materialise = true
      touch(row)
    } else {
      const role = change.role.trim().toLocaleLowerCase()
      if (!ROLES.has(role)) { fail(entry, `unknown role "${change.role}"; use one of ${PLAN_ROLES.join(', ')}`); continue }
      row.role = role
      row.roleSet = true
      touch(row)
    }
  }

  // A writer's drag of a row this proposal already adds re-places that addition: one change, not two.
  const counted = new Map(resolved.map((item) => [item.id, item]))
  for (const entry of entries) {
    const item = counted.get(entry.id)
    if (!item?.ok || !item.counted || entry.origin !== 'writer' || entry.change.op !== 'move' || !item.rowKey) continue
    const adder = addedBy.get(item.rowKey)
    if (adder && counted.get(adder)?.counted) item.counted = false
  }
  // Several writer drags of one row are one move.
  const seenWriterMove = new Set<string>()
  for (const item of resolved) {
    const entry = entries.find((candidate) => candidate.id === item.id)
    if (!item.counted || entry?.origin !== 'writer' || !item.rowKey) continue
    if (seenWriterMove.has(item.rowKey)) item.counted = false
    seenWriterMove.add(item.rowKey)
  }

  const inOrder = new Set(rows.flatMap((row) => (row.path ? [row.path] : [])))
  const outside = basis.strays.filter((stray) => !inOrder.has(stray.path))
  return {
    createsIndexNote: !basis.hasIndexNote,
    rows,
    removed,
    outside,
    entries: resolved,
    count: resolved.filter((item) => item.counted).length,
    errors,
  }
}

/** A row as the card draws it: the proposed order, with each dropped change shown where it was. */
export type DisplayRow = ProposalRow & { dropped: boolean; droppedIds: string[] }

/**
 * The card's rows in Edit first. The order is what Accept would write; a change the writer dropped
 * (×) stays visible, struck through, at the place the full proposal put it, so ↺ can restore it.
 */
export function displayRows(basis: ProposalBasis, entries: ProposalEntry[]): { rows: DisplayRow[]; removed: DisplayRow[] } {
  const effective = resolveProposal(basis, entries)
  const full = resolveProposal(basis, entries.map((entry) => ({ ...entry, enabled: true })))
  const droppedFor = (key: string) => entries
    .filter((entry) => !entry.enabled && full.entries.find((item) => item.id === entry.id)?.rowKey === key)
    .map((entry) => entry.id)
  const rows: DisplayRow[] = effective.rows.map((row) => ({ ...row, dropped: false, droppedIds: droppedFor(row.key) }))
  const keys = new Set([...effective.rows, ...effective.removed].map((row) => row.key))
  full.rows.forEach((row, index) => {
    if (keys.has(row.key)) return
    rows.splice(Math.min(index, rows.length), 0, { ...row, dropped: true, droppedIds: droppedFor(row.key), changeIds: [] })
  })
  const removed: DisplayRow[] = effective.removed.map((row) => ({ ...row, dropped: false, droppedIds: droppedFor(row.key) }))
  for (const row of full.removed) {
    if (effective.removed.some((item) => item.key === row.key)) continue
    removed.push({ ...row, dropped: true, droppedIds: droppedFor(row.key), changeIds: [] })
  }
  return { rows, removed }
}

/** Drop (×) or restore (↺) a set of changes. */
export function setEntriesEnabled(entries: ProposalEntry[], ids: string[], enabled: boolean): ProposalEntry[] {
  const wanted = new Set(ids)
  return entries.map((entry) => (wanted.has(entry.id) ? { ...entry, enabled } : entry))
}

/** The writer dragged the row titled `title` to place `to` in the proposed order. */
export function withWriterMove(entries: ProposalEntry[], title: string, to: number): ProposalEntry[] {
  const next = entries.length + 1
  return [...entries, { id: `w${next}`, change: { op: 'move', title, to }, origin: 'writer', enabled: true }]
}

// ---- The write sequence ------------------------------------------------------------------------

/** One call of an existing Plan operation (src/main/plan.ts), naming its part by title or path. */
export type PlanOp =
  | { op: 'createIndexNote' }
  | { op: 'removePart'; title: string }
  | { op: 'adoptPart'; path: string; title: string }
  | { op: 'insertPart'; title: string; gloss?: string; role?: string }
  | { op: 'movePart'; title: string; to: number }
  | { op: 'setPartRole'; title: string; role: string }
  | { op: 'materialisePart'; title: string; index: number }

/**
 * The Plan operations that turn the Basis order into the proposed one. Order of application:
 * create the Index Note, take parts out, append adopted and inserted parts, reorder with the fewest
 * moves the simple sweep finds, set roles, then write out unwritten parts at their final place (the
 * file name carries the part's number).
 */
export function planOperations(basis: ProposalBasis, proposed: ProposedPlan): PlanOp[] {
  const ops: PlanOp[] = []
  if (proposed.createsIndexNote && (proposed.rows.length || proposed.removed.length)) ops.push({ op: 'createIndexNote' })
  const removedKeys = new Set(proposed.removed.map((row) => row.key))
  const working = basis.parts
    .filter((part) => !removedKeys.has(`part:${part.title.toLocaleLowerCase()}`))
    .map((part) => ({ key: `part:${part.title.toLocaleLowerCase()}`, title: part.title, role: part.role }))
  for (const row of proposed.removed) ops.push({ op: 'removePart', title: row.title })
  for (const row of proposed.rows) {
    if (working.some((item) => item.key === row.key)) continue
    if (row.key.startsWith('stray:') && row.path) {
      ops.push({ op: 'adoptPart', path: row.path, title: row.title })
      const stray = basis.strays.find((item) => item.path === row.path)
      working.push({ key: row.key, title: row.title, role: stray?.role ?? 'section' })
    } else {
      ops.push({ op: 'insertPart', title: row.title, ...(row.gloss ? { gloss: row.gloss } : {}), ...(row.role !== 'section' ? { role: row.role } : {}) })
      working.push({ key: row.key, title: row.title, role: row.role })
    }
  }
  const target = proposed.rows.map((row) => row.key)
  for (let place = 0; place < target.length; place += 1) {
    const from = working.findIndex((item) => item.key === target[place])
    if (from < 0 || from === place) continue
    const [moved] = working.splice(from, 1)
    working.splice(place, 0, moved)
    ops.push({ op: 'movePart', title: moved.title, to: place })
  }
  for (const row of proposed.rows) {
    const current = working.find((item) => item.key === row.key)
    if (current && current.role !== row.role) ops.push({ op: 'setPartRole', title: row.title, role: row.role })
  }
  proposed.rows.forEach((row, index) => {
    if (row.materialise) ops.push({ op: 'materialisePart', title: row.title, index })
  })
  return ops
}

// ---- Fingerprints ------------------------------------------------------------------------------

export const ABSENT = 'ABSENT'
/** A file as it stood when the proposal was made (or right after it was accepted). */
export type Fingerprint = { path: string; hash: string; title?: string | null }
export type FileNow = { path: string; hash: string; title?: string | null }
export type FileDrift = {
  path: string
  kind: 'renamed' | 'missing' | 'retitled' | 'edited' | 'created'
  /** For `renamed`: where the same content now lives. */
  to?: string
  /** For `retitled`, or a rename that also changed the title: the titles before and now. */
  fromTitle?: string | null
  toTitle?: string | null
}

/**
 * Which fingerprinted files have changed. `current` is every file's state now (a path missing
 * from it, or hashed ABSENT, is gone). A file that is gone but whose exact content now sits at
 * another path in `current` was renamed. A title-only fingerprint (no hash) compares titles.
 */
export function driftedFiles(fingerprints: Fingerprint[], current: FileNow[]): FileDrift[] {
  const byPath = new Map(current.filter((file) => file.hash !== ABSENT).map((file) => [file.path, file]))
  const drift: FileDrift[] = []
  for (const print of fingerprints) {
    const now = byPath.get(print.path)
    if (print.hash === ABSENT) {
      if (now) drift.push({ path: print.path, kind: 'created' })
      continue
    }
    if (!now) {
      const moved = current.find((file) => file.hash === print.hash && file.hash !== ABSENT && !fingerprints.some((other) => other.path === file.path))
      drift.push(moved
        ? { path: print.path, kind: 'renamed', to: moved.path, fromTitle: print.title ?? null, toTitle: moved.title ?? null }
        : { path: print.path, kind: 'missing', fromTitle: print.title ?? null })
      continue
    }
    if (print.title !== undefined && (print.title ?? null) !== (now.title ?? null)) {
      drift.push({ path: print.path, kind: 'retitled', fromTitle: print.title ?? null, toTitle: now.title ?? null })
    } else if (print.hash !== '' && print.hash !== now.hash && print.title === undefined) {
      drift.push({ path: print.path, kind: 'edited' })
    }
  }
  return drift
}

const fileName = (path: string) => path.split('/').at(-1) ?? path

/** The stale card's sentence (frame 6): which file changed after the proposal was made. */
export function staleMessage(drift: FileDrift[]): string {
  const first = drift[0]
  if (!first) return ''
  const name = fileName(first.path)
  const what = first.kind === 'renamed' ? 'was renamed'
    : first.kind === 'missing' ? 'was moved or deleted'
      : first.kind === 'retitled' ? 'has a new title'
        : first.kind === 'created' ? 'was created'
          : 'was edited'
  const more = drift.length > 1 ? ` (and ${drift.length - 1} more ${drift.length === 2 ? 'file' : 'files'})` : ''
  return `The folder changed after this was proposed: ${name} ${what}${more}.`
}

/** What Undo would overwrite, and whether it is the writer's or the agent's later change. */
export type UndoBlock = { drift: FileDrift[]; laterAgentFiles: string[] }

/**
 * The undo refusal (frame 5): name what is in the way and what to do instead. A later rename of a
 * part is named by its titles; any other later change by its file.
 */
export function undoRefusalMessage(block: UndoBlock): string {
  const rename = block.drift.find((item) => item.kind === 'renamed' || item.kind === 'retitled')
  if (rename) {
    const before = rename.fromTitle ?? fileName(rename.path)
    const after = rename.toTitle ?? (rename.to ? fileName(rename.to) : null)
    const renamed = after && after !== before ? `renamed ${before} to ${after}` : `renamed ${before}`
    return `Can't put the order back: you have since ${renamed}, and undoing would bring back the old name in the plan. Undo the rename first, or change the order in the Plan pane.`
  }
  const edited = block.drift[0]
  if (edited) {
    const name = fileName(edited.path)
    const what = edited.kind === 'missing' ? 'moved or deleted' : edited.kind === 'created' ? 'created' : 'changed'
    return `Can't put the order back: ${name} has been ${what} since the order was set, and undoing would overwrite that. Undo that change first, or change the order in the Plan pane.`
  }
  const later = block.laterAgentFiles[0]
  if (later) {
    return `Can't put the order back: a later agent change to ${fileName(later)} would be undone with it. Undo that turn first, or change the order in the Plan pane.`
  }
  return ''
}

// ---- The wire between main and the card ---------------------------------------------------------

export type PlanProposalStatus = 'pending' | 'stale' | 'accepted' | 'discarded' | 'gone'

/** What the order looks like after Accept (frame 4's Plan card). */
export type AcceptedSummary = {
  count: number
  folderName: string
  parts: Array<{ title: string; path: string | null }>
  outside: Array<{ title: string; path: string }>
  createdIndexNote: boolean
  /** The folder has a `_report-structure.json`, which follows from the Index Note. */
  manifest: boolean
  undoable: boolean
}

export type PlanProposalView = {
  id: string
  status: PlanProposalStatus
  dir: string
  summary?: string
  basis: ProposalBasis
  changes: PlanProposalChange[]
  /** Files that changed after the proposal was made; non-empty means Accept is replaced by Propose again. */
  stale: FileDrift[]
  accepted?: AcceptedSummary
}

export type PlanAcceptResult =
  | { ok: true; accepted: AcceptedSummary; paths: string[] }
  | { ok: false; message: string; stale?: FileDrift[] }

export type PlanUndoResult = { ok: true; paths: string[] } | { ok: false; message: string }

/** The writer's edits as sent to Accept: which agent changes stay, plus the writer's own drags. */
export type PlanAcceptEdits = { enabled: string[]; writerMoves: Array<{ id: string; title: string; to: number; enabled: boolean }> }

export function editsFromEntries(entries: ProposalEntry[]): PlanAcceptEdits {
  return {
    enabled: entries.filter((entry) => entry.origin === 'agent' && entry.enabled).map((entry) => entry.id),
    writerMoves: entries.flatMap((entry) => (
      entry.origin === 'writer' && entry.change.op === 'move'
        ? [{ id: entry.id, title: entry.change.title, to: entry.change.to, enabled: entry.enabled }]
        : []
    )),
  }
}

/** Rebuild the entry list from the agent's changes and the writer's edits (main never trusts the renderer's changes). */
export function entriesFromEdits(changes: PlanProposalChange[], edits?: PlanAcceptEdits): ProposalEntry[] {
  const agent = proposalEntries(changes)
  if (!edits) return agent
  const enabled = new Set(edits.enabled)
  return [
    ...agent.map((entry) => ({ ...entry, enabled: enabled.has(entry.id) })),
    ...edits.writerMoves.map((move) => ({
      id: move.id,
      change: { op: 'move' as const, title: String(move.title), to: Number(move.to) },
      origin: 'writer' as const,
      enabled: move.enabled === true,
    })),
  ]
}
