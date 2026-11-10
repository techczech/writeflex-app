/**
 * Stage a co-author's changes as suggestions in the parts, and take them back (ADR-0052 § The eight changes 5 and 8, § Agent verbs;
 * journeys J3 and J6; Folio versions ticket 15). Electron-free: the stores and the window's binding are passed in.
 *
 * WHAT STAGING WRITES. One batch of ledger records (`ChangeStore.addMany`: one write of `.writeflex/changes.jsonl`, all or none), and
 * nothing else. NO PART FILE IS WRITTEN, MOVED OR DELETED, and no version is saved here: each staged change is an ordinary proposal in
 * the part's margin that changes the part only when the writer accepts it, by the one Accept every proposal has (it takes a restore
 * point first and writes through the guarded door over exactly the text it read). A staged change carries her name as its author and the
 * marker in shared/folio-version-stage.ts; the margin names her.
 *
 * WHICH CHANGES. Her tracked changes, paragraph by paragraph (a paragraph she changed becomes one proposal: the paragraph as it was
 * sent, replaced by her paragraph; a paragraph she added is placed after the paragraph before it; one she removed is replaced by
 * nothing). A file with no tracked changes at all is a revised copy, so her section is compared with the BASE version's part,
 * paragraph by paragraph, and each differing stretch is one proposal. Either way the text a proposal replaces is located in the part as it
 * stands NOW as WHOLE PARAGRAPHS, and a stretch that is not there exactly once as whole paragraphs (the writer has edited it since, has grown
 * it into a longer paragraph, or it repeats) is NOT STAGED and reported: it is the three-text view's to decide, never guessed at. A staged
 * proposal keeps the text around its paragraph (`anchorContext`), and Accept places it by that and refuses, writing nothing, when the
 * same paragraph with the same neighbours is not where it was recorded (recorded-placement.ts `placeStagedChange`): the text standing once
 * somewhere else, say a paragraph the writer rewrote and pasted elsewhere as a quotation, is never the place. Whether a stretch is in the text is structure (exact text); nothing
 * here judges meaning.
 *
 * WHOLE OR NOTHING. The plan is made and every record checked before the ledger is written; too many changes, or a record the ledger
 * would refuse, stages nothing. The read of the parts, the plan and the write are one turn of the Collection's write turn, and the
 * window's binding to the Collection is asked again immediately before the write.
 *
 * Staging the writer's own import and an agent's is one function; the only difference is who brought it in, which the ledger record
 * does not carry (it names her), and the Folio version's author does.
 *
 * judgement-vs-code: which part a section belongs to is meaning-sensitive and is settled before this runs (folio-version-match.ts).
 * This file only places text that is already matched, by exact string, and refuses what it cannot place.
 */
import type { Change, NewChange } from '../engine'
import { bodyForReading } from '../shared/folio-versions-view'
import { baseOrder, deriveStructure } from '../shared/folio-version-decide'
import { squashParagraph } from '../shared/folio-version-align'
import {
  NOT_STAGED_WORDS, STAGE_MAX_CHANGES, STAGE_MAX_TEXT_BYTES, WITHDRAWN_REASON, alreadyWaitingText, folioRevisionOf, tooManyChangesText,
  type FolioRevisionMarker, type NotStaged, type NotStagedReason, type RevisionStatus, type StageOutcome, type StagedEntry,
} from '../shared/folio-version-stage'
import { closedReasonOf, undecided, type AnchorContext, type ChangeStore } from './changes'
import { findFolioVersion, readTextMembersAtVersion, type VersionReaderSources } from './folio-version-reader'
import type { FolioVersionStore } from './folio-versions'
import type { SectionMatchResult } from './folio-version-match'
import { markdownBlocks } from './markdown-blocks'
import { unplaceableIn } from './outside-change'
import { isWholeParagraphSpan, stagedContextAround } from './recorded-placement'
import type { Workspace } from './workspace'
import type { WordParagraph, WordReading } from './word-reader'

/** Staging or withdrawing was refused, with a sentence. Nothing was written. */
export class StageRefused extends Error {
  override readonly name = 'StageRefused'
  constructor(readonly code: 'already-waiting' | 'too-many-changes' | 'not-found' | 'not-a-revision' | 'already-withdrawn' | 'staging-failed', message: string) { super(message) }
}

export type StageDeps = {
  workspace: Pick<Workspace, 'exclusiveAll'>
  changes: Pick<ChangeStore, 'list' | 'get' | 'addMany' | 'closeMany'>
  folioVersions: Pick<FolioVersionStore, 'get' | 'list' | 'mark'>
  /** The part's bytes as they stand on disk now (the guarded reader); null when the file is not there or is not an ordinary file. */
  readWorking: (path: string) => Promise<Buffer | null>
  /** Throws when the window no longer holds the Collection it held when the request began. Asked before the write and before every step of a withdraw. */
  confirmOwner: () => Promise<void>
}

// ---- Placing paragraphs -----------------------------------------------------------------------

export { markdownBlocks }

export type Hunk = { kind: 'replace' | 'insert' | 'delete'; old: string; neu: string; /** An insert is placed after this text. */ after?: string; tracked: number }

const BLANK_LINES = /\n[ \t]*\n(?:[ \t]*\n)*/g
/** The one equality of two paragraphs (shared with the three texts' alignment): NFC and collapsed white space, never the compatibility forms. */
const squash = squashParagraph

/** The paragraph-level difference of two paragraph lists: the runs that differ, as old-run → new-run, by longest common subsequence of squashed text. Null when the product is too large. */
function paragraphDiff(a: string[], b: string[]): Array<{ aFrom: number; aTo: number; bFrom: number; bTo: number }> | null {
  if (a.length * b.length > 4_000_000) return null
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const runs: Array<{ aFrom: number; aTo: number; bFrom: number; bTo: number }> = []
  let i = 0
  let j = 0
  let open: { aFrom: number; bFrom: number } | null = null
  const flush = (): void => { if (open) { runs.push({ aFrom: open.aFrom, aTo: i, bFrom: open.bFrom, bTo: j }); open = null } }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i += 1; j += 1; continue }
    open ??= { aFrom: i, bFrom: j }
    if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) j += 1
    else i += 1
  }
  flush()
  return runs
}

type SectionHunks = { hunks: Hunk[]; tooLong: boolean }

/**
 * Her tracked changes in one section: one hunk per RUN of consecutive changed paragraphs. A run is the unit because changes that touch each
 * other cannot be decided apart (accepting her new paragraph needs the paragraph before it to be there as she left it): the paragraphs of the
 * run as they were sent become one proposal that replaces them with her paragraphs. A run that only adds is placed after the unchanged
 * paragraph before it; one that only removes is replaced by nothing.
 */
function trackedHunks(blocks: WordReading['sections'][number]['blocks']): SectionHunks {
  const hunks: Hunk[] = []
  let previous: string | undefined
  let open: { originals: string[]; revised: string[]; tracked: number; after: string | undefined } | null = null
  const flush = (): void => {
    if (!open) return
    const old = open.originals.join('\n\n')
    const neu = open.revised.join('\n\n')
    hunks.push(old === '' ? { kind: 'insert', old, neu, ...(open.after !== undefined ? { after: open.after } : {}), tracked: open.tracked } : { kind: neu === '' ? 'delete' : 'replace', old, neu, tracked: open.tracked })
    open = null
  }
  for (const block of blocks) {
    if (block.type !== 'paragraph') { flush(); previous = undefined; continue }
    const p: WordParagraph = block
    if (p.changes.length > 0 && p.original !== p.revised) {
      open ??= { originals: [], revised: [], tracked: 0, after: previous }
      if (p.original !== '') open.originals.push(p.original)
      if (p.revised !== '') open.revised.push(p.revised)
      open.tracked += p.changes.length
      continue
    }
    flush()
    previous = p.original === '' ? undefined : p.original
  }
  flush()
  return { hunks, tooLong: false }
}

/** No tracked changes in her file: her section against the base version's part, paragraph by paragraph. */
function differenceHunks(baseBody: string, her: string): SectionHunks {
  const base = markdownBlocks(baseBody)
  const hers = markdownBlocks(her)
  const diff = paragraphDiff(base.map((block) => squash(block.text)), hers.map((block) => squash(block.text)))
  if (diff === null) return { hunks: [], tooLong: true }
  const hunks: Hunk[] = []
  for (const run of diff) {
    const old = run.aFrom < run.aTo ? baseBody.slice(base[run.aFrom]!.from, base[run.aTo - 1]!.to) : ''
    const neu = run.bFrom < run.bTo ? her.slice(hers[run.bFrom]!.from, hers[run.bTo - 1]!.to) : ''
    if (old === '' && neu === '') continue
    if (old === '') hunks.push({ kind: 'insert', old, neu, ...(run.aFrom > 0 ? { after: base[run.aFrom - 1]!.text } : {}), tracked: 0 })
    else hunks.push({ kind: neu === '' ? 'delete' : 'replace', old, neu, tracked: 0 })
  }
  return { hunks, tooLong: false }
}

// ---- The plan ---------------------------------------------------------------------------------

/** A matched part: where it was in the base version (its label), where it is now, and what the base held. */
export type PlanPart = { label: string; title: string; path: string | null; baseText: string | null }

export type StagePlanInput = {
  reading: Pick<WordReading, 'sections' | 'changes'>
  matched: Pick<SectionMatchResult, 'items'>
  from: string
  revisionId: string
  /** The first 12 hex characters of her file's SHA-256. */
  file: string
  /** Matched parts by their base label. */
  parts: ReadonlyMap<string, PlanPart>
  readWorking: StageDeps['readWorking']
  /** Lower limits, for tests; production passes none. */
  limits?: { maxChanges?: number; maxTextBytes?: number }
}

export type StagePlan = {
  changes: NewChange[]
  entries: Array<Omit<StagedEntry, 'id'>>
  notStaged: NotStaged[]
  sectionsChanged: number
}

const clip = (text: string, length = 70): string => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > length ? `${one.slice(0, length - 1)}…` : one }

/**
 * The changes to stage for every section that matched a part exactly or by confirmation, from the parts as they stand now. Reads the parts
 * (nothing else), writes nothing, throws `StageRefused` only for a plan too large to stage. A stretch that cannot be placed is in `notStaged`.
 */
export async function planStaging(input: StagePlanInput): Promise<StagePlan> {
  const changes: NewChange[] = []
  const entries: StagePlan['entries'] = []
  const notStaged: NotStaged[] = []
  let sectionsChanged = 0
  let bytes = 0
  const tracked = input.reading.changes.length > 0
  const texts = new Map<string, string | null>()
  const working = async (path: string): Promise<string | null> => {
    if (!texts.has(path)) { const read = await input.readWorking(path); texts.set(path, read === null ? null : read.toString('utf8')) }
    return texts.get(path) ?? null
  }

  for (const item of input.matched.items) {
    if (item.status !== 'exact' && item.status !== 'confirmed') continue
    const section = input.reading.sections[item.section.index]
    const part = input.parts.get(item.part.path)
    if (!section || !part) continue
    const heading = (section.heading ?? '').slice(0, 500)
    const skip = (reason: NotStagedReason): void => { notStaged.push({ section: item.section.index, heading, part: part.path ?? part.label, reason, why: NOT_STAGED_WORDS[reason] }) }

    const found: SectionHunks = tracked
      ? trackedHunks(section.blocks)
      : (() => {
          const baseBody = part.baseText === null ? null : bodyBelowTitle(part.baseText)
          return baseBody === null ? { hunks: [], tooLong: false } : differenceHunks(baseBody, section.markdown.trim())
        })()
    if (found.tooLong) { sectionsChanged += 1; skip('too-long'); continue }
    if (found.hunks.length === 0) continue
    sectionsChanged += 1
    const current = part.path === null ? null : await working(part.path)
    if (part.path === null || current === null || (!tracked && part.baseText === null)) { for (const _ of found.hunks) skip('part-gone'); continue }

    for (const hunk of found.hunks) {
      const placed = placeHunk(current, hunk)
      if ('reason' in placed) { skip(placed.reason); continue }
      const marker: FolioRevisionMarker = { revisionId: input.revisionId, reviewer: input.from, section: item.section.index, heading, tracked: hunk.tracked, file: input.file }
      const change: NewChange & { folioRevision: FolioRevisionMarker; reviewerLabel: string } & AnchorContext = {
        path: part.path, provenance: 'agent', editClass: placed.insertAfter !== undefined ? 'insert' : 'content', category: 'other',
        summary: summaryOf(hunk, part.title, input.from),
        oldText: placed.oldText, newText: placed.newText, isCorrection: false, author: { name: input.from }, reviewerLabel: input.from, folioRevision: marker,
        ...(placed.insertAfter !== undefined ? { insertAfter: placed.insertAfter } : { anchor: placed.anchor }),
        ...(placed.context ? { anchorContext: placed.context } : {}),
      }
      // The very judgement Accept places a record by: a change Accept could not place is never staged.
      const probe = { ...change, id: 'probe', ts: 0, status: 'pending' } as Change
      const unplaceable = unplaceableIn(probe, current)
      if (unplaceable) { skip(placed.insertAfter !== undefined ? 'no-place' : 'text-changed'); continue }
      bytes += Buffer.byteLength(change.oldText) + Buffer.byteLength(change.newText)
      changes.push(change)
      entries.push({ section: item.section.index, heading, part: part.path, title: part.title, kind: hunk.kind, tracked: hunk.tracked })
      if (changes.length > (input.limits?.maxChanges ?? STAGE_MAX_CHANGES) || bytes > (input.limits?.maxTextBytes ?? STAGE_MAX_TEXT_BYTES)) throw new StageRefused('too-many-changes', tooManyChangesText(changes.length))
    }
  }
  return { changes, entries, notStaged, sectionsChanged }
}

/** The part's text below its front matter and its own title line, as a section body reads. */
export function bodyBelowTitle(text: string): string {
  const body = bodyForReading(text).replace(/^\s*\n/, '')
  const lines = body.split('\n')
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first >= 0 && /^#{1,6}\s/.test(lines[first]!.trim())) lines.splice(0, first + 1)
  return lines.join('\n').trim()
}

type Context = { before: string; after: string }
export type Placed =
  | { oldText: string; newText: string; anchor: { from: number; to: number }; context?: Context; insertAfter?: undefined }
  | { oldText: ''; newText: string; insertAfter: string; context?: Context; anchor?: undefined }
  | { reason: NotStagedReason }

/** Every place `needle` stands in `text` as WHOLE paragraphs (not as part of a longer paragraph, or on one line of a quotation). */
function wholeParagraphPlaces(text: string, needle: string): number[] {
  const at: number[] = []
  if (needle === '') return at
  for (let from = text.indexOf(needle); from >= 0; from = text.indexOf(needle, from + 1)) if (isWholeParagraphSpan(text, from, from + needle.length)) at.push(from)
  return at
}

/**
 * Where in the part as it stands `hunk` goes, or why it cannot be placed. Exact text only, and only WHOLE paragraphs: the text she changed
 * must be a paragraph (or run of paragraphs) of the part just as it was sent, not a stretch inside a longer paragraph the writer has
 * since grown, and the placed change keeps the text around it (`context`) so Accept finds the same place later and never another passage
 * that happens to read the same (recorded-placement.ts `placeStagedChange`).
 */
export function placeHunk(current: string, hunk: Hunk): Placed {
  if (hunk.kind === 'insert') {
    let after = hunk.after
    if (after === undefined) {
      // Her new paragraph opens the section: it goes after the part's own title line, when the part has one.
      const lines = current.split('\n')
      const title = lines.find((line) => /^#{1,6}\s/.test(line.trim()))
      after = title !== undefined && current.trimStart().startsWith(title.trim()) ? title : undefined
    }
    if (after === undefined) return { reason: 'no-place' }
    const anchors = markdownBlocks(current).filter((block) => block.text === after)
    if (anchors.length !== 1) return { reason: 'no-place' }
    const context = stagedContextAround(current, anchors[0]!.from, anchors[0]!.to, { before: false })
    return { oldText: '', newText: hunk.neu, insertAfter: after, ...(context ? { context } : {}) }
  }
  const places = wholeParagraphPlaces(current, hunk.old)
  if (places.length !== 1) return { reason: 'text-changed' }
  const from = places[0]!
  let to = from + hunk.old.length
  let oldText = hunk.old
  if (hunk.kind === 'delete') {
    // Take the paragraph and the blank line after it (or, at the end of the part, the one before it), so no empty gap is left.
    const after = /^\r?\n(?:[ \t]*\r?\n)+/.exec(current.slice(to))
    if (after) { oldText += after[0]; to += after[0].length }
  }
  const context = stagedContextAround(current, from, to)
  return { oldText, newText: hunk.kind === 'delete' ? '' : hunk.neu, anchor: { from, to }, ...(context ? { context } : {}) }
}

export function summaryOf(hunk: Hunk, title: string, from: string): string {
  const what = hunk.kind === 'insert' ? `added “${clip(hunk.neu)}”` : hunk.kind === 'delete' ? `removed “${clip(hunk.old)}”` : `changed “${clip(hunk.old)}”`
  return `${from} ${what} in “${clip(title, 50)}”`
}

// ---- Resolving the matched parts ------------------------------------------------------------

const inFolder = (dir: string, path: string): boolean => (dir === '' ? !path.startsWith('/') : path.startsWith(`${dir}/`))

/**
 * The parts of the base version that sections matched, by their base label: where each is now (its per-file history follows a move, and a
 * part that is no Markdown file inside the Folio any more is `null`) and what the base held. `paths` are the labels that matched.
 */
export async function resolveMatchedParts(sources: VersionReaderSources, dir: string, baseId: string, labels: readonly string[], exists: (path: string) => Promise<boolean>): Promise<Map<string, PlanPart>> {
  const out = new Map<string, PlanPart>()
  const version = await findFolioVersion(sources, dir, baseId)
  const texts = await readTextMembersAtVersion(sources, dir, baseId)
  if (!version || !texts) return out
  const facts = new Map((await sources.fileVersions()).map((fileVersion) => [fileVersion.id, fileVersion]))
  for (const label of labels) {
    const member = version.members.find((candidate) => candidate.role !== 'reference' && candidate.role !== 'inserted' && candidate.path === label)
    if (!member || member.role === 'reference' || member.role === 'inserted') continue
    const now = facts.get(member.versionId)?.path ?? member.path
    const there = /\.(md|markdown|mdx)$/i.test(now) && inFolder(dir, now) && await exists(now)
    out.set(label, { label, title: member.title?.trim() || label.split('/').pop()!.replace(/\.(md|markdown|mdx)$/i, ''), path: there ? now : null, baseText: texts.find((entry) => entry.path === label)?.text ?? null })
  }
  return out
}

// ---- The write --------------------------------------------------------------------------------

export type StageResult = { outcome: StageOutcome; ids: string[] }

/**
 * File the plan in the ledger: ONE turn of the Collection's write turn from the read of the parts to the write. `make` reads the parts
 * and plans (so the plan is over the text the write is over); the window's binding is asked again right before the write. If the same
 * Word file already has undecided suggestions waiting, nothing is staged. Throws `StageRefused` (nothing written) or whatever the ledger
 * throws (nothing written: the batch is all or none).
 */
export async function stageIntoLedger(deps: StageDeps, make: () => Promise<StagePlan>, file: string, reviewer: string): Promise<StageResult> {
  return deps.workspace.exclusiveAll(async () => {
    await deps.confirmOwner()
    const waiting = (await deps.changes.list()).some((change) => undecided(change) && folioRevisionOf(change)?.file === file)
    if (waiting) throw new StageRefused('already-waiting', alreadyWaitingText(reviewer))
    const plan = await make()
    await deps.confirmOwner()
    const filed = await deps.changes.addMany(plan.changes)
    const staged: StagedEntry[] = plan.entries.map((entry, index) => ({ ...entry, id: filed[index]!.id }))
    return {
      ids: filed.map((change) => change.id),
      outcome: { changes: filed.length, parts: new Set(plan.entries.map((entry) => entry.part)).size, sectionsChanged: plan.sectionsChanged, staged, notStaged: plan.notStaged },
    }
  })
}

/** Whether staging this file would be refused as already waiting; read only (asked before anything is written, so the refusal costs no safety version). */
export async function alreadyWaiting(deps: Pick<StageDeps, 'changes'>, file: string): Promise<boolean> {
  return (await deps.changes.list()).some((change) => undecided(change) && folioRevisionOf(change)?.file === file)
}

// ---- Withdraw ---------------------------------------------------------------------------------

export type WithdrawResult = { id: string; name: string; from: string; taken: number; kept: number }

/**
 * Take back an incoming revision: every staged change of it that is still undecided is closed with the reason (the ledger's way to remove a
 * proposal that must stay on record), and the incoming Folio version is marked withdrawn. NO PART FILE IS TOUCHED, and a change the writer
 * already accepted or declined stays as decided. Under the write turn, deciding from the ledger as it is NOW: a change accepted a moment
 * ago is not closed. The binding is asked before each of the two writes. Run again after a failure between them, it finishes (idempotent).
 */
export async function withdrawRevision(deps: StageDeps, id: string): Promise<WithdrawResult> {
  return deps.workspace.exclusiveAll(async () => {
    await deps.confirmOwner()
    const version = typeof id === 'string' ? await deps.folioVersions.get(id) : null
    if (!version) throw new StageRefused('not-found', 'That is not an incoming revision of any Folio in this Collection. Nothing was changed.')
    if (!version.incoming) throw new StageRefused('not-a-revision', `“${version.name}” is a Folio version you saved, not a co-author’s revision, so it cannot be withdrawn. Nothing was changed.`)
    if (version.withdrawn) throw new StageRefused('already-withdrawn', `“${version.name}” is already withdrawn. Nothing was changed.`)
    const mine = (await deps.changes.list()).filter((change) => folioRevisionOf(change)?.revisionId === id)
    const open = mine.filter(undecided)
    // Taken back earlier by an attempt that stopped before the mark: still this withdrawal's, and counted as such.
    const earlier = mine.filter((change) => !undecided(change) && closedReasonOf(change) === WITHDRAWN_REASON(version.name)).length
    await deps.confirmOwner()
    const closed = open.length === 0 ? [] : await deps.changes.closeMany(open.map((change) => ({ id: change.id, reason: WITHDRAWN_REASON(version.name), code: 'other' as const })))
    await deps.confirmOwner()
    await deps.folioVersions.mark(id, { withdrawn: true })
    const taken = closed.length + earlier
    return { id, name: version.name, from: version.incoming.author, taken, kept: mine.length - taken }
  })
}

// ---- The Versions tab ---------------------------------------------------------------------------

/**
 * The incoming revisions of the Folio whose Index Note is `indexPath`, newest first, with what the ledger says about their staged changes
 * now. Reads only. A withdrawn revision is listed (flagged) so the tab can say so.
 */
export async function readRevisionStatuses(deps: { changes: Pick<ChangeStore, 'list'>; folioVersions: Pick<FolioVersionStore, 'list' | 'get' | 'listDecisions'> }, indexPath: string): Promise<RevisionStatus[]> {
  const all = await deps.folioVersions.list(indexPath)
  const versions = all.filter((version) => version.incoming !== undefined)
  if (versions.length === 0) return []
  const ledger = await deps.changes.list()
  const out: RevisionStatus[] = []
  for (const version of versions) {
    const incoming = version.incoming!
    // The structure decisions (ticket 16): derived from the records alone, the same rows the decide step lists.
    const base = all.find((entry) => entry.id === incoming.base) ?? await deps.folioVersions.get(incoming.base)
    const structure = base ? deriveStructure(incoming, baseOrder(base.members), await deps.folioVersions.listDecisions(version.id)) : null
    out.push(statusOf(version, ledger, structure))
  }
  return out
}

function statusOf(version: Awaited<ReturnType<FolioVersionStore['list']>>[number], ledger: Awaited<ReturnType<ChangeStore['list']>>, derived: ReturnType<typeof deriveStructure> | null): RevisionStatus {
    const incoming = version.incoming!
    const mine = ledger.filter((change) => folioRevisionOf(change)?.revisionId === version.id)
    const waiting = new Map<string, number>()
    for (const change of mine) if (undecided(change)) waiting.set(change.path, (waiting.get(change.path) ?? 0) + 1)
    return {
      id: version.id, name: version.name, ts: version.ts, from: incoming.author, by: version.author.name !== incoming.author ? version.author.name : null,
      file: incoming.docx.name, withdrawn: version.withdrawn === true,
      staged: mine.length, decided: mine.filter((change) => !undecided(change)).length,
      waitingParts: [...waiting].map(([path, count]) => ({ path, waiting: count })),
      newSections: incoming.sections.filter((section) => section.match === 'new').length,
      needsYou: derived === null ? incoming.sections.filter((section) => section.match === 'unmatched').length : derived.matches.filter((match) => match.choice === undefined).length,
      ...(derived !== null ? { structure: { total: derived.rows.length, decided: derived.rows.filter((row) => row.choice !== undefined).length } } : {}),
    }
}
