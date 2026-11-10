/**
 * The words and the small decisions of the Save Folio version sheet and the ⇧⌘S choice (Folio versions
 * ticket 04), kept apart from the components so the tests read them without drawing anything.
 * Wording is the locked mockup's (docs/design/2026-11-02-folio-versions/mockup/locked/, scenes
 * `choose-save`, `save`, `saved`); British spelling; no internal ids.
 */
import type { FolioSaveChangedAnswer, FolioSheetFacts, FolioSheetInserted, FolioSheetWaiting } from '../../../main/folio-version-sheet'
import type { SavedFolioVersion } from '../../../main/folio-version-save'

export type SaveChoice = 'folio' | 'part'

/** The two answers, the last one first (Return repeats it). Anything not 'part' is 'folio': the common act. */
export function chooserOrder(last: unknown): SaveChoice[] {
  return last === 'part' ? ['part', 'folio'] : ['folio', 'part']
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`

/**
 * "Index Note · 11 parts in running order · 2 planned parts · 5,249 words (4,900 in the parts, 349 in the Index Note)".
 * The Folio room's header counts the parts only; the Index Note is kept in the version too, so the line says how the total divides.
 * (Both count the text as it stands on disk, before the writer's waiting changes are gathered in.)
 */
export function textLine(facts: FolioSheetFacts): string {
  const bits = ['Index Note', `${plural(facts.parts, 'part')} in running order`]
  if (facts.planned > 0) bits.push(plural(facts.planned, 'planned part'))
  const split = facts.indexWords > 0 ? ` (${(facts.words - facts.indexWords).toLocaleString('en-GB')} in the parts, ${facts.indexWords.toLocaleString('en-GB')} in the Index Note)` : ''
  bits.push(`${plural(facts.words, 'word')}${split}`)
  return bits.join(' · ')
}

/** The size cap as a person reads it: "25 MB" (a whole number of megabytes when it is one). */
export function capLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** What the sheet says about one inserted file's version. A file the save keeps no copy of is not given a version: see `notKeptLine`. */
export function insertedVersionLabel(entry: FolioSheetInserted): string {
  return entry.version
    ? `version ${entry.version.number}, “${entry.version.name}”`
    : 'a new version, saved with this one'
}

/** An inserted file too large to keep a copy of: "fig.png is too large to keep a copy of (over 25 MB); the version notes it but does not keep it." */
export function notKeptLine(entry: FolioSheetInserted, capBytes: number): string {
  return `${entry.name} is too large to keep a copy of (over ${capLabel(capBytes)}); the version notes it but does not keep it.`
}

/** The sheet as it stands for the "Not in the outline" tick box: every fact that box changes (inserted, linked, waiting, left out, fingerprint) is the unticked set's when unticked. */
export function factsFor(facts: FolioSheetFacts, includeUnlisted: boolean): FolioSheetFacts {
  return includeUnlisted || facts.withoutUnlisted === null ? facts : { ...facts, ...facts.withoutUnlisted }
}

/** True for the save's "the Folio is not what the sheet showed" answer, as opposed to a saved version. */
export const saveChanged = (answer: SavedFolioVersion | FolioSaveChangedAnswer): answer is FolioSaveChangedAnswer => 'changed' in answer && answer.changed === true

const fileNames = (paths: readonly string[]): string => paths.map((path) => path.split('/').at(-1) ?? path).join(', ')
const gained = <T,>(before: readonly T[], after: readonly T[]): T[] => after.filter((item) => !before.includes(item))

/**
 * What moved between the facts the writer read and the Folio as the save found it, in words, for the notice that says nothing was saved.
 * `includeUnlisted` is the box as the writer had it, so the lists compared are the ones the version would hold.
 */
export function describeSheetChange(before: FolioSheetFacts, after: FolioSheetFacts, includeUnlisted: boolean): string[] {
  const was = factsFor(before, includeUnlisted)
  const now = factsFor(after, includeUnlisted)
  const lines: string[] = []
  const list = (verbOne: string, verbMany: string, paths: string[]): void => {
    if (paths.length > 0) lines.push(`${fileNames(paths)} ${paths.length === 1 ? verbOne : verbMany}.`)
  }
  const beforeParts = was.partList.map((entry) => entry.path)
  const afterParts = now.partList.map((entry) => entry.path)
  list('joined the running order', 'joined the running order', gained(beforeParts, afterParts))
  list('left the running order', 'left the running order', gained(afterParts, beforeParts))
  const beforeLoose = was.unlisted.map((entry) => entry.path)
  const afterLoose = now.unlisted.map((entry) => entry.path)
  list('was added to the Folio outside the outline', 'were added to the Folio outside the outline', gained(beforeLoose, afterLoose))
  list('is no longer in the Folio outside the outline', 'are no longer in the Folio outside the outline', gained(afterLoose, beforeLoose))
  const beforeInserted = was.inserted.map((entry) => entry.path)
  const afterInserted = now.inserted.map((entry) => entry.path)
  list('is now inserted in the text', 'are now inserted in the text', gained(beforeInserted, afterInserted))
  list('is no longer inserted in the text', 'are no longer inserted in the text', gained(afterInserted, beforeInserted))
  const changedFiles = now.inserted.filter((entry) => {
    const old = was.inserted.find((candidate) => candidate.path === entry.path)
    return old !== undefined && (old.hash !== entry.hash || old.bytes !== entry.bytes || old.handling !== entry.handling || old.version?.number !== entry.version?.number)
  }).map((entry) => entry.path)
  list('changed, so the version would hold its new contents', 'changed, so the version would hold their new contents', changedFiles)
  list('is now only linked', 'are now only linked', gained(was.linked, now.linked))
  list('is no longer linked', 'are no longer linked', gained(now.linked, was.linked))
  const total = (facts: FolioSheetFacts, key: 'own' | 'agent'): number => facts.waiting.reduce((sum, entry) => sum + entry[key], 0)
  if (total(was, 'own') !== total(now, 'own')) lines.push(`Your waiting changes in the margin: ${total(now, 'own')} now, ${total(was, 'own')} when the sheet opened.`)
  if (total(was, 'agent') !== total(now, 'agent')) lines.push(`Suggestions from an agent waiting: ${total(now, 'agent')} now, ${total(was, 'agent')} when the sheet opened.`)
  if (was.words !== now.words) lines.push(`The text now has ${plural(now.words, 'word')} (${was.words.toLocaleString('en-GB')} when the sheet opened).`)
  if (lines.length === 0) lines.push('Something in the Folio moved that the sheet does not list.')
  return lines
}

/**
 * One save at a time, decided synchronously. A ref held across the whole span from "the sheet is being read" to "the save has
 * answered", so a second File ▸ Save Folio Version…, palette entry or ⇧⌘S in the same instant cannot replace the sheet or start
 * another save: React state is a frame behind, and the overlay guard lets the same overlay be raised again while it is held.
 * `begin` answers a token, or null when something holds the gate; `end` lets go only for the token that took it, so a late
 * completion of one invocation can never release (or dismiss) another's.
 */
export type SaveGate = {
  begin: (kind: 'opening' | 'saving') => symbol | null
  end: (token: symbol) => void
  /** What holds the gate now, or null. */
  held: () => 'opening' | 'saving' | null
}
export function createSaveGate(): SaveGate {
  let holder: { token: symbol; kind: 'opening' | 'saving' } | null = null
  return {
    begin: (kind) => {
      if (holder !== null) return null
      holder = { token: Symbol(kind), kind }
      return holder.token
    },
    end: (token) => { if (holder?.token === token) holder = null },
    held: () => holder?.kind ?? null,
  }
}

export const SAVING_NOW = 'A Folio version is being saved. Wait for it to finish; the sheet closes when it has.'

/** "part 8 “How could we improve reliability?”", "the Index Note", "notes.md (not in the outline)". */
export function placeName(entry: Pick<FolioSheetWaiting, 'role' | 'path' | 'title' | 'order'>): string {
  if (entry.role === 'index') return 'the Index Note'
  if (entry.role === 'unlisted') return `${entry.path.split('/').at(-1) ?? entry.path} (not in the outline)`
  const title = entry.title ? ` “${entry.title}”` : ''
  return entry.order !== undefined ? `part ${entry.order}${title}` : `${entry.path.split('/').at(-1) ?? entry.path}${title}`
}

export type WaitingBlock = { headline: string; body: string; lines: string[] }
export type WaitingBlocks = { own: WaitingBlock | null; agent: WaitingBlock | null }

/** The waiting-changes blocks. `includeUnlisted` false drops the files not in the outline: they are not in this version, so their changes are not touched. */
export function waitingBlocks(facts: FolioSheetFacts, includeUnlisted: boolean): WaitingBlocks {
  const waiting = facts.waiting.filter((entry) => includeUnlisted || entry.role !== 'unlisted')
  const own = waiting.filter((entry) => entry.own > 0)
  const agent = waiting.filter((entry) => entry.agent > 0)
  const ownTotal = own.reduce((sum, entry) => sum + entry.own, 0)
  const agentTotal = agent.reduce((sum, entry) => sum + entry.agent, 0)
  return {
    own: own.length === 0 ? null : {
      headline: own.length === 1
        ? `${plural(ownTotal, 'change')} in ${placeName(own[0])} ${ownTotal === 1 ? 'is' : 'are'} still waiting`
        : `${plural(ownTotal, 'change')} in ${plural(own.length, 'part')} are still waiting`,
      body: `in the margin. They are yours, so saving gathers ${ownTotal === 1 ? 'it' : 'them'} into the text first and the version holds ${ownTotal === 1 ? 'it' : 'them'}.`,
      lines: own.length === 1 ? [] : own.map((entry) => `${plural(entry.own, 'change')} in ${placeName(entry)}`),
    },
    agent: agent.length === 0 ? null : {
      headline: agent.length === 1
        ? `${plural(agentTotal, 'suggestion')} from an agent in ${placeName(agent[0])} ${agentTotal === 1 ? 'is' : 'are'} waiting too.`
        : `${plural(agentTotal, 'suggestion')} from an agent in ${plural(agent.length, 'part')} are waiting too.`,
      body: `${agentTotal === 1 ? 'It stays' : 'They stay'} in the margin and ${agentTotal === 1 ? 'is' : 'are'} left out of this version.`,
      lines: agent.length === 1 ? [] : agent.map((entry) => `${plural(entry.agent, 'suggestion')} in ${placeName(entry)}`),
    },
  }
}

/** "research/ 38 files · data/ 6 files the text does not insert · offcuts/ 3 · archive/ 43 · the Folio bin 2 files", zero entries left out. */
export function leftOutLine(facts: FolioSheetFacts): string {
  const { research, data, offcuts, archive, bin } = facts.leftOut
  const bits: string[] = []
  if (research > 0) bits.push(`research/ ${plural(research, 'file')}`)
  if (data > 0) bits.push(`data/ ${plural(data, 'file')} the text does not insert`)
  if (offcuts > 0) bits.push(`offcuts/ ${offcuts.toLocaleString('en-GB')}`)
  if (archive > 0) bits.push(`archive/ ${archive.toLocaleString('en-GB')}`)
  if (bin > 0) bits.push(`the Folio bin ${plural(bin, 'file')}`)
  return bits.length > 0 ? bits.join(' · ') : 'research/, data the text does not insert, offcuts/, archive/ and the Folio bin (nothing is in them now)'
}

export const LEFT_OUT_NOTE = 'A quote copied from research stays in the text; a file that is only linked is listed, not kept.'

/** The toast after a save: "Saved Folio version “X”: 11 parts, 3 files not in the outline, 3 inserted files." */
export function savedToast(saved: SavedFolioVersion): string {
  const count = (role: string): number => saved.record.members.filter((member) => member.role === role).length
  const bits = [plural(count('part'), 'part'), `${plural(count('unlisted'), 'file')} not in the outline`, plural(count('inserted'), 'inserted file')]
  const references = count('reference')
  if (references > 0) bits.push(`${plural(references, 'file')} listed, not kept`)
  const left = saved.waiting.length
  return `Saved Folio version “${saved.record.name}”: ${bits.join(', ')}.${left > 0 ? ` Waiting suggestions in ${plural(left, 'file')} were left out.` : ''}`
}

/** Strip the wrapper Electron puts around an error thrown in main, leaving the sentence. */
export function refusalSentence(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: |VersionSaveRefused: )?/, '').trim() || 'The Folio version was not saved.'
}
