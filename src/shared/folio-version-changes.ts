/**
 * Change cues for Folio versions (ADR-0052 § Decision 1, Folio versions ticket 06). Pure: main reads the files and
 * hashes them (`src/main/folio-version-cues.ts`); the renderer draws what these functions answer. Nothing here reads
 * or writes a file.
 *
 * "Changed since version V" is a comparison of bytes, the same comparison the save makes: a member whose saved copy has
 * the SHA-256 the working file has has not changed, whatever its dates say. A member the version did not hold is new.
 */

export type MemberRole = 'index' | 'part' | 'unlisted' | 'inserted'

/** A file as the version held it. `path` is where the file is now (its history follows moves); `hash` is null when the saved copy cannot be read. */
export type SavedMember = { role: MemberRole; path: string; hash: string | null }

/** A file as it stands. `hash` is null when it is too large to compare or cannot be read; `insertedBy` lists the files whose text inserts it. */
export type WorkingMember = { role: MemberRole; path: string; hash: string | null; insertedBy?: string[] }

export type ChangedSince = {
  /** Parts of the running order whose text differs from the version, or that the version did not hold. */
  changedParts: string[]
  /** Files not in the outline that differ or are new. */
  changedUnlisted: string[]
  indexChanged: boolean
  /** Inserted files that differ or are new, with the files whose text inserts them. */
  changedInserted: Array<{ path: string; by: string[] }>
  /** The parts that carry a Binder dot: a changed part, or a part that inserts a changed file. In the order `working` gave them. */
  dotted: string[]
  /** Files that changed but have no part to carry a dot: the Index Note, files not in the outline, inserted files only they insert. */
  otherFiles: number
}

/**
 * Which parts and inserted files changed since a Folio version. A saved copy that cannot be read, or a working file too large
 * to compare, is never reported as changed: a cue that cannot be sure says nothing.
 */
export function changedSinceVersion(saved: readonly SavedMember[], working: readonly WorkingMember[]): ChangedSince {
  const byPath = new Map(saved.map((member) => [member.path, member]))
  const changed = (member: WorkingMember): boolean => {
    const before = byPath.get(member.path)
    if (before === undefined) return true
    if (before.hash === null || member.hash === null) return false
    return before.hash !== member.hash
  }
  const changedParts: string[] = []
  const changedUnlisted: string[] = []
  let indexChanged = false
  const changedInserted: ChangedSince['changedInserted'] = []
  for (const member of working) {
    // A file is new only if it is a content file of this Folio; an index with no saved counterpart is the version's own index moving, not a change to report.
    if (member.role === 'index') { if (byPath.has(member.path) && changed(member)) indexChanged = true; continue }
    if (!changed(member)) continue
    if (member.role === 'part') changedParts.push(member.path)
    else if (member.role === 'unlisted') changedUnlisted.push(member.path)
    else changedInserted.push({ path: member.path, by: member.insertedBy ?? [] })
  }
  const partPaths = new Set(working.filter((member) => member.role === 'part').map((member) => member.path))
  const dottedSet = new Set(changedParts)
  let orphanInserted = 0
  for (const file of changedInserted) {
    const owners = file.by.filter((path) => partPaths.has(path))
    for (const owner of owners) dottedSet.add(owner)
    if (owners.length === 0) orphanInserted += 1
  }
  const dotted = working.filter((member) => member.role === 'part' && dottedSet.has(member.path)).map((member) => member.path)
  return { changedParts, changedUnlisted, indexChanged, changedInserted, dotted, otherFiles: changedUnlisted.length + (indexChanged ? 1 : 0) + orphanInserted }
}

// ---- What the cues say ----------------------------------------------------------------------

/** What the renderer is told about a Folio: null-like `none` when there is nothing to cue (not a Folio, or no Folio version yet). */
export type FolioCues =
  | { state: 'none' }
  | {
    state: 'ready'
    dir: string
    /** The version the cues compare against: the newest of the writer's own versions (not a withdrawn one, not a co-author's revision). */
    since: { id: string; name: string; ts: number }
    /** Binder dots: the parts that changed, or insert a file that changed. */
    dotted: string[]
    changedParts: string[]
    changedInserted: Array<{ path: string; by: string[] }>
    otherFiles: number
  }

export function cuesFrom(dir: string, since: { id: string; name: string; ts: number }, change: ChangedSince): FolioCues {
  return { state: 'ready', dir, since, dotted: change.dotted, changedParts: change.changedParts, changedInserted: change.changedInserted, otherFiles: change.otherFiles }
}

const noun = (count: number, one: string, many: string): string => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`

/** How many things the status-bar chip counts. 0 means no change: the chip is green. */
export function cueTotal(cues: Extract<FolioCues, { state: 'ready' }>): number {
  return cues.dotted.length + cues.otherFiles
}

/** What changed, counted: "2 parts", "1 part and 1 file", "1 file"; null when nothing did. */
export function changeCountText(cues: Extract<FolioCues, { state: 'ready' }>): string | null {
  const parts = cues.dotted.length
  const files = cues.otherFiles
  if (parts + files === 0) return null
  return parts > 0 && files > 0 ? `${noun(parts, 'part', 'parts')} and ${noun(files, 'file', 'files')}` : parts > 0 ? noun(parts, 'part', 'parts') : noun(files, 'file', 'files')
}

/** The status-bar chip: "2 parts changed since “After pilot numbers”"; with none, "No changes since “After pilot numbers”". */
export function cueChipText(cues: Extract<FolioCues, { state: 'ready' }>): string {
  const what = changeCountText(cues)
  const name = `“${cues.since.name}”`
  return what === null ? `No changes since ${name}` : `${what} changed since ${name}`
}

/** The working draft's line in the Versions tab: "2 parts changed since the last version". */
export function draftChangeText(cues: Extract<FolioCues, { state: 'ready' }>): string {
  const what = changeCountText(cues)
  return what === null ? 'No changes since the last version' : `${what} changed since the last version`
}

/** The text a screen reader gets for a Binder dot (the dot itself carries no words). */
export function dotLabel(cues: Extract<FolioCues, { state: 'ready' }>, path: string): string {
  const own = cues.changedParts.includes(path)
  const inserted = cues.changedInserted.filter((file) => file.by.includes(path)).map((file) => file.path.split('/').pop() ?? file.path)
  const what = own && inserted.length > 0 ? `its text and ${inserted.join(', ')} changed` : own ? 'its text changed' : `${inserted.join(', ')} changed`
  return `Changed since “${cues.since.name}”: ${what}`
}

// ---- A part's and an inserted file's own facts -----------------------------------------------

export type PartHistoryEntry = { id: string; name: string; ts: number; fileVersionId: string }

/**
 * Of the Folio versions that held a part (newest first, each with the per-file version it pointed at): how many held it, and
 * the newest one in which its text was different from the version before (or the first to hold it).
 */
export function partHistory(entries: readonly PartHistoryEntry[]): { count: number; lastChanged: { id: string; name: string; ts: number } | null } {
  const oldestFirst = [...entries].reverse()
  let lastChanged: PartHistoryEntry | null = null
  let previous: string | null = null
  for (const entry of oldestFirst) {
    if (entry.fileVersionId !== previous) lastChanged = entry
    previous = entry.fileVersionId
  }
  return { count: entries.length, lastChanged: lastChanged ? { id: lastChanged.id, name: lastChanged.name, ts: lastChanged.ts } : null }
}

/**
 * How many places the text changed between two versions of a part: each run of paragraphs added, removed or reworded counts
 * once. A paragraph is a run of lines between blank lines; spacing inside it is not a change.
 */
export function countChanges(before: string, after: string): number {
  const blocks = (text: string): string[] => text.split(/\n[ \t]*\n/).map((block) => block.replace(/\s+/g, ' ').trim()).filter((block) => block !== '')
  const a = blocks(before)
  const b = blocks(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  if (x.length === 0 && y.length === 0) return 0
  if (x.length === 0 || y.length === 0) return 1
  // A longest common subsequence of the middle, so a moved-in-place paragraph is one change and an untouched one in between stays untouched.
  if (x.length * y.length > 4_000_000) return Math.max(x.length, y.length)
  const table: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i -= 1) for (let j = y.length - 1; j >= 0; j -= 1) table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  let changes = 0
  let i = 0
  let j = 0
  let inRun = false
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { inRun = false; i += 1; j += 1; continue }
    if (!inRun) { changes += 1; inRun = true }
    if (j >= y.length || (i < x.length && table[i + 1]![j]! >= table[i]![j + 1]!)) i += 1
    else j += 1
  }
  return changes
}

/** Rows of cells from comma- or tab-separated text, with quoted cells. Enough to count differing cells; not a general reader. */
function cells(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const body = text.replace(/^﻿/, '')
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]!
    if (quoted) {
      if (char === '"') { if (body[at + 1] === '"') { cell += '"'; at += 1 } else quoted = false } else cell += char
    } else if (char === '"' && cell === '') quoted = true
    else if (char === delimiter) { row.push(cell); cell = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[at + 1] === '\n') at += 1
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += char
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

export const tableCells = cells

/** How many cells differ between two versions of a table: a changed cell counts once, as does each cell of a row or column added or removed. */
export function cellsDiffering(before: string, after: string, path: string): number {
  const delimiter = /\.tsv$/i.test(path) ? '\t' : ','
  const a = cells(before, delimiter)
  const b = cells(after, delimiter)
  let count = 0
  for (let r = 0; r < Math.max(a.length, b.length); r += 1) {
    const x = a[r] ?? []
    const y = b[r] ?? []
    for (let c = 0; c < Math.max(x.length, y.length); c += 1) if (x[c] !== y[c]) count += 1
  }
  return count
}

// ---- The inserted file under the cursor -----------------------------------------------------

const IMAGE_EMBED = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/
const WIDGET_LINE = /^\s*\[[A-Za-z][A-Za-z ]*:\s*([^\]\s][^\]]*?)\s*\]\s*$/

function embedIn(line: string): string | null {
  const image = IMAGE_EMBED.exec(line)
  if (image) return image[1] ?? null
  const widget = WIDGET_LINE.exec(line)
  return widget ? widget[1] ?? null : null
}

/**
 * The file the cursor is on, as written in the text (an image or embed, or a widget line); null when it is on none. The cursor is
 * on an embed when it is on its line, or when it is on a blank line right beside one: the editor draws an embed as one block and
 * the arrow keys step over it, leaving the cursor at its edge.
 */
export function embedOnLine(text: string, head: number): string | null {
  const at = Math.min(Math.max(0, head), text.length)
  const lines = text.split('\n')
  let from = 0
  let index = 0
  while (index < lines.length - 1 && from + lines[index]!.length < at) { from += lines[index]!.length + 1; index += 1 }
  const own = embedIn(lines[index] ?? '')
  if (own !== null) return own
  if ((lines[index] ?? '').trim() !== '') return null
  return embedIn(lines[index + 1] ?? '') ?? embedIn(lines[index - 1] ?? '')
}

export type InsertedKind = 'table' | 'image' | 'widget' | 'file'
export function insertedKind(path: string): InsertedKind {
  return /\.(csv|tsv)$/i.test(path) ? 'table' : /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path) ? 'image' : /\.html?$/i.test(path) ? 'widget' : 'file'
}

// ---- The panel that follows the cursor (answers from main) -----------------------------------

export type CursorPartFacts = {
  path: string
  title: string
  /** How many Folio versions held this part, and the newest in which its text differed from the one before. */
  versionCount: number
  lastChanged: { name: string; ts: number } | null
  /** Places the text changed since the version the cues compare against; null when that version did not hold the part (it is new) or its saved copy cannot be read. */
  changesSince: number | null
  /** The part's newest per-file version, for Compare with last version; null when it has none yet. */
  latestFileVersion: { id: string; name: string; ts: number } | null
}

export type CursorInsertedUse = { number: number; name: string; ts: number; usedBy: Array<{ id: string; name: string }> }

export type CursorInsertedFacts = {
  path: string
  kind: InsertedKind
  /** `new`: the version the cues compare against did not insert it; `unknown`: it cannot be compared (too large, or a saved copy missing). */
  state: 'unchanged' | 'changed' | 'new' | 'unknown'
  /** For a table: cells that differ from the copy the latest version used. */
  cellsChanged: number | null
  /** The per-file version the latest version used, as "v2". */
  latest: { number: number; name: string; id: string } | null
  /** Each per-file version the Folio versions used, newest first, with the Folio versions that used it. */
  uses: CursorInsertedUse[]
}

export type FolioCursorFacts = {
  since: { id: string; name: string; ts: number }
  part: CursorPartFacts | null
  inserted: CursorInsertedFacts | null
}

/** "In 4 Folio versions, last changed 19 Oct (“After pilot numbers”)." Dates are the caller's, as `versionWhen` makes them. */
export function partSentence(part: Pick<CursorPartFacts, 'versionCount' | 'lastChanged'>, when: (ts: number) => string): string {
  if (part.versionCount === 0) return 'Not in any Folio version yet.'
  const count = `In ${noun(part.versionCount, 'Folio version', 'Folio versions')}`
  return part.lastChanged ? `${count}, last changed ${when(part.lastChanged.ts)} (“${part.lastChanged.name}”).` : `${count}.`
}

/** "2 changes since that version", "No changes since that version", "New since that version". */
export function changesSentence(part: Pick<CursorPartFacts, 'changesSince'>): string {
  if (part.changesSince === null) return 'New since that version.'
  return part.changesSince === 0 ? 'No changes since that version.' : `${noun(part.changesSince, 'change', 'changes')} since that version.`
}

/** "Working copy has 3 cells changed since v2." */
export function insertedStateSentence(file: CursorInsertedFacts): string {
  const since = file.latest ? `v${file.latest.number}` : 'that version'
  if (file.state === 'new') return 'Not in the last Folio version.'
  if (file.state === 'unknown') return 'Cannot be compared with the last Folio version.'
  if (file.state === 'unchanged') return `Working copy is the same as ${since}.`
  if (file.kind === 'table' && file.cellsChanged !== null) return `Working copy has ${noun(file.cellsChanged, 'cell', 'cells')} changed since ${since}.`
  return `Working copy has changed since ${since}.`
}

/** "v2 used by “After pilot numbers” · v1 used by 3 versions". */
export function usesSentence(uses: readonly CursorInsertedUse[]): string {
  return uses.map((use) => `v${use.number} used by ${use.usedBy.length === 1 ? `“${use.usedBy[0]!.name}”` : noun(use.usedBy.length, 'version', 'versions')}`).join(' · ')
}
