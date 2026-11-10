/**
 * The three record kinds of `.writeflex/folio-versions.jsonl` (ADR-0052 § Records), and the one
 * parser every reader and writer of that journal goes through. Pure: no disk, no clock, no node
 * imports, so the renderer can share the types later.
 *
 * The parser BUILDS each record from the fields it knows and nothing else. A line carrying an extra
 * field (a machine path, a session id, anything) parses to a record without it, and a writer that
 * hands in an object with extras writes the same stripped record. Every path in a record is a
 * Collection-relative posix path, never an absolute one.
 */

export type FolioMemberRole = 'index' | 'part' | 'unlisted' | 'inserted'
export type FolioContentMember = {
  role: FolioMemberRole
  /** A label as of that time; resolve by `versionId`. */
  path: string
  title?: string
  order?: number
  /** The per-file version this member points to (`.writeflex/versions.jsonl`). */
  versionId: string
}
export type FolioReferenceMember = { role: 'reference'; path: string; sha256: string; why: 'linked' | 'too-large' }
export type FolioMember = FolioContentMember | FolioReferenceMember

export type FolioIncomingSection = {
  heading: string
  /** sha256 of her section Markdown, an object in `.writeflex/folio-objects/`. */
  object?: string
  match: 'exact' | 'confirmed' | 'new' | 'unmatched'
  part?: string
}
export type FolioIncoming = {
  author: string
  docx: { sha256: string; name: string }
  /** The Folio version she started from (`fv_…`). */
  base: string
  /** Importer version that made the sections. */
  converter: number
  sections: FolioIncomingSection[]
  tableNotes: Array<{ file: string; cellsDiffering: number }>
}

export type FolioVersion = {
  kind: 'folio-version'
  id: string
  ts: number
  name: string
  note?: string
  author: { name: string; email?: string }
  /** The Folio's identity is its Index Note's per-file history, not a folder path. */
  index: { path: string; versionId: string }
  members: FolioMember[]
  incoming?: FolioIncoming
}

/**
 * Renames, sent marks, withdrawn revisions. `id` is a Folio version's id. Two forms share the kind:
 * - a DELTA (`delta: true`, what the store writes now) carries only the fields that changed
 *   (`sentTo: null` and `withdrawn: false` clear); the state of a version is every mark line for its id
 *   folded in journal order, so two writers appending at once compose without a lock;
 * - a FULL record (no `delta`, written before deltas) is the whole state and replaces what came before it.
 */
export type FolioVersionMark = {
  kind: 'folio-version-mark'
  id: string
  ts: number
  delta?: true
  name?: string
  sentTo?: string | null
  withdrawn?: boolean
}

/** What the mark lines for one Folio version add up to. */
export type FolioMarkState = { name?: string; sentTo?: string; withdrawn?: true }

/** Fold one version's mark lines, in journal order, into its current mark state. */
export function foldFolioMarks(marks: readonly FolioVersionMark[]): FolioMarkState {
  let state: FolioMarkState = {}
  for (const mark of marks) {
    if (!mark.delta) {
      state = {
        ...(mark.name !== undefined ? { name: mark.name } : {}),
        ...(typeof mark.sentTo === 'string' ? { sentTo: mark.sentTo } : {}),
        ...(mark.withdrawn === true ? { withdrawn: true as const } : {}),
      }
      continue
    }
    const next: FolioMarkState = { ...state }
    if (mark.name !== undefined) next.name = mark.name
    if (mark.sentTo === null) delete next.sentTo
    else if (mark.sentTo !== undefined) next.sentTo = mark.sentTo
    if (mark.withdrawn === false) delete next.withdrawn
    else if (mark.withdrawn === true) next.withdrawn = true
    state = next
  }
  return state
}

/** Makes an unfinished whole-Folio restore findable. `from` is the version restored; `safety` is the version saved first. */
export type FolioRestore = { kind: 'folio-restore'; id: string; ts: number; from: string; safety: string; state: 'begun' | 'done' | 'cancelled' }

/**
 * One decision the writer made about a co-author's revision that is not a staged suggestion (Folio versions ticket 16): add her new
 * section as a part or leave it out, use her order or keep theirs, take a part out of the running order or keep it, say which part a
 * section of hers is. `id` is the incoming Folio version; `row` names the thing decided (`new:3`, `moved:5`, `removed:<part label>`,
 * `match:2`). A decision is final: the first record for a row stands and a later one has no authority. Suggestions in the margin are
 * decided in the change ledger, not here.
 */
export type FolioDecisionChoice = 'add' | 'skip' | 'hers' | 'mine' | 'take-out' | 'keep' | 'confirm' | 'none'
export const FOLIO_DECISION_CHOICES: readonly FolioDecisionChoice[] = ['add', 'skip', 'hers', 'mine', 'take-out', 'keep', 'confirm', 'none']
export type FolioDecision = {
  kind: 'folio-decision'; id: string; ts: number; row: string; choice: FolioDecisionChoice
  /** The part acted on, or created (Collection-relative). */
  part?: string
  /** Ticket 17: for a `text:` row, the sha256 of the three texts of that row as the writer saw them (sent, theirs, yours). The decision was made over exactly these. */
  seen?: string
}
/**
 * Written BEFORE the decide step makes a new part's file: the file name chosen and the sha256 of the bytes it will hold. A stop between the
 * file and the decision is recovered only by a file that a recorded intent of this revision (and this row) names with these exact bytes; a file
 * the writer made herself, even with identical bytes, is never adopted (Folio versions ticket 16, review round 1).
 */
export type FolioDecisionIntent = { kind: 'folio-decision-intent'; id: string; ts: number; row: string; /** The new part's file (Collection-relative). */ file: string; /** sha256 of the bytes the file will hold. */ sha256: string }

/**
 * The records of `.writeflex/folio-versions.jsonl`. Decisions are NOT among them: that journal is read by the backup helper of every
 * Mac, and the helper of WriteFlex 0.28.0-alpha.9 rejects the whole projection on a line of a kind it does not know, which would stop
 * the backup of ordinary writing. Decisions and intents live in `.writeflex/folio-decisions.jsonl` (FolioDecisionRecord), a file that
 * helper never reads (ADR-0052 § Compatibility; the same arrangement as the Folio save's commit lines).
 */
export type FolioJournalRecord = FolioVersion | FolioVersionMark | FolioRestore
/** The records of `.writeflex/folio-decisions.jsonl`. */
export type FolioDecisionRecord = FolioDecision | FolioDecisionIntent

const SHA256 = /^[a-f0-9]{64}$/
const FOLIO_VERSION_ID = /^fv_[A-Za-z0-9_-]{1,64}$/
const RESTORE_ID = /^fr_[A-Za-z0-9_-]{1,64}$/
const PER_FILE_VERSION_ID = /^[A-Za-z0-9_-]{1,128}$/

export const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)
export const isFolioVersionId = (value: unknown): value is string => typeof value === 'string' && FOLIO_VERSION_ID.test(value)
/**
 * The Folio save a per-file version was written by: every per-file version a Folio save writes carries the
 * save's id (`folioSave`), which is also the id of the Folio version the save ends by recording. A marked
 * version is real only once the save is COMPLETE: the Folio journal holds a Folio version with that id, OR the
 * commit journal (`.writeflex/folio-save-commits.jsonl`) holds a commit line for it (`folio-save-committed`, folio-save-commit.ts); one whose save
 * never finished is an orphan. A value that is not a Folio version id is no marker.
 */
export const folioSaveOf = (version: object): string | undefined => {
  const id = (version as { folioSave?: unknown }).folioSave
  return isFolioVersionId(id) ? id : undefined
}

/**
 * The commit line a Folio save appends to `.writeflex/folio-save-commits.jsonl` right after its Folio version record:
 * "the save with this id finished". It holds no content, so the backup carries it even when the Folio record itself
 * is left out of scope, and a restored copy then keeps the save's per-file versions visible. It is in a file of its own
 * and never in `.writeflex/versions.jsonl`, because a backup helper that predates it rejects an unknown `kind` there.
 */
export const FOLIO_SAVE_COMMITTED = 'folio-save-committed'
export type FolioSaveCommit = { kind: typeof FOLIO_SAVE_COMMITTED; id: string; ts?: number }

/** The commit line in `value` (already parsed JSON), or null when it is not one (a bad id is no commit). */
export function parseFolioSaveCommit(value: unknown): FolioSaveCommit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.kind !== FOLIO_SAVE_COMMITTED || !isFolioVersionId(row.id)) return null
  if (row.ts !== undefined && !(typeof row.ts === 'number' && Number.isFinite(row.ts) && row.ts >= 0)) return null
  return { kind: FOLIO_SAVE_COMMITTED, id: row.id, ...(row.ts !== undefined ? { ts: row.ts as number } : {}) }
}
export const isFolioRestoreId = (value: unknown): value is string => typeof value === 'string' && RESTORE_ID.test(value)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !value.includes('\0')
const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * A Collection-relative posix path: no leading slash, no drive letter, no backslash, no `.` or `..`
 * segment, no empty segment, no NUL. This is what keeps a machine path out of a record.
 */
export function isRelativeRecordPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** A file name only (no folder part). */
const isPlainFileName = (value: unknown): value is string => isText(value) && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..'

function optionalText(source: Record<string, unknown>, key: string): { ok: true; value?: string } | { ok: false } {
  if (source[key] === undefined) return { ok: true }
  return isText(source[key]) ? { ok: true, value: source[key] as string } : { ok: false }
}

function parseMember(raw: unknown): FolioMember | null {
  if (!isObject(raw) || !isRelativeRecordPath(raw.path)) return null
  if (raw.role === 'reference') {
    if (!isSha256(raw.sha256) || (raw.why !== 'linked' && raw.why !== 'too-large')) return null
    return { role: 'reference', path: raw.path, sha256: raw.sha256, why: raw.why }
  }
  if (raw.role !== 'index' && raw.role !== 'part' && raw.role !== 'unlisted' && raw.role !== 'inserted') return null
  if (typeof raw.versionId !== 'string' || !PER_FILE_VERSION_ID.test(raw.versionId)) return null
  const title = optionalText(raw, 'title')
  if (!title.ok) return null
  if (raw.order !== undefined && !(typeof raw.order === 'number' && Number.isFinite(raw.order))) return null
  return {
    role: raw.role,
    path: raw.path,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(raw.order !== undefined ? { order: raw.order as number } : {}),
    versionId: raw.versionId,
  }
}

function parseIncoming(raw: unknown): FolioIncoming | null {
  if (!isObject(raw) || !isText(raw.author) || !isObject(raw.docx)) return null
  if (!isSha256(raw.docx.sha256) || !isPlainFileName(raw.docx.name)) return null
  if (!isFolioVersionId(raw.base)) return null
  if (typeof raw.converter !== 'number' || !Number.isInteger(raw.converter) || raw.converter < 0) return null
  if (!Array.isArray(raw.sections) || !Array.isArray(raw.tableNotes)) return null
  const sections: FolioIncomingSection[] = []
  for (const entry of raw.sections) {
    if (!isObject(entry) || typeof entry.heading !== 'string') return null
    if (entry.match !== 'exact' && entry.match !== 'confirmed' && entry.match !== 'new' && entry.match !== 'unmatched') return null
    if (entry.object !== undefined && !isSha256(entry.object)) return null
    if (entry.part !== undefined && !isRelativeRecordPath(entry.part)) return null
    sections.push({
      heading: entry.heading,
      ...(entry.object !== undefined ? { object: entry.object } : {}),
      match: entry.match,
      ...(entry.part !== undefined ? { part: entry.part } : {}),
    })
  }
  const tableNotes: FolioIncoming['tableNotes'] = []
  for (const entry of raw.tableNotes) {
    if (!isObject(entry) || !isRelativeRecordPath(entry.file)) return null
    if (typeof entry.cellsDiffering !== 'number' || !Number.isInteger(entry.cellsDiffering) || entry.cellsDiffering < 0) return null
    tableNotes.push({ file: entry.file, cellsDiffering: entry.cellsDiffering })
  }
  return { author: raw.author, docx: { sha256: raw.docx.sha256, name: raw.docx.name }, base: raw.base, converter: raw.converter, sections, tableNotes }
}

function parseFolioVersion(raw: Record<string, unknown>): FolioVersion | null {
  if (!isFolioVersionId(raw.id) || !isTimestamp(raw.ts) || !isText(raw.name)) return null
  const note = optionalText(raw, 'note')
  if (!note.ok) return null
  if (!isObject(raw.author) || !isText(raw.author.name)) return null
  const email = optionalText(raw.author, 'email')
  if (!email.ok) return null
  if (!isObject(raw.index) || !isRelativeRecordPath(raw.index.path)) return null
  if (typeof raw.index.versionId !== 'string' || !PER_FILE_VERSION_ID.test(raw.index.versionId)) return null
  if (!Array.isArray(raw.members)) return null
  const members: FolioMember[] = []
  for (const entry of raw.members) {
    const member = parseMember(entry)
    if (!member) return null
    members.push(member)
  }
  let incoming: FolioIncoming | undefined
  if (raw.incoming !== undefined) {
    const parsed = parseIncoming(raw.incoming)
    if (!parsed) return null
    incoming = parsed
  }
  return {
    kind: 'folio-version',
    id: raw.id,
    ts: raw.ts,
    name: raw.name,
    ...(note.value !== undefined ? { note: note.value } : {}),
    author: { name: raw.author.name, ...(email.value !== undefined ? { email: email.value } : {}) },
    index: { path: raw.index.path, versionId: raw.index.versionId },
    members,
    ...(incoming ? { incoming } : {}),
  }
}

function parseMark(raw: Record<string, unknown>): FolioVersionMark | null {
  if (!isFolioVersionId(raw.id) || !isTimestamp(raw.ts)) return null
  if (raw.delta !== undefined && raw.delta !== true) return null
  const name = optionalText(raw, 'name')
  if (!name.ok) return null
  if (raw.delta === true) {
    const clearsSentTo = raw.sentTo === null
    const sentTo: { ok: true; value?: string } | { ok: false } = clearsSentTo ? { ok: true } : optionalText(raw, 'sentTo')
    if (!sentTo.ok) return null
    if (raw.withdrawn !== undefined && typeof raw.withdrawn !== 'boolean') return null
    return {
      kind: 'folio-version-mark',
      id: raw.id,
      ts: raw.ts,
      delta: true,
      ...(name.value !== undefined ? { name: name.value } : {}),
      ...(clearsSentTo ? { sentTo: null } : sentTo.value !== undefined ? { sentTo: sentTo.value } : {}),
      ...(raw.withdrawn !== undefined ? { withdrawn: raw.withdrawn as boolean } : {}),
    }
  }
  const sentTo = optionalText(raw, 'sentTo')
  if (!sentTo.ok) return null
  if (raw.withdrawn !== undefined && raw.withdrawn !== true) return null
  return {
    kind: 'folio-version-mark',
    id: raw.id,
    ts: raw.ts,
    ...(name.value !== undefined ? { name: name.value } : {}),
    ...(sentTo.value !== undefined ? { sentTo: sentTo.value } : {}),
    ...(raw.withdrawn === true ? { withdrawn: true as const } : {}),
  }
}

function parseRestore(raw: Record<string, unknown>): FolioRestore | null {
  if (!isFolioRestoreId(raw.id) || !isTimestamp(raw.ts) || !isFolioVersionId(raw.from) || !isFolioVersionId(raw.safety)) return null
  if (raw.state !== 'begun' && raw.state !== 'done' && raw.state !== 'cancelled') return null
  return { kind: 'folio-restore', id: raw.id, ts: raw.ts, from: raw.from, safety: raw.safety, state: raw.state }
}

/** The canonical record for an already-parsed value, or null when it is not a well-formed record of a known kind. */
/**
 * A decision row key: `new:3`, `moved:5`, `match:2`, `removed:<a part's path label>`, or (ticket 17) `text:<her section>:<16 hex of the row's sent and
 * theirs text>:<which of the rows with those texts>`: one paragraph row of the three-text view that the writer kept as their own.
 */
export const isDecisionRow = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  if (/^(new|moved|match):\d{1,6}$/.test(value)) return true
  if (/^text:\d{1,6}:[a-f0-9]{16}:\d{1,4}$/.test(value)) return true
  return value.startsWith('removed:') && isRelativeRecordPath(value.slice('removed:'.length))
}

function parseDecision(raw: Record<string, unknown>): FolioDecision | null {
  if (!isFolioVersionId(raw.id) || !isTimestamp(raw.ts) || !isDecisionRow(raw.row)) return null
  if (!(FOLIO_DECISION_CHOICES as readonly unknown[]).includes(raw.choice)) return null
  if (raw.part !== undefined && !isRelativeRecordPath(raw.part)) return null
  if (raw.seen !== undefined && !isSha256(raw.seen)) return null
  return { kind: 'folio-decision', id: raw.id, ts: raw.ts, row: raw.row, choice: raw.choice as FolioDecisionChoice, ...(raw.part !== undefined ? { part: raw.part as string } : {}), ...(raw.seen !== undefined ? { seen: raw.seen as string } : {}) }
}

function parseDecisionIntent(raw: Record<string, unknown>): FolioDecisionIntent | null {
  if (!isFolioVersionId(raw.id) || !isTimestamp(raw.ts) || !isDecisionRow(raw.row) || !isRelativeRecordPath(raw.file) || !isSha256(raw.sha256)) return null
  return { kind: 'folio-decision-intent', id: raw.id, ts: raw.ts, row: raw.row, file: raw.file, sha256: raw.sha256 }
}

/** The canonical record of `.writeflex/folio-decisions.jsonl` for an already-parsed value, or null when it is not a well-formed record of a known kind. */
export function parseFolioDecisionRecord(value: unknown): FolioDecisionRecord | null {
  if (!isObject(value)) return null
  switch (value.kind) {
    case 'folio-decision': return parseDecision(value)
    case 'folio-decision-intent': return parseDecisionIntent(value)
    default: return null
  }
}

/** One line of the decisions file. A blank, torn, unparseable or malformed line, or a line of an unknown kind, is null: it has no authority. */
export function parseFolioDecisionLine(line: string): FolioDecisionRecord | null {
  if (line.trim() === '') return null
  try { return parseFolioDecisionRecord(JSON.parse(line)) } catch { return null }
}

export function parseFolioJournalRecord(value: unknown): FolioJournalRecord | null {
  if (!isObject(value)) return null
  switch (value.kind) {
    case 'folio-version': return parseFolioVersion(value)
    case 'folio-version-mark': return parseMark(value)
    case 'folio-restore': return parseRestore(value)
    default: return null
  }
}

/** One journal line. A blank, torn, unparseable or malformed line, or a line of an unknown kind, is null: it has no authority. */
export function parseFolioJournalLine(line: string): FolioJournalRecord | null {
  if (line.trim() === '') return null
  try {
    return parseFolioJournalRecord(JSON.parse(line))
  } catch {
    return null
  }
}
