import { diffContent, type ContentDiffSegment } from './content-diff.ts'

/**
 * Portable Change Ledger model and helpers (ADR-0010/0011/0014). This module is deliberately
 * framework-agnostic: no Electron, React, or filesystem imports, so it can be lifted into Bridle and
 * tested with plain `bun test`.
 */

/**
 * Every edit that touches a document is one Change, whatever its origin: an agent prose suggestion,
 * the writer's own direct edit, or a reviewer's pasted-in comment applied by either hand. Three
 * dimensions ride on each record: `editClass` (internal, ADR-0005), writer-facing `category`
 * (ADR-0014), and `provenance` (ADR-0011).
 *
 * `editClass` is null for a writer edit not yet internally classified. `category` is null until the
 * agent or a later judgement pass assigns a writer-facing label such as typo, grammar, or wording.
 * A `reviewer` change records `appliedBy` (the writer typed it, or the agent drafted it from the
 * comment) and the `reviewerLabel`.
 */
export type Provenance = 'agent' | 'writer' | 'reviewer'
export type EditClass = 'copy' | 'content' | 'move' | 'insert' | 'housekeeping'
export type ChangeStatus = 'pending' | 'accepted' | 'rejected' | 'held'
export type EditSessionStatus = 'open' | 'reviewing' | 'saved' | 'discarded'
export type SessionDecision = 'accept' | 'reject'

export type AuthorIdentity = {
  name: string
  email?: string
}

export type Version = {
  id: string
  path: string
  name: string
  author: AuthorIdentity
  ts: number
  note?: string
  snapshotId?: string
  versionId?: string
}

export type VersionScope = { path?: string }

/**
 * Map the agent's writer-facing category to the internal edit class used by the engine. Unknown
 * categories default to content: that is the safer review bucket for a category string introduced
 * before this app version knows about it.
 */
export function editClassForCategory(category: string): EditClass {
  switch (category) {
    case 'typo':
    case 'grammar':
      return 'copy'
    case 'wording':
    case 'structure':
    case 'clarity':
    case 'tone':
    case 'other':
    default:
      return 'content'
  }
}

export type Change = {
  id: string
  /** Workspace-relative document the change lands in. */
  path: string
  /** Epoch ms the change was recorded. */
  ts: number
  provenance: Provenance
  /** null = a writer edit not yet classified (lazy classification, ADR-0011). */
  editClass: EditClass | null
  /** Writer-facing category; null until an agent/judgement pass labels the edit. */
  category: string | null
  summary: string
  /**
   * For `editClass: 'move'`, `oldText` is the moved text at the source and `newText` is the moved
   * text at the destination. Agent-captured moves carry `moveFrom` as the source range and `moveTo`
   * as the destination range; lazily-classified moves have no structured endpoints yet.
   */
  oldText: string
  newText: string
  /** The document range this change occupies in the buffer it was captured against — the stable,
   *  general handle for the dock↔document link (ADR-0010), since oldText/newText can repeat or be
   *  overwritten by a later edit. Absolute offsets valid against that buffer state; historical changes
   *  whose buffer has since moved fall back to a text match. Absent when capture could not resolve a range. */
  anchor?: { from: number; to: number }
  /** Move source range. Present with moveTo for agent-captured moves, absent for lazy moves. */
  moveFrom?: { from: number; to: number }
  /** Move destination range. Present with moveFrom for agent-captured moves, absent for lazy moves. */
  moveTo?: { from: number; to: number }
  /**
   * For `editClass: 'insert'`, the exact unique existing text the new content is inserted AFTER. An empty
   * string means "append at the end of the document" — the path a write into an empty/near-empty file takes,
   * so an agent that has nothing to replace can still place text (oldText is '' for an insertion). Agent
   * inserts locate this anchor by text search, exactly like the anchor-free oldText path of a prose edit.
   */
  insertAfter?: string
  status: ChangeStatus
  /** True when the writer edited agent-authored text — the feedback-corpus signal (ADR-0011). */
  isCorrection: boolean
  /** The collaborative editing session this change belongs to, once session ops land (ADR-0014). */
  sessionId?: string
  /** For provenance 'reviewer': whether the writer typed it or the agent drafted it from the comment. */
  appliedBy?: 'writer' | 'agent'
  reviewerLabel?: string
  /** The Named Snapshot (version) this change belongs to, once versions land (ADR-0005). */
  snapshotId?: string
  /** The Version record this change belongs to (ADR-0016 V3 compare uses this ledger stamp). */
  versionId?: string
  /** The identity that made the change; provenance remains the role axis. */
  author?: AuthorIdentity
}

export type EditSession = {
  id: string
  path: string
  startedTs: number
  turnId?: string
  status: EditSessionStatus
  versionId?: string
  note?: string
}

/** The fields a caller supplies; the store assigns `id`, `ts` (unless given), and defaults `status`. */
export type NewChange = Omit<Change, 'id' | 'ts' | 'status' | 'category'> & {
  ts?: number
  status?: ChangeStatus
  category?: string | null
}

/** Filter for list(): any subset narrows; omitted fields don't constrain. */
export type ChangeScope = { path?: string; provenance?: Provenance; status?: ChangeStatus }

/** Null categories are filterable as this explicit review-panel bucket. */
export const UNCATEGORISED_CATEGORY = 'uncategorised'

export type LocationGroup = {
  key: string
  /** Null means the change had no anchor or move endpoint, so it sorts after located changes. */
  from: number | null
  changes: Change[]
}

export type RunSummary = {
  /** Pending changes still needing review; accepted/rejected changes are already decided. */
  total: number
  byCategory: Record<string, number>
  byProvenance: Record<Provenance, number>
  /** Pending writer-provenance changes, for the "Your edits, folded in" affordance. */
  yours: number
}

export type SessionReconcile = {
  accepted: Change[]
  rejected: Change[]
  pending: Change[]
  corpusEntries: Change[]
  writerEdits: Change[]
}

export const WORKING_VERSION_ID = 'working'

export type VersionCompareEndpointId = string | typeof WORKING_VERSION_ID

export type VersionCompareEndpoint = {
  id: string
  name: string
  ts: number | null
  author: AuthorIdentity | null
  working: boolean
}

export type AttributedChange = Change & {
  author: AuthorIdentity
  sourceVersionId: string | null
  sourceVersionName: string | null
  compareOldText: string
  compareNewText: string
  compareSegments?: ContentDiffSegment[]
  compareOldStart?: number
  compareOldLines?: number
  compareNewStart?: number
  compareNewLines?: number
  diffKind?: 'added' | 'removed' | 'changed'
}

export type VersionCompareResult = {
  path: string
  from: VersionCompareEndpoint
  to: VersionCompareEndpoint
  fromContent: string
  toContent: string
  direction: 'forward' | 'reverse' | 'same'
  versionIds: string[]
  changes: AttributedChange[]
}

const CHANGE_ID = /^c_[0-9a-z]+$/
const VERSION_ID = /^v_[0-9A-Za-z_-]+$/

export type ChangeIdSource = {
  now: () => number
  random: () => number
}

export type ChangeIdFactory = (taken: Set<string>) => string

export function createChangeIdFactory(source: ChangeIdSource): ChangeIdFactory {
  let counter = 0
  return (taken: Set<string>): string => {
    let id = ''
    do {
      id = `c_${source.now().toString(36)}${(counter++).toString(36)}${source.random().toString(36).slice(2, 5)}`
    } while (taken.has(id))
    return id
  }
}

const isEditClass = (v: unknown): v is EditClass =>
  v === 'copy' || v === 'content' || v === 'move' || v === 'insert' || v === 'housekeeping'

const isRange = (v: unknown): v is { from: number; to: number } => {
  if (typeof v !== 'object' || v === null) return false
  const range = v as Record<string, unknown>
  return typeof range.from === 'number' && Number.isFinite(range.from) &&
    typeof range.to === 'number' && Number.isFinite(range.to)
}

const isAuthorIdentity = (v: unknown): v is AuthorIdentity => {
  if (typeof v !== 'object' || v === null) return false
  const author = v as Record<string, unknown>
  return typeof author.name === 'string' && author.name.trim() !== '' &&
    (author.email === undefined || typeof author.email === 'string')
}

export function parseVersionLine(line: string): Version | null {
  if (line.trim() === '') return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !VERSION_ID.test(v.id)) return null
  if (typeof v.path !== 'string' || v.path.trim() === '') return null
  if (typeof v.name !== 'string' || v.name.trim() === '') return null
  if (!isAuthorIdentity(v.author)) return null
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return null
  if (v.note !== undefined && typeof v.note !== 'string') return null
  if (v.snapshotId !== undefined && typeof v.snapshotId !== 'string') return null
  if (v.versionId !== undefined && typeof v.versionId !== 'string') return null
  return v as Version
}

export function serializeVersions(versions: Version[]): string {
  return versions.length ? versions.map((v) => JSON.stringify(v)).join('\n') + '\n' : ''
}

export function sortVersionsNewestFirst(versions: readonly Version[]): Version[] {
  return [...versions].sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
}

export function matchesVersionScope(version: Version, scope?: VersionScope): boolean {
  if (!scope) return true
  if (scope.path !== undefined && version.path !== scope.path) return false
  return true
}

/**
 * Parse one journal line to a Change, or null if it is blank or malformed. EVERY required field is
 * validated (not just the discriminants), so a truncated or hand-mangled line is treated as corrupt
 * rather than handed downstream as a Change with `undefined` where a string/boolean is typed. Legacy
 * pre-category lines are normalised to `category: null` so older journals remain readable.
 */
export function parseChangeLine(line: string): Change | null {
  if (line.trim() === '') return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const c = value as Record<string, unknown>
  if (typeof c.id !== 'string' || !CHANGE_ID.test(c.id)) return null
  if (typeof c.path !== 'string' || typeof c.ts !== 'number' || !Number.isFinite(c.ts)) return null
  if (c.provenance !== 'agent' && c.provenance !== 'writer' && c.provenance !== 'reviewer') return null
  if (c.editClass !== null && !isEditClass(c.editClass)) return null
  if (c.category !== undefined && c.category !== null && typeof c.category !== 'string') return null
  if (typeof c.summary !== 'string' || typeof c.oldText !== 'string' || typeof c.newText !== 'string') return null
  if (c.status !== 'pending' && c.status !== 'accepted' && c.status !== 'rejected' && c.status !== 'held') return null
  if (typeof c.isCorrection !== 'boolean') return null
  if (c.sessionId !== undefined && typeof c.sessionId !== 'string') return null
  if (c.appliedBy !== undefined && c.appliedBy !== 'writer' && c.appliedBy !== 'agent') return null
  if (c.reviewerLabel !== undefined && typeof c.reviewerLabel !== 'string') return null
  if (c.snapshotId !== undefined && typeof c.snapshotId !== 'string') return null
  if (c.versionId !== undefined && typeof c.versionId !== 'string') return null
  if (c.author !== undefined && !isAuthorIdentity(c.author)) return null
  if (c.anchor !== undefined && !isRange(c.anchor)) return null
  if (c.moveFrom !== undefined && !isRange(c.moveFrom)) return null
  if (c.moveTo !== undefined && !isRange(c.moveTo)) return null
  if (c.insertAfter !== undefined && typeof c.insertAfter !== 'string') return null
  // No legacy migration is needed: no producer ever persisted an anchor+moveTo-only move shape.
  if ((c.moveFrom === undefined) !== (c.moveTo === undefined)) return null
  if (c.editClass !== 'move' && (c.moveFrom !== undefined || c.moveTo !== undefined)) return null
  if (c.insertAfter !== undefined && c.editClass !== 'insert') return null

  return { ...c, category: c.category ?? null } as Change
}

/** Serialise changes to a JSONL journal (one compact record per line, trailing newline). */
export function serializeChanges(changes: Change[]): string {
  return changes.length ? changes.map((c) => JSON.stringify(c)).join('\n') + '\n' : ''
}

/** True when `change` passes every constraint the scope sets (an omitted field never constrains). */
export function matchesScope(change: Change, scope?: ChangeScope): boolean {
  if (!scope) return true
  if (scope.path !== undefined && change.path !== scope.path) return false
  if (scope.provenance !== undefined && change.provenance !== scope.provenance) return false
  if (scope.status !== undefined && change.status !== scope.status) return false
  return true
}

const categoryKey = (category: string | null): string => category ?? UNCATEGORISED_CATEGORY

const primaryLocation = (change: Change): number | null =>
  change.anchor?.from ?? change.moveTo?.from ?? change.moveFrom?.from ?? null

export function versionLedgerId(version: Version): string {
  return version.versionId ?? version.id
}

export function changeVersionId(change: Change): string | null {
  return change.versionId ?? change.snapshotId ?? null
}

/**
 * Group changes in document order for the session review panel. Located changes sort by their
 * primary offset; unanchored changes have no document position, so they remain stable at the end.
 */
export function groupByLocation(changes: Change[]): LocationGroup[] {
  const ordered = changes
    .map((change, index) => {
      const from = primaryLocation(change)
      return {
        change,
        from,
        index,
        key: from === null ? `unanchored:${index}` : `offset:${from}`,
      }
    })
    .sort((a, b) => {
      if (a.from === null && b.from === null) return a.index - b.index
      if (a.from === null) return 1
      if (b.from === null) return -1
      return a.from === b.from ? a.index - b.index : a.from - b.from
    })

  const groups: LocationGroup[] = []
  for (const item of ordered) {
    const previous = groups.at(-1)
    if (previous && previous.key === item.key) {
      previous.changes.push(item.change)
    } else {
      groups.push({ key: item.key, from: item.from, changes: [item.change] })
    }
  }
  return groups
}

const versionOrder = (versions: readonly Version[]): Version[] =>
  [...versions].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))

function endpointView(version: Version | null): VersionCompareEndpoint {
  if (!version) {
    return { id: WORKING_VERSION_ID, name: 'Working', ts: null, author: null, working: true }
  }
  return {
    id: version.id,
    name: version.name,
    ts: version.ts,
    author: version.author,
    working: false,
  }
}

function fallbackAuthor(change: Change, sourceVersion: Version | null, workingAuthor?: AuthorIdentity): AuthorIdentity {
  if (change.author) return change.author
  if (change.provenance === 'agent') return { name: 'WriteFlex Agent' }
  if (change.provenance === 'reviewer') return { name: change.reviewerLabel ?? 'Reviewer' }
  return sourceVersion?.author ?? workingAuthor ?? { name: 'Writer' }
}

export function compareVersionsByLedger(input: {
  versions: readonly Version[]
  changes: readonly Change[]
  path: string
  fromId: VersionCompareEndpointId
  toId: VersionCompareEndpointId
  workingAuthor?: AuthorIdentity
}): VersionCompareResult {
  const ordered = versionOrder(input.versions.filter((version) => version.path === input.path))
  const indexFor = (id: VersionCompareEndpointId): number => {
    if (id === WORKING_VERSION_ID) return ordered.length
    const index = ordered.findIndex((version) => version.id === id || versionLedgerId(version) === id)
    if (index === -1) throw new Error(`No version with id ${id}.`)
    return index
  }

  const fromIndex = indexFor(input.fromId)
  const toIndex = indexFor(input.toId)
  const fromVersion = input.fromId === WORKING_VERSION_ID ? null : ordered[fromIndex] ?? null
  const toVersion = input.toId === WORKING_VERSION_ID ? null : ordered[toIndex] ?? null

  if (fromIndex === toIndex) {
    return {
      path: input.path,
      from: endpointView(fromVersion),
      to: endpointView(toVersion),
      fromContent: '',
      toContent: '',
      direction: 'same',
      versionIds: [],
      changes: [],
    }
  }

  const direction: 'forward' | 'reverse' = fromIndex < toIndex ? 'forward' : 'reverse'
  const lower = Math.min(fromIndex, toIndex)
  const upper = Math.max(fromIndex, toIndex)
  const versionsInRange = ordered.slice(lower + 1, upper + 1)
  const versionIds = versionsInRange.map(versionLedgerId)
  const versionsByLedgerId = new Map(versionsInRange.map((version) => [versionLedgerId(version), version]))
  const includesWorking = upper === ordered.length

  const selected = input.changes
    .filter((change) => change.path === input.path)
    .map((change, index) => ({ change, index, versionId: changeVersionId(change) }))
    .filter(({ change, versionId }) => {
      if (versionId) return versionsByLedgerId.has(versionId)
      return includesWorking && change.status !== 'rejected'
    })
    .map(({ change, index, versionId }) => {
      const sourceVersion = versionId ? versionsByLedgerId.get(versionId) ?? null : null
      const oldText = direction === 'reverse' ? change.newText : change.oldText
      const newText = direction === 'reverse' ? change.oldText : change.newText
      const attributed: AttributedChange & { __index?: number } = {
        ...change,
        author: fallbackAuthor(change, sourceVersion, input.workingAuthor),
        sourceVersionId: versionId,
        sourceVersionName: sourceVersion?.name ?? (versionId ? null : 'Working'),
        compareOldText: oldText,
        compareNewText: newText,
        __index: index,
      }
      return attributed
    })
    .sort((a, b) => {
      const ao = primaryLocation(a)
      const bo = primaryLocation(b)
      if (ao === null && bo === null) return (a.__index ?? 0) - (b.__index ?? 0)
      if (ao === null) return 1
      if (bo === null) return -1
      return ao === bo ? (a.__index ?? 0) - (b.__index ?? 0) : ao - bo
    })

  for (const change of selected) delete change.__index

  return {
    path: input.path,
    from: endpointView(fromVersion),
    to: endpointView(toVersion),
    fromContent: '',
    toContent: '',
    direction,
    versionIds,
    changes: selected,
  }
}

function rangeVersionData(input: {
  ordered: readonly Version[]
  fromId: VersionCompareEndpointId
  toId: VersionCompareEndpointId
}): {
  fromVersion: Version | null
  toVersion: Version | null
  direction: 'forward' | 'reverse' | 'same'
  versionIds: string[]
  versionsByLedgerId: Map<string, Version>
  includesWorking: boolean
} {
  const indexFor = (id: VersionCompareEndpointId): number => {
    if (id === WORKING_VERSION_ID) return input.ordered.length
    const index = input.ordered.findIndex((version) => version.id === id || versionLedgerId(version) === id)
    if (index === -1) throw new Error(`No version with id ${id}.`)
    return index
  }
  const fromIndex = indexFor(input.fromId)
  const toIndex = indexFor(input.toId)
  const fromVersion = input.fromId === WORKING_VERSION_ID ? null : input.ordered[fromIndex] ?? null
  const toVersion = input.toId === WORKING_VERSION_ID ? null : input.ordered[toIndex] ?? null
  const lower = Math.min(fromIndex, toIndex)
  const upper = Math.max(fromIndex, toIndex)
  const versionsInRange = input.ordered.slice(lower + 1, upper + 1)
  return {
    fromVersion,
    toVersion,
    direction: fromIndex === toIndex ? 'same' : fromIndex < toIndex ? 'forward' : 'reverse',
    versionIds: versionsInRange.map(versionLedgerId),
    versionsByLedgerId: new Map(versionsInRange.map((version) => [versionLedgerId(version), version])),
    includesWorking: upper === input.ordered.length,
  }
}

function selectedAttributionChanges(input: {
  changes: readonly Change[]
  path: string
  versionsByLedgerId: Map<string, Version>
  includesWorking: boolean
  direction: 'forward' | 'reverse' | 'same'
  workingAuthor?: AuthorIdentity
}): AttributedChange[] {
  if (input.direction === 'same') return []
  return input.changes
    .filter((change) => change.path === input.path)
    .map((change, index) => ({ change, index, versionId: changeVersionId(change) }))
    .filter(({ change, versionId }) => {
      if (versionId) return input.versionsByLedgerId.has(versionId)
      return input.includesWorking && change.status !== 'rejected'
    })
    .map(({ change, index, versionId }) => {
      const sourceVersion = versionId ? input.versionsByLedgerId.get(versionId) ?? null : null
      return {
        ...change,
        author: fallbackAuthor(change, sourceVersion, input.workingAuthor),
        sourceVersionId: versionId,
        sourceVersionName: sourceVersion?.name ?? (versionId ? null : 'Working'),
        compareOldText: input.direction === 'reverse' ? change.newText : change.oldText,
        compareNewText: input.direction === 'reverse' ? change.oldText : change.newText,
        __index: index,
      } as AttributedChange & { __index?: number }
    })
}

function textMatchesHunk(needle: string, haystack: string): boolean {
  const trimmed = needle.trim()
  if (!trimmed) return true
  return haystack.includes(needle) || haystack.includes(trimmed)
}

function matchesHunk(change: AttributedChange, oldText: string, newText: string): boolean {
  return textMatchesHunk(change.compareOldText, oldText) && textMatchesHunk(change.compareNewText, newText)
}

export function compareVersionContents(input: {
  versions: readonly Version[]
  changes: readonly Change[]
  path: string
  fromId: VersionCompareEndpointId
  toId: VersionCompareEndpointId
  fromContent: string
  toContent: string
  workingAuthor?: AuthorIdentity
}): VersionCompareResult {
  const ordered = versionOrder(input.versions.filter((version) => version.path === input.path))
  const range = rangeVersionData({ ordered, fromId: input.fromId, toId: input.toId })
  if (range.direction === 'same') {
    return {
      path: input.path,
      from: endpointView(range.fromVersion),
      to: endpointView(range.toVersion),
      fromContent: input.fromContent,
      toContent: input.toContent,
      direction: 'same',
      versionIds: [],
      changes: [],
    }
  }

  const attribution = selectedAttributionChanges({
    changes: input.changes,
    path: input.path,
    versionsByLedgerId: range.versionsByLedgerId,
    includesWorking: range.includesWorking,
    direction: range.direction,
    ...(input.workingAuthor ? { workingAuthor: input.workingAuthor } : {}),
  })
  const used = new Set<string>()
  const fallbackAuthorForHunk = range.toVersion?.author ?? input.workingAuthor ?? { name: 'Unattributed' }
  const fallbackSourceName = endpointView(range.toVersion).name

  const changes = diffContent(input.fromContent, input.toContent).map((hunk, index): AttributedChange => {
    const matched = attribution.find((change) => !used.has(change.id) && matchesHunk(change, hunk.oldText, hunk.newText))
    if (matched) {
      used.add(matched.id)
      return {
        ...matched,
        id: matched.id,
        oldText: hunk.oldText,
        newText: hunk.newText,
        compareOldText: hunk.oldText,
        compareNewText: hunk.newText,
        compareSegments: hunk.segments,
        compareOldStart: hunk.oldStart,
        compareOldLines: hunk.oldLines,
        compareNewStart: hunk.newStart,
        compareNewLines: hunk.newLines,
        diffKind: hunk.kind,
      }
    }
    return {
      id: `c_hunk${index + 1}`,
      path: input.path,
      ts: range.toVersion?.ts ?? Date.now(),
      provenance: 'writer',
      editClass: 'content',
      category: null,
      summary: hunk.kind,
      oldText: hunk.oldText,
      newText: hunk.newText,
      status: 'accepted',
      isCorrection: false,
      author: fallbackAuthorForHunk,
      sourceVersionId: range.toVersion ? versionLedgerId(range.toVersion) : null,
      sourceVersionName: fallbackSourceName,
      compareOldText: hunk.oldText,
      compareNewText: hunk.newText,
      compareSegments: hunk.segments,
      compareOldStart: hunk.oldStart,
      compareOldLines: hunk.oldLines,
      compareNewStart: hunk.newStart,
      compareNewLines: hunk.newLines,
      diffKind: hunk.kind,
    }
  })

  return {
    path: input.path,
    from: endpointView(range.fromVersion),
    to: endpointView(range.toVersion),
    fromContent: input.fromContent,
    toContent: input.toContent,
    direction: range.direction,
    versionIds: range.versionIds,
    changes,
  }
}

/** Hide changes whose writer-facing category is in `hidden`; null categories use `uncategorised`. */
export function filterByCategory(changes: Change[], hidden: Set<string>): Change[] {
  return changes.filter((change) => !hidden.has(categoryKey(change.category)))
}

/** Summarise only pending changes: accepted/rejected edits have already left the review queue. */
export function summariseRun(changes: Change[]): RunSummary {
  const byProvenance: Record<Provenance, number> = { agent: 0, writer: 0, reviewer: 0 }
  const byCategory: Record<string, number> = {}

  for (const change of changes) {
    if (change.status !== 'pending') continue
    const key = categoryKey(change.category)
    byCategory[key] = (byCategory[key] ?? 0) + 1
    byProvenance[change.provenance] += 1
  }

  return {
    total: byProvenance.agent + byProvenance.writer + byProvenance.reviewer,
    byCategory,
    byProvenance,
    yours: byProvenance.writer,
  }
}

const terminalChange = (change: Change, status: ChangeStatus): Change => {
  const resolved: Change = { ...change, status }
  if (change.anchor) resolved.anchor = { ...change.anchor }
  if (change.moveFrom) resolved.moveFrom = { ...change.moveFrom }
  if (change.moveTo) resolved.moveTo = { ...change.moveTo }
  return resolved
}

/**
 * Compute the Save version record. Explicit accept/reject decisions resolve pending changes; already
 * terminal changes stay terminal unless an explicit decision overrides them. A missing decision leaves
 * an undecided change pending, because saving a version is a history checkpoint, not accept-all.
 */
export function reconcileSession(changes: Change[], decisions: Record<string, SessionDecision>): SessionReconcile {
  const accepted: Change[] = []
  const rejected: Change[] = []
  const pending: Change[] = []

  for (const change of changes) {
    const decision = decisions[change.id]
    const status = decision === 'accept'
      ? 'accepted'
      : decision === 'reject'
        ? 'rejected'
        : change.status
    const resolved = terminalChange(change, status)
    if (resolved.status === 'accepted') {
      accepted.push(resolved)
    } else if (resolved.status === 'rejected') {
      rejected.push(resolved)
    } else {
      pending.push(resolved)
    }
  }

  return {
    accepted,
    rejected,
    pending,
    // corpusEntries are accepted corrections; re-save adapters should feed only newly accepted
    // corrections to corpus ingestion to avoid double-counting.
    corpusEntries: accepted.filter((change) => change.isCorrection),
    writerEdits: accepted.filter((change) => change.provenance === 'writer'),
  }
}
