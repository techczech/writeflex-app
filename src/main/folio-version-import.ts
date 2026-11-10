/**
 * Import a co-author's Word revision, steps 1 and 2 (ADR-0052 § Records `incoming`, § Rules that must hold; Folio versions
 * ticket 14; journey J3). Electron-free: the file dialog and the window are the app's (folio-version-import-ipc.ts).
 *
 * TWO OPERATIONS, ONE WRITER.
 *  - `prepareImport` READS and WRITES NOTHING. It reads her file (a bounded read), runs the Word reader on the bytes (the reader's
 *    limits hold: it refuses a huge file, a zip bomb, an unsafe part name, DOCTYPE or entity XML), reads the base version's parts
 *    through the shared reader, and matches her sections to them (`matchSections`). The answer is what step 2 shows.
 *  - `commitImport` is the only writer, and it runs only on the writer's "Bring changes into the Folio". It does everything over
 *    again from the file's bytes (nothing the window said is trusted: a folder, a base, a decision, a name are all checked here, and
 *    the file must still be the bytes the writer saw, by SHA-256), then writes in this order and nothing else:
 *      1. the safety version "Before importing <name>’s revision", through the app's own Folio save (`deps.save`). If it cannot be
 *         saved NOTHING ELSE IS WRITTEN. The save settles no changes: the writer's own waiting changes make it refuse
 *         (`version-unsettled`), which the import reports in a sentence.
 *      2. her `.docx` and each section of hers converted to Markdown, as content-addressed objects (`FolioVersionStore.putObject`:
 *         written once, never rewritten, checked against their name on read).
 *      3. ONE `folio-version` record carrying `incoming` (`FolioVersionStore.append`). Its Index Note and members are the safety
 *         version's: the incoming version records what she SENT, and points at the per-file versions that already exist, so no
 *         per-file version is written for it.
 *    No part file is written, moved or deleted; the Folio folder keeps its one Index Note; no change is staged in any part.
 *    Whether the record is a well-formed one is settled BEFORE step 1 (a dry parse of the record, with the base's members standing in
 *    for the safety version's), so a record the store would refuse never costs the writer a safety version.
 *
 * JUDGEMENT. Matching headings is meaning-sensitive. Code settles one thing only (the same heading after Unicode normalisation) and
 * every looser match is a PROPOSAL (folio-version-match.ts). Here the writer decides every close match and every ambiguous section:
 * the commit refuses (`needs-decision`) while any is open, so nothing is ever decided for the writer by a stand-in or a model.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseFolioJournalRecord, type FolioIncomingSection, type FolioMember, type FolioVersion } from '../shared/folio-version-records'
import {
  CONFIDENCE_WORDS, IMPORT_MAX_DOCX_BYTES, IMPORT_MAX_HEADING, IMPORT_MAX_RESOLUTIONS, IMPORT_MAX_SECTIONS, defaultImportBase, fromProblem, incomingVersionName, latestBaseNote, needsLine, normaliseFrom,
  FILE_CHANGED_MESSAGE, safetyVersionName, type ImportBases, type ImportCommitAnswer, type ImportCommitRequest, type ImportDone, type ImportPartOption, type ImportPrepareAnswer, type ImportPrepared, type ImportRefusalCode, type ImportRefused, type ImportRequest,
} from '../shared/folio-version-import'
import { partsChangedSince } from '../shared/folio-version-export'
import { COMPARE_WORKING } from '../shared/folio-version-compare'
import { bodyForReading } from '../shared/folio-versions-view'
import { indexNotePath } from './folio'
import { folioDeclaration } from './folio-declaration'
import { compareFolioVersions, type FolioCompareSources } from './folio-version-compare'
import { matchSections, type BasePart, type MatchResolution, type SectionMatchResult } from './folio-version-match'
import { readTextMembersAtVersion, type VersionReaderSources } from './folio-version-reader'
import { newFolioVersionId, type FolioVersionStore, type ListedFolioVersion } from './folio-versions'
import { alreadyWaiting, planStaging, resolveMatchedParts, stageIntoLedger, StageRefused, type StageDeps } from './folio-version-stage'
import { alreadyWaitingText, stagedLine, type MatchRow, type RevisionReport, type StageOutcome } from '../shared/folio-version-stage'
import { VersionSaveRefused } from './saved-text-version'
import { readWordFile, type WordReading } from './word-reader'
import type { Workspace } from './workspace'

export type ImportDeps = {
  workspace: Workspace
  folioVersions: Pick<FolioVersionStore, 'list' | 'append' | 'putObject' | 'get' | 'mark'>
  /** The change ledger her changes are staged in (ticket 15): one batch write, all or none. */
  changes: StageDeps['changes']
  /** A part's bytes as they stand on disk now, through the guarded reader; null when the file is not there. */
  readWorking: StageDeps['readWorking']
  reader: VersionReaderSources
  /** For "N parts changed since then". Absent: that line is left out. */
  compare?: FolioCompareSources
  /** Whether the writer has own changes waiting in the Folio (the save would have to settle them) and how many versions the Folio has: the sheet's facts. */
  sheetFacts: (dir: string) => Promise<{ refused?: string; waiting: Array<{ path: string; own: number }>; versionCount: number }>
  /** The app's Folio save, settling nothing (`requestedFolioVersionSave`). Throws `VersionSaveRefused` when it refuses. */
  save: (input: { dir: string; name: string }) => Promise<{ record: FolioVersion }>
  /**
   * Asked before EVERY write (the safety save, her Word file, each section object, the record): throws when the window no longer holds
   * this Collection (closed, or switched to another). Required, so a caller cannot forget it; the import captures nothing itself, the
   * caller binds it to the window when it builds the deps, at the start of the request (`windowOwner`).
   */
  confirmOwner: () => Promise<void>
  /** Overrides of the reader's limits, for tests; production passes none (a Word file the import reads is at most 25 MiB). */
  readerLimits?: Parameters<typeof readWordFile>[1]
  /** Lower limits on what one revision may stage, for tests; production passes none. */
  stageLimits?: { maxChanges?: number; maxTextBytes?: number }
}

/** The binding check for a window: `live` says whether the window still holds the Collection it held when the import began. */
export const windowOwner = (live: () => boolean): (() => Promise<void>) => async () => { if (!live()) throw new CollectionClosed() }

export class CollectionClosed extends Error {
  constructor() { super('WriteFlex no longer has this Collection open in that window.') }
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const refused = (code: ImportRefusalCode, message: string, nothingWritten = true): ImportRefused => ({ status: 'refused', code, message, nothingWritten })

// ---- Reading the file -----------------------------------------------------------------------

export type RevisionFile = { name: string; bytes: Buffer }

/**
 * Read the file the writer chose: an ordinary file, at most `maxBytes`, read through one handle whose size is judged before a byte is
 * read and again after (a file that grows while it is read is refused). Returns the sentence why not. It never opens a folder, a pipe or
 * a device, and it never reads more than the cap into memory. The bytes are untrusted: only the Word reader sees them.
 */
export async function readRevisionFile(path: string, maxBytes: number = IMPORT_MAX_DOCX_BYTES): Promise<RevisionFile | { refused: ImportRefused }> {
  const unreadable = (message: string): { refused: ImportRefused } => ({ refused: refused('unreadable-file', message) })
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    return unreadable('WriteFlex could not open that file. It may have moved, or you may not be allowed to read it. Nothing was changed.')
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return unreadable('That is not an ordinary file, so WriteFlex did not open it. Nothing was changed.')
    if (info.size > maxBytes) return { refused: refused('too-large', 'This file is too large for WriteFlex to read safely. Nothing was changed.') }
    const bytes = Buffer.alloc(info.size)
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    if (read !== bytes.length) return unreadable('That file changed while WriteFlex was reading it. Nothing was changed. Try again.')
    // A file that grew while it was read is not the file the writer chose.
    const after = await handle.stat()
    if (after.size !== info.size) return unreadable('That file changed while WriteFlex was reading it. Nothing was changed. Try again.')
    return { name: basename(path), bytes }
  } catch {
    return unreadable('WriteFlex could not read that file. Nothing was changed.')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

// ---- Step 1: who, and which version she started from ------------------------------------------

const baseChoice = (version: ListedFolioVersion): ImportBases['bases'][number] => ({ id: version.id, name: version.name, ts: version.ts, ...(version.sentTo !== undefined ? { sentTo: version.sentTo } : {}) })

type Gate = { versions: ListedFolioVersion[]; bases: ListedFolioVersion[]; indexPath: string }

/** The Folio at `dir`, its versions, and the ones that can be a base; or the refusal. Writes nothing. */
async function gate(deps: ImportDeps, dir: string): Promise<Gate | ImportRefused> {
  let isFolio = false
  try { isFolio = folioDeclaration(deps.workspace, dir).isFolio } catch { isFolio = false }
  if (!isFolio) return refused('not-a-folio', 'That is not a Folio folder, so nothing was imported.')
  let indexPath: string
  let versions: ListedFolioVersion[]
  try {
    indexPath = indexNotePath(deps.workspace, dir)
    versions = await deps.folioVersions.list(indexPath)
  } catch {
    return refused('not-a-folio', 'The versions of this Folio could not be read, so nothing was imported.')
  }
  // A base is a version she could have started from: one the writer saved, not another revision of hers, not a withdrawn one.
  const bases = versions.filter((version) => version.incoming === undefined && !version.withdrawn)
  if (bases.length === 0) return refused('no-versions', 'This Folio has no saved version to compare the revision with. Save a Folio version first, then import.')
  const facts = await deps.sheetFacts(dir).catch(() => null)
  if (!facts || facts.refused) return refused('not-a-folio', facts?.refused ?? 'This Folio could not be read, so nothing was imported.')
  const waiting = facts.waiting.filter((entry) => entry.own > 0)
  if (waiting.length > 0) {
    const where = waiting.length === 1 ? 'one file' : `${waiting.length} files`
    return refused('version-unsettled', `You have changes of your own still waiting in ${where}. Save a Folio version first (it gathers them in), then import.`)
  }
  return { versions, bases, indexPath }
}

function choose(from: string, bases: ListedFolioVersion[], wanted: string | undefined): { base: ListedFolioVersion; reason: 'sent' | 'latest'; note: string | null } | ImportRefused {
  const choices = bases.map(baseChoice)
  if (wanted !== undefined) {
    const picked = bases.find((version) => version.id === wanted)
    if (!picked) return refused('bad-base', 'That is not one of this Folio’s saved versions, so nothing was imported.')
    return { base: picked, reason: picked.sentTo !== undefined ? 'sent' : 'latest', note: null }
  }
  const found = defaultImportBase(choices, from)!
  const base = bases.find((version) => version.id === found.id)!
  return { base, reason: found.reason, note: found.reason === 'latest' ? latestBaseNote(from, base.name) : null }
}

/** Step 1's facts: the versions she could have started from, the one offered, how much the text has changed since, and what the safety version is called. Writes nothing. */
export async function importBases(deps: ImportDeps, request: Pick<ImportRequest, 'dir' | 'from' | 'base'>): Promise<ImportBases | ImportRefused> {
  const problem = fromProblem(request.from)
  if (problem !== null) return refused('bad-name', `${problem} Nothing was imported.`)
  const gated = await gate(deps, request.dir)
  if ('status' in gated) return gated
  return describeBases(deps, request, gated, true)
}

/** The facts of step 1 over a Folio already judged by `gate`. `withChanged` also works out how many parts changed since the base (step 1 only: it reads the whole Folio). */
async function describeBases(deps: ImportDeps, request: Pick<ImportRequest, 'dir' | 'from' | 'base'>, gated: Gate, withChanged: boolean): Promise<ImportBases | ImportRefused> {
  const dir = request.dir
  const from = normaliseFrom(request.from)
  const picked = choose(from, gated.bases, request.base)
  if ('status' in picked) return picked
  let changedSince: number | null = null
  if (withChanged && deps.compare) {
    try { changedSince = partsChangedSince(await compareFolioVersions(deps.compare, dir, picked.base.id, COMPARE_WORKING)) } catch { changedSince = null }
  }
  return { status: 'ready', from, bases: gated.bases.map(baseChoice), baseId: picked.base.id, baseReason: picked.reason, baseNote: picked.note, changedSince, safetyName: safetyVersionName(from) }
}

// ---- Step 2: the match table ----------------------------------------------------------------

/** What a part's saved text is for matching: its body, without front matter and without the heading line that is its title. */
export function bodyForMatching(text: string): string {
  const body = bodyForReading(text).replace(/^\s*\n/, '')
  const lines = body.split(/\r?\n/)
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first >= 0 && /^#{1,6}\s/.test(lines[first].trim())) lines.splice(0, first + 1)
  return lines.join('\n').trim()
}

/** The base's parts as the matcher reads them: in running order, then the files not in the outline. A part whose saved text cannot be read is still a part (matched by title). */
async function baseParts(deps: ImportDeps, dir: string, baseId: string): Promise<BasePart[] | null> {
  const members = await readTextMembersAtVersion(deps.reader, dir, baseId)
  if (members === null) return null
  const titleOf = (member: { path: string; title?: string }): string => member.title?.trim() || basename(member.path).replace(/\.(md|markdown)$/i, '')
  const ordered = (role: 'part' | 'unlisted') => members.filter((member) => member.role === role).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
  return [...ordered('part'), ...ordered('unlisted')].map((member) => ({
    path: member.path, title: titleOf(member), role: member.role as 'part' | 'unlisted',
    ...(member.text !== null ? { markdown: bodyForMatching(member.text) } : {}),
  }))
}

/** The writer's decisions as the matcher takes them, or the refusal. Everything is checked here: a shape, a number, a part. */
function checkedResolutions(input: unknown): MatchResolution[] | ImportRefused {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > IMPORT_MAX_RESOLUTIONS) return refused('bad-request', 'That request was not understood, so nothing was imported.')
  const out: MatchResolution[] = []
  for (const entry of input) {
    const row = entry as { section?: unknown; part?: unknown } | null
    if (typeof row !== 'object' || row === null || !Number.isInteger(row.section) || (row.section as number) < 0 || (row.part !== null && (typeof row.part !== 'string' || row.part.length > 1000))) {
      return refused('bad-request', 'That request was not understood, so nothing was imported.')
    }
    out.push({ section: row.section as number, part: row.part as string | null })
  }
  return out
}

type Prepared = { answer: ImportPrepared; reading: WordReading; matched: SectionMatchResult; base: ListedFolioVersion; indexPath: string; bytes: Buffer; fileName: string }

/**
 * Everything step 2 and the commit both need, from the file's bytes. Writes nothing. Nothing here confirms a match: the writer's confirmations
 * of close matches arrive as `resolutions` from the app, and no agent route passes either (ADR-0052: the agent never confirms).
 */
async function prepared(deps: ImportDeps, request: ImportRequest, file: RevisionFile): Promise<Prepared | ImportRefused> {
  const dir = request.dir
  const resolutions = checkedResolutions(request.resolutions)
  if ('status' in resolutions) return resolutions
  const problem = fromProblem(request.from)
  if (problem !== null) return refused('bad-name', `${problem} Nothing was imported.`)
  const gated = await gate(deps, dir)
  if ('status' in gated) return gated
  const bases = await describeBases(deps, request, gated, false)
  if (bases.status === 'refused') return bases
  const base = gated.bases.find((version) => version.id === bases.baseId)!
  // The Word reader: the one place her bytes are read. It refuses with a plain sentence and no partial reading.
  const reading = readWordFile(file.bytes, { maxFileBytes: IMPORT_MAX_DOCX_BYTES, ...deps.readerLimits })
  if (!reading.ok) return refused(reading.code, `${reading.message} Nothing was changed and no version was saved.`)
  if (reading.sections.length > IMPORT_MAX_SECTIONS) {
    return refused('too-many-sections', `This file has ${reading.sections.length.toLocaleString('en-GB')} sections, more than the ${IMPORT_MAX_SECTIONS.toLocaleString('en-GB')} an import keeps. Nothing was changed and no version was saved.`)
  }
  const parts = await baseParts(deps, dir, base.id)
  if (parts === null) return refused('bad-base', 'The version the revision started from could not be read, so nothing was imported.')
  // No `judged`: the stand-in proposes, the writer decides (see the header of this file).
  const matched = matchSections(parts, reading, { resolutions })
  const needs = matched.close.length + matched.ambiguous.reduce((sum, item) => sum + item.sections.length, 0)
  const answer: ImportPrepared = {
    status: 'ready',
    file: {
      name: file.name, sha256: sha256Of(file.bytes), bytes: file.bytes.length, reviewers: reading.reviewers, changes: reading.changes.length,
      sections: reading.sections.length, tables: reading.tableCount, figures: reading.figureCount, limitations: reading.limitations,
    },
    bases,
    mechanism: matched.mechanism,
    noHeadingStyles: matched.noHeadingStyles,
    items: matched.items,
    missing: matched.missing,
    parts: parts.map((part): ImportPartOption => ({ path: part.path, title: part.title, role: part.role })),
    needs,
    unusedResolutions: matched.unusedResolutions.map((entry) => ({ section: entry.resolution.section, why: entry.why })),
    confidenceWords: CONFIDENCE_WORDS,
  }
  return { answer, reading, matched, base, indexPath: gated.indexPath, bytes: file.bytes, fileName: file.name }
}

/**
 * The file is not the bytes the writer was looking at: nothing is applied (not one of the decisions, which were made against other text),
 * and the file is read afresh with no decisions, so the window can show what is there now. Writes nothing.
 */
async function fileChanged(deps: ImportDeps, request: ImportRequest, file: RevisionFile): Promise<ImportRefused> {
  const fresh = await prepared(deps, { dir: request.dir, from: request.from, ...(request.base !== undefined ? { base: request.base } : {}) }, file)
  if ('status' in fresh) return fresh
  return { ...refused('file-changed', FILE_CHANGED_MESSAGE), prepared: fresh.answer }
}

/** The hash the writer saw, as sent: absent is fine on the first reading; present, it must be a SHA-256 and the file must still be those bytes. */
async function againstHash(deps: ImportDeps, request: ImportRequest, file: RevisionFile): Promise<ImportRefused | null> {
  if (request.fileSha256 === undefined) return null
  if (typeof request.fileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.fileSha256)) return refused('bad-request', 'That request was not understood, so nothing was imported.')
  return sha256Of(file.bytes) === request.fileSha256 ? null : fileChanged(deps, request, file)
}

/** Step 2: read her file, match it to the version she started from, and say what the writer still has to decide. Writes nothing. */
export async function prepareImport(deps: ImportDeps, request: ImportRequest, file: RevisionFile): Promise<ImportPrepareAnswer> {
  const mismatch = await againstHash(deps, request, file)
  if (mismatch !== null) return mismatch
  const result = await prepared(deps, request, file)
  return 'status' in result ? result : result.answer
}

// ---- The write ------------------------------------------------------------------------------

/** The section lines the record keeps, and the Markdown objects behind them, from the matched result. Pure. */
function incomingSections(reading: WordReading, matched: SectionMatchResult): { sections: FolioIncomingSection[]; objects: Array<{ index: number; bytes: Buffer }> } {
  const byIndex = new Map(matched.items.flatMap((item) => (item.status === 'ambiguous' ? [] : [[item.section.index, item] as const])))
  const sections: FolioIncomingSection[] = []
  const objects: Array<{ index: number; bytes: Buffer }> = []
  reading.sections.forEach((section, index) => {
    const item = byIndex.get(index)
    // The commit refuses while a section is ambiguous or a close match is open, so every section has one of these.
    const match: FolioIncomingSection['match'] = item === undefined ? 'unmatched' : item.status === 'exact' ? 'exact' : item.status === 'confirmed' ? 'confirmed' : item.status === 'new' ? 'new' : 'unmatched'
    const heading = (section.heading ?? '').length > IMPORT_MAX_HEADING ? `${(section.heading ?? '').slice(0, IMPORT_MAX_HEADING - 1)}…` : (section.heading ?? '')
    const part = item !== undefined && (item.status === 'exact' || item.status === 'confirmed') ? item.part.path : undefined
    const bytes = Buffer.from(section.markdown, 'utf8')
    if (bytes.length > 0) objects.push({ index, bytes })
    sections.push({ heading, match, ...(part !== undefined ? { part } : {}) })
  })
  return { sections, objects }
}

// ---- What the matching found, as the decide list will list it ---------------------------------

const rowOf = (item: { section: { index: number; heading: string | null } }, part?: { path: string; title: string }, extra: { confidence?: string; reason?: string } = {}): MatchRow => ({
  section: item.section.index, heading: item.section.heading, ...(part ? { part: part.path, title: part.title } : {}), ...extra,
})

/**
 * The report: each list is built from the matching, each count is the length of its list, and `decideRows` (shared) turns the lists into the
 * decide list's rows, so the verb's counts and the app's rows are one thing counted twice. Pure.
 */
export function reportOf(matched: SectionMatchResult, reading: Pick<WordReading, 'figureCount'>): RevisionReport {
  const assetNotes = [
    ...matched.tableNotes.map((note) => note.message),
    ...matched.unpairedTables.map((note) => note.message),
    ...(reading.figureCount > 0 ? [`${reading.figureCount.toLocaleString('en-GB')} ${reading.figureCount === 1 ? 'figure' : 'figures'} in her file ${reading.figureCount === 1 ? 'is' : 'are'} not brought in: pictures are never read.`] : []),
  ]
  const report: RevisionReport = {
    matched: matched.matched.map((item) => rowOf(item, item.part)),
    close: matched.close.map((item) => ({ ...rowOf(item, item.part, { ...(item.confidence ? { confidence: item.confidence } : {}), ...(item.reason ? { reason: item.reason } : {}) }), code: 'match-needs-confirmation' as const })),
    new: matched.new.map((item) => rowOf(item)),
    removed: matched.missing.map((part) => ({ part: part.path, title: part.title })),
    moved: matched.moved.map((item) => rowOf(item, item.part)),
    assetNotes,
    ambiguous: matched.ambiguous.map((item) => ({ sections: item.sections.map((section) => section.index), message: item.message, candidates: item.candidates.map((candidate) => candidate.path) })),
    counts: { matched: 0, close: 0, new: 0, removed: 0, moved: 0, assetNotes: 0, ambiguous: 0 },
  }
  report.counts = { matched: report.matched.length, close: report.close.length, new: report.new.length, removed: report.removed.length, moved: report.moved.length, assetNotes: report.assetNotes.length, ambiguous: report.ambiguous.length }
  return report
}

/** Who brought the revision in, when it is not the writer: an agent's name (the Folio version's author). */
export type ImportBy = { name: string }
export type CommitOptions = {
  /** An agent's import: what is settled is staged, what the writer must still decide (close matches, ambiguous sections) is left. An agent confirms nothing. */
  agent?: { by: ImportBy }
}

/**
 * "Bring changes into the Folio": the one writer. Does steps 1 to 3 over from `file`'s bytes and writes the safety version, her objects and
 * the incoming version, in that order (see the header), and then STAGES her changes as suggestions in the parts' margins (ticket 15,
 * folio-version-stage.ts): one batch write of the change ledger, all or none, never a part file. Refuses, writing nothing, when anything is
 * not as the writer saw it. For the writer every close match and ambiguous section has been decided first; an agent's import stages what is
 * settled and reports the rest (`report.close`, `report.ambiguous`), which only the writer can confirm.
 */
export async function commitImport(deps: ImportDeps, request: ImportCommitRequest, file: RevisionFile, options: CommitOptions = {}): Promise<ImportCommitAnswer> {
  if (typeof request.fileSha256 !== 'string') return refused('bad-request', 'That request was not understood, so nothing was imported.')
  const mismatch = await againstHash(deps, request, file)
  if (mismatch !== null) return mismatch
  const result = await prepared(deps, request, file)
  if ('status' in result) return result
  if (result.answer.needs > 0 && options.agent === undefined) return refused('needs-decision', `${needsLine(result.answer.needs)} Nothing was written.`)

  const from = result.answer.bases.from
  const importer: ImportBy = options.agent?.by ?? { name: from }
  const { sections, objects } = incomingSections(result.reading, result.matched)
  const docx = { sha256: result.answer.file.sha256, name: result.fileName }
  const incoming = { author: from, docx, base: result.base.id, converter: result.reading.converterVersion, sections: sections.map((section) => ({ ...section })), tableNotes: [] as Array<{ file: string; cellsDiffering: number }> }
  const report = reportOf(result.matched, result.reading)
  const filed = docx.sha256.slice(0, 12)
  const revisionId = newFolioVersionId()

  // A record the store would refuse is found now, before the writer's history is touched: the base's own index and members stand in for the safety version's.
  const stand = '0'.repeat(64)
  const dryRun = parseFolioJournalRecord({
    kind: 'folio-version', id: revisionId, ts: 0, name: incomingVersionName(from), author: { name: importer.name },
    index: { path: result.indexPath, versionId: result.base.index.versionId }, members: result.base.members,
    incoming: { ...incoming, sections: sections.map((section, index) => ({ ...section, ...(objects.some((object) => object.index === index) ? { object: stand } : {}) })) },
  })
  if (dryRun === null) return refused('not-recorded', 'WriteFlex could not make a record of this revision, so nothing was written.')

  // The binding is asked before every write below: a window that closed or switched Collection part-way stops the import there.
  const owned = async (): Promise<void> => { try { await deps.confirmOwner() } catch { throw new CollectionClosed() } }
  const stageDeps: StageDeps = { workspace: deps.workspace, changes: deps.changes, folioVersions: deps.folioVersions, readWorking: deps.readWorking, confirmOwner: owned }
  const exists = async (path: string): Promise<boolean> => (await deps.readWorking(path)) !== null
  const plan = async (): Promise<Awaited<ReturnType<typeof planStaging>>> => planStaging({
    reading: result.reading, matched: result.matched, from, revisionId, file: filed, readWorking: deps.readWorking, ...(deps.stageLimits ? { limits: deps.stageLimits } : {}),
    parts: await resolveMatchedParts(deps.reader, request.dir, result.base.id, result.matched.items.flatMap((item) => (item.status === 'exact' || item.status === 'confirmed' ? [item.part.path] : [])), exists),
  })

  // Before anything is written: the same file is not already waiting, and the plan is one this ledger can take. (Read only; it is made again under the write turn.)
  try {
    if (await alreadyWaiting(stageDeps, filed)) return refused('already-waiting', `${alreadyWaitingText(from)}`)
    await plan()
  } catch (error) {
    if (error instanceof StageRefused) return refused(error.code === 'already-waiting' ? 'already-waiting' : 'too-many-changes', error.message)
    return refused('not-recorded', `WriteFlex could not read the parts to stage the changes, so nothing was written. ${error instanceof Error ? error.message : ''}`.trim())
  }

  // 1. The safety version. If it cannot be saved, nothing else is written.
  let safety: FolioVersion
  try {
    await owned()
    safety = (await deps.save({ dir: request.dir, name: safetyVersionName(from) })).record
  } catch (error) {
    if (error instanceof CollectionClosed) return refused('collection-closed', `${error.message} Nothing was imported and nothing was written.`)
    if (error instanceof VersionSaveRefused) {
      return refused(error.code === 'version-unsettled' ? 'version-unsettled' : 'safety-not-saved', error.code === 'version-unsettled'
        ? 'You have changes of your own still waiting in this Folio. Save a Folio version first (it gathers them in), then import. Nothing was written.'
        : `${error.message} Nothing else was written.`)
    }
    return refused('safety-not-saved', `Your current text could not be saved as a version, so nothing was imported. ${error instanceof Error ? error.message : ''}`.trim(), true)
  }

  // 2 and 3. Her objects, then the one record. A failure here (or the window letting go of the Collection) leaves the safety version (it is real
  // history) and any objects already written (content-addressed and unreferenced, harmless); no record is written, so there is no incoming version.
  let record: FolioVersion
  try {
    await owned()
    const kept = await deps.folioVersions.putObject(file.bytes)
    if (kept.sha256 !== docx.sha256) throw new Error('The Word file was not kept as the bytes that were read.')
    const written = new Map<number, string>()
    const seen = new Map<string, string>()
    for (const object of objects) {
      const key = object.bytes.toString('base64')
      let name = seen.get(key)
      if (name === undefined) {
        await owned()
        name = (await deps.folioVersions.putObject(object.bytes)).sha256
        seen.set(key, name)
      }
      written.set(object.index, name)
    }
    const withObjects: FolioIncomingSection[] = sections.map((section, index) => ({ ...section, ...(written.has(index) ? { object: written.get(index)! } : {}) }))
    await owned()
    record = await deps.folioVersions.append({
      id: revisionId, name: incomingVersionName(from), note: `Imported from ${file.name}`, author: { name: importer.name }, index: safety.index, members: safety.members as FolioMember[],
      incoming: { ...incoming, sections: withObjects },
    })
  } catch (error) {
    if (error instanceof CollectionClosed) return refused('collection-closed', `${error.message} Your current text was saved as “${safety.name}”, but the revision was not stored. No incoming version was made.`, false)
    return refused('not-recorded', `Your current text was saved as “${safety.name}”, but the revision could not be stored: ${error instanceof Error ? error.message : 'unknown error'} No incoming version was made.`, false)
  }

  // 4. Stage her changes: one batch write of the ledger under the write turn, over the parts as they stand then. If it cannot be done, the revision
  // is marked withdrawn (it stays on record, with nothing staged) and every part is as it was.
  let staged: StageOutcome
  try {
    staged = (await stageIntoLedger(stageDeps, plan, filed, from)).outcome
  } catch (error) {
    const why = error instanceof CollectionClosed ? error.message : error instanceof Error ? error.message : 'unknown error'
    // The mark is a write to the Collection's history, so the window's binding is asked again first: a window that has let go of the
    // Collection (binding revoked, or switched to another) writes nothing here, and the revision is left for the writer to withdraw.
    const marked = await owned().then(
      () => deps.folioVersions.mark(record.id, { withdrawn: true }).then(() => 'withdrawn' as const, () => 'failed' as const),
      () => 'not-bound' as const,
    )
    const code = error instanceof StageRefused ? (error.code === 'already-waiting' ? 'already-waiting' as const : 'too-many-changes' as const) : error instanceof CollectionClosed ? 'collection-closed' as const : 'staging-failed' as const
    const marking = marked === 'withdrawn' ? 'The revision is marked withdrawn.'
      : marked === 'not-bound' ? 'WriteFlex no longer has this Collection open in that window, so the revision was not marked withdrawn and nothing more was written; withdraw it from the Versions list when the Collection is open.'
      : 'It could not be marked withdrawn; withdraw it from the Versions list.'
    return refused(code, `Your current text was saved as “${safety.name}” and the revision was stored, but its changes could not be staged: ${why} ${marking} No part was changed.`, false)
  }
  return { status: 'done', id: record.id, name: record.name, safetyId: safety.id, safetyName: safety.name, sectionsKept: objects.length, staged, report }
}

/** The line a command prints after a done import: what was brought in, what is waiting, what only the writer can settle. Plain text, no codenames. */
export function importedText(done: ImportDone): string {
  const { report, staged } = done
  const counts = report.counts
  const lines = [
    `Brought in “${done.name}” (${done.id}). Your current text was saved first as “${done.safetyName}” (${done.safetyId}).`,
    `${counts.matched} matched, ${counts.close} close, ${counts.new} new, ${counts.removed} removed, ${counts.moved} moved, ${counts.assetNotes} asset notes${counts.ambiguous > 0 ? `, ${counts.ambiguous} ambiguous` : ''}.`,
    stagedLine(staged),
  ]
  for (const row of report.close) lines.push(`match-needs-confirmation: “${row.heading ?? ''}” looks like “${row.title ?? row.part ?? ''}” (${row.confidence ?? 'possible'}). Only the writer can confirm it, in WriteFlex; it is left unstaged until they do.`)
  for (const row of report.ambiguous) lines.push(`needs the writer: ${row.message}`)
  for (const note of report.assetNotes) lines.push(`not applied: ${note}`)
  return lines.join('\n')
}
