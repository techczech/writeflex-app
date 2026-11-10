/**
 * Take one part's text from another Folio version (ADR-0052 § The eight changes 4; journey J4; Folio versions ticket 09).
 *
 * A TAKE IS A PROPOSAL, SHOWN FIRST. It files one change over the whole part in the change ledger (`ChangeStore.add`), the same
 * record a version restored from outside has (outside-change.ts `restore-version`: `whole`, `oldText` the part as it stands,
 * `newText` the version's text) and writes no part file. The part changes only when the writer accepts the change in the margin, by
 * the Accept every proposal has: it takes a restore point of the part first, writes through the guarded door over exactly the text it
 * read (in a OneDrive Collection that door is the one that keeps the write in local recovery first), and applies only while the part
 * is still exactly `oldText`; otherwise it closes with the reason and nothing is written. Undo before Accept is declining the change.
 *
 * REFUSED, WITH NOTHING FILED, when:
 *  - the part is not the bytes the comparison was drawn over (a fingerprint the comparison carried, checked here under the
 *    Collection's write turn, as the save sheet's go-ahead is, ticket 04);
 *  - the writer's own changes to the part are still waiting in the margin (a take would overwrite them);
 *  - a take of the part is already waiting;
 *  - the two texts are the same, either is unreadable, or the part is empty or too large for a change over the whole of it.
 * The window also refuses, before it asks, while the part has text typed in an editor and not saved (only the window can see that).
 *
 * The record's author is the Folio version, never the writer's, never an agent's, so the margin can say where the text is from.
 */
import { createHash } from 'node:crypto'
import { isFolioVersionId } from '../shared/folio-version-records'
import { COMPARE_WORKING } from '../shared/folio-version-compare'
import { takeRefusalText, takeSummary, UNDO_TAKE_ACCEPTED, UNDO_TAKE_DONE, UNDO_TAKE_DONE_CARD, UNDO_TAKE_DONE_CARD_KEPT, UNDO_TAKE_NOT_THERE, type FolioTakeInput, type FolioTakeRefusal, type FolioTakeResult, type FolioUndoTakeInput, type FolioUndoTakeResult } from '../shared/folio-version-take'
import { MAX_WHOLE_DOCUMENT_BYTES } from './cli/review-format'
import { undecided, type ChangeStore } from './changes'
import { FolioCompareRefused, readTakePair, type FolioCompareSources } from './folio-version-compare'
import { folioTakeOf } from '../shared/folio-version-take'
import type { ScratchpadStore } from './scratchpad-store'
import type { Workspace } from './workspace'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export type FolioTakeStores = {
  workspace: Workspace
  sources: FolioCompareSources
  changes: ChangeStore
  /** The Scratchpad's store, for "keep mine in Scratchpad" (ticket 10). Absent: that take is refused. */
  scratchpad?: ScratchpadStore
}

const refused = (reason: FolioTakeRefusal, title: string, versionName?: string): FolioTakeResult => ({ ok: false, reason, message: takeRefusalText(reason, title, versionName) })

/** Checks the shape of what the window sent; anything else is not a take. */
export function takeInputOf(input: unknown): FolioTakeInput | null {
  const { dir, from, to, key, expected, keepMine } = (input ?? {}) as Record<string, unknown>
  const end = (value: unknown): value is string => typeof value === 'string' && (value === COMPARE_WORKING || isFolioVersionId(value))
  if (typeof dir !== 'string' || !end(from) || !end(to) || typeof key !== 'string' || key.length > 1000 || typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return null
  return { dir, from, to, key, expected, ...(keepMine === true ? { keepMine: true as const } : {}) }
}

/**
 * Stage the version's text for one part as a proposal. Never writes a part. `input.dir` is the Folio's folder as the window's own door
 * already checked it. The reads and the filing are one turn of the Collection's write turn, so an Accept or a save never lands between.
 */
export async function takePartFromVersion(stores: FolioTakeStores, input: FolioTakeInput): Promise<FolioTakeResult> {
  return stores.workspace.exclusiveAll(async () => {
    let pair
    try { pair = await readTakePair(stores.sources, input.dir, input.from, input.to, input.key) } catch (error) {
      if (error instanceof FolioCompareRefused) return { ok: false, reason: 'not-a-take', message: error.message } satisfies FolioTakeResult
      throw error
    }
    if (pair === 'not-a-take') return refused('not-a-take', 'this part')
    if (pair === 'unreadable') return refused('unreadable', 'this part')
    const { title, path, version } = pair
    // Under the turn: the part is still the bytes the comparison was drawn over.
    if (sha256(pair.workingBytes) !== input.expected) return refused('changed', title)
    const current = pair.workingBytes.toString('utf8')
    const text = pair.versionBytes.toString('utf8')
    if (current === text) return refused('same', title, version.name)
    if (current === '') return refused('empty', title)
    if (Buffer.byteLength(current) > MAX_WHOLE_DOCUMENT_BYTES || Buffer.byteLength(text) > MAX_WHOLE_DOCUMENT_BYTES) return refused('too-large', title)
    const known = await stores.changes.list({ path })
    // The writer's own edits to the part that are waiting for review would be overwritten by the take.
    if (known.some((change) => change.provenance === 'writer' && undecided(change) && change.oldText !== change.newText)) return refused('writer-changes', title)
    if (known.some((change) => undecided(change) && folioTakeOf(change) !== null)) return refused('waiting', title)
    // "Keep mine in Scratchpad" (ticket 10): the text being replaced goes to the Scratchpad FIRST, through the store's checked writer (an
    // ordinary copy of the working part, exactly as it stands on disk, under the same turn as the fingerprint check). If that fails,
    // nothing is staged. If staging then fails, the copy that nothing used is withdrawn.
    let kept: string | undefined
    if (input.keepMine) {
      if (!stores.scratchpad) return refused('keep-failed', title, 'The Scratchpad is not ready yet.')
      try {
        kept = (await stores.scratchpad.addText({ origin: path, markdown: current, how: 'copy', by: 'writer' })).id
      } catch (error) {
        return refused('keep-failed', title, error instanceof Error ? error.message : String(error))
      }
    }
    let filed
    try {
      filed = await stores.changes.add({
        path,
        provenance: 'agent',
        editClass: 'content',
        category: 'other',
        summary: takeSummary(version.name, title),
        oldText: current,
        newText: text,
        whole: true,
        isCorrection: false,
        author: { name: `Folio version “${version.name.slice(0, 120)}”` },
        folioTake: { versionId: version.id, versionName: version.name.slice(0, 200) },
      } as Parameters<ChangeStore['add']>[0])
    } catch (error) {
      if (kept === undefined) throw error
      // The copy nothing used is withdrawn. If it cannot be, say so with the card's id (the window offers to remove it): never an error that hides the card.
      const withdrawn = await stores.scratchpad?.discardCopy(kept).then(() => true, () => false)
      if (withdrawn) throw error
      return { ok: false, reason: 'stage-failed', message: takeRefusalText('stage-failed', title), keptItemId: kept }
    }
    return { ok: true, changeId: filed.id, path, title, versionName: version.name, ...(kept !== undefined ? { keptItemId: kept } : {}) }
  })
}

/**
 * Undo of a take that is waiting (the Undo beside "Staged"; journey J4). Under the Collection's write turn, the same turn Accept holds from
 * its status read to its status write, so the two cannot interleave: the change is declined ONLY if it is still undecided. Then, and only
 * then, the Scratchpad card "keep mine" made is withdrawn.
 *  - already accepted (in another window or in the margin): nothing is changed, and the sentence says how to go back (⌘Z, the restore point);
 *  - already declined or closed: the take is not waiting, so Undo has nothing to decline; the card, if any, is still withdrawn;
 *  - not a take, or not there: refused, nothing changed.
 * It declines only a change a take filed (`folioTake`), so it is not a way to settle any other change.
 */
export async function undoTake(stores: Pick<FolioTakeStores, 'workspace' | 'changes' | 'scratchpad'>, input: FolioUndoTakeInput): Promise<FolioUndoTakeResult> {
  return stores.workspace.exclusiveAll(async () => {
    const change = await stores.changes.get(input.changeId)
    if (!change || folioTakeOf(change) === null) return { ok: false, reason: 'not-a-take', message: UNDO_TAKE_NOT_THERE } satisfies FolioUndoTakeResult
    if (change.status === 'accepted') return { ok: false, reason: 'accepted', message: UNDO_TAKE_ACCEPTED } satisfies FolioUndoTakeResult
    if (undecided(change)) {
      try { await stores.changes.setStatus(change.id, 'rejected') } catch {
        return { ok: false, reason: 'failed', message: 'That take could not be taken back from here. Decline it in the part’s margin.' } satisfies FolioUndoTakeResult
      }
    }
    if (input.keptItemId === undefined) return { ok: true, cardWithdrawn: null, message: UNDO_TAKE_DONE }
    const withdrawn = stores.scratchpad ? await stores.scratchpad.discardCopy(input.keptItemId).then(() => true, () => false) : false
    return withdrawn
      ? { ok: true, cardWithdrawn: true, message: UNDO_TAKE_DONE_CARD }
      : { ok: true, cardWithdrawn: false, message: UNDO_TAKE_DONE_CARD_KEPT }
  })
}
