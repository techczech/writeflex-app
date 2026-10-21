// When readers' notes are collected (0.24 ticket 07): for one window's Collection, a look when it is
// bound, then every minute and whenever a link changes, one look at a time. Only while the window holds
// the Collection's owner lock (the one writer), so two windows, or two Macs on one synced Collection,
// never collect into it at once. The links and their owner tokens come from the publisher
// (sharing-publisher.ts `noteSources`), set once by index.ts; nothing here leaves main.
//
// Ticket 08: the same look then sends what readers are owed, the outcome of each note and the writer's
// replies, to the link each note came through (sharing-reader-replies.ts). A look runs too when the
// window decides a reader's note or replies to one (`hearBack`), so the reader's next load shows it.
//
// No Electron import.
import { collectReaderNotes, guardedDocumentReader, type CollectOutcome, type NotesRefused, type ReaderLinkSource, type ReaderNotesPorts, type ShareNoteLimits } from './sharing-reader-notes'
import type { ChangeStore } from './changes'
import { LEGACY_ANSWERS_AT_MOST, sendReaderOutcomes, type LegacyAnswers, type ReaderRepliesPorts } from './sharing-reader-replies'
import type { Workspace } from './workspace'

export type ReaderNotesSource = {
  links(root: string): ReaderLinkSource[]
  fetchNotes: ReaderNotesPorts['fetchNotes']
  markCollected: ReaderNotesPorts['markCollected']
  /** Ticket 08: outcomes and replies to a link's service. Absent: nothing is sent back. */
  sendOutcomes?: ReaderRepliesPorts['sendOutcomes']
  /** Every link that still has a note source, in any Collection: what the per-link maps here may keep.
   *  Null: not known just now (the tokens could not be read); nothing is pruned. */
  shareIds?(): string[] | null
}

let source: ReaderNotesSource | null = null
const listeners = new Set<() => void>()
/** What each link's service last said it refused from readers (limits), by share id, for the Sharing page. */
const refusedByShare = new Map<string, NotesRefused>()

export function setReaderNotesSource(next: ReaderNotesSource | null): void { source = next }
/** A link changed (made, turned on or off, removed): what is kept for a removed link goes; every Collection looks again. */
export function readerLinksChanged(): void {
  pruneReaderNoteMaps()
  for (const listener of listeners) listener()
}
/** Forget what was kept for links that no longer exist (nothing to prune without a source that names them,
 *  or while it cannot say which do: a Keychain read failure is not every link removed). */
export function pruneReaderNoteMaps(): void {
  const ids = source?.shareIds ? source.shareIds() : null
  if (!ids) return
  const live = new Set(ids)
  for (const shareId of [...refusedByShare.keys()]) if (!live.has(shareId)) refusedByShare.delete(shareId)
  for (const shareId of [...limitsByShare.keys()]) if (!live.has(shareId)) limitsByShare.delete(shareId)
  for (const shareId of [...legacyByShare.keys()]) if (!live.has(shareId)) legacyByShare.delete(shareId)
}
/**
 * Ticket 08: answers in a row from a service older than build 7 (no per-reply entries), and when the
 * last came, by share id (sharing-reader-replies.ts LEGACY_ANSWERS_AT_MOST, LEGACY_RETRY_MS). Kept for
 * the app's run, never stored. The pause lifts on an answer with per-reply entries, on the sender's
 * retry every LEGACY_RETRY_MS, and here when the service is set up, updated, or Settings finds it
 * current (sharing-ipc.ts `sharing:status`).
 */
const legacyByShare = new Map<string, LegacyAnswers>()
/** Whether this link's replies wait for the sharing service to be updated (older-service answers, too many in a row). */
export function repliesNeedServiceUpdate(shareId: string): boolean { return (legacyByShare.get(shareId)?.count ?? 0) >= LEGACY_ANSWERS_AT_MOST }
/** The sharing service was set up, updated, or found current: every link's replies are tried again, and every Collection looks. */
export function sharingServiceUpdated(): void {
  legacyByShare.clear()
  readerLinksChanged()
}
export function refusedFor(shareId: string): NotesRefused | null { return refusedByShare.get(shareId) ?? null }
/** Each link's own limits as its service last stated them (null: a service older than build 5), by share id. */
const limitsByShare = new Map<string, ShareNoteLimits | null>()
/** Undefined: the service has not been asked yet for this link. */
export function limitsFor(shareId: string): ShareNoteLimits | null | undefined { return limitsByShare.get(shareId) }
/** Raise the limit for this link answered: its limits now, until the next look. */
export function setLimitsFor(shareId: string, limits: ShareNoteLimits | null): void { limitsByShare.set(shareId, limits) }

export const READER_NOTES_INTERVAL_MS = 60_000

export function startReaderNotesCollection(input: {
  workspace: Workspace
  changes: ChangeStore
  /** Still bound to this Collection, and holding its owner lock. */
  owns(): boolean
  onCollected(outcome: CollectOutcome): void
  /** Ticket 08: a link's service confirmed outcomes or replies (the cards' "Sent" marks change). */
  onHeard?(): void
  report?(event: string, details: Record<string, unknown>): void
  intervalMs?: number
}): { dispose(): void; look(): Promise<void> } {
  let running: Promise<void> | null = null
  let again = false
  let disposed = false
  const look = async (): Promise<void> => {
    if (disposed) return
    if (running) { again = true; return running }
    running = (async () => {
      do {
        again = false
        const from = source
        if (!from || !input.owns()) return
        const links = from.links(input.workspace.root)
        // A look with no link left still forgets what was kept for links removed (review round 1 of ticket
        // 11, F3); a token read that fails prunes nothing (`pruneReaderNoteMaps`).
        if (links.length === 0) { pruneReaderNoteMaps(); return }
        try {
          const outcome = await collectReaderNotes({ fetchNotes: from.fetchNotes, markCollected: from.markCollected, readDocument: guardedDocumentReader(input.workspace), changes: input.changes, now: Date.now }, links)
          for (const [shareId, refused] of Object.entries(outcome.refused)) refusedByShare.set(shareId, refused)
          for (const [shareId, limits] of Object.entries(outcome.limits)) limitsByShare.set(shareId, limits)
          // A link removed while the look ran keeps nothing.
          pruneReaderNoteMaps()
          if (!disposed && (outcome.added > 0 || Object.keys(outcome.refused).length > 0)) input.onCollected(outcome)
          // A look whose only outcome is links skipped (no answer, a document unreadable) is logged too
          // (ticket 11, review 07 P3-C): counts only, never a share id, address or token.
          if (outcome.added > 0 || outcome.full > 0 || outcome.dropped > 0 || outcome.failed.length > 0) input.report?.('reader-notes.look', { added: outcome.added, repeats: outcome.repeats, full: outcome.full, dropped: outcome.dropped, failed: outcome.failed.length })
          // Ticket 08: what readers are owed, after the notes are in (a note collected this look may be decided already).
          if (from.sendOutcomes && input.owns()) {
            const before = links.map((link) => repliesNeedServiceUpdate(link.shareId)).join()
            const heard = await sendReaderOutcomes({ sendOutcomes: from.sendOutcomes, changes: input.changes, now: Date.now, legacy: legacyByShare }, links.map((link) => ({ shareId: link.shareId, base: link.base, owner: link.owner })))
            // A link whose replies now wait for the update (or no longer do) changes the cards too.
            const outdatedChanged = links.map((link) => repliesNeedServiceUpdate(link.shareId)).join() !== before
            if ((heard.sent > 0 || heard.gone > 0 || outdatedChanged) && !disposed) input.onHeard?.()
            if (heard.sent > 0 || heard.gone > 0 || heard.failed.length > 0 || outdatedChanged) input.report?.('reader-notes.heard', { sent: heard.sent, left: heard.left, gone: heard.gone, failed: heard.failed.length, outdated: heard.outdated.length })
          }
        } catch (error) {
          // The Collection could not be written just now: nothing was marked collected; the next look asks again.
          input.report?.('reader-notes.failed', { message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })
        }
      } while (again && !disposed)
    })().finally(() => { running = null })
    return running
  }
  const timer = setInterval(() => { void look() }, input.intervalMs ?? READER_NOTES_INTERVAL_MS)
  ;(timer as { unref?: () => void }).unref?.()
  const listener = (): void => { void look() }
  listeners.add(listener)
  void look()
  return {
    look,
    dispose() { disposed = true; clearInterval(timer); listeners.delete(listener) },
  }
}
