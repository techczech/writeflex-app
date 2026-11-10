import { READER_CLAIM_RELEASE_MS } from '../../sharing-service/share-protocol.ts'
import { randomUUID } from 'node:crypto'
import type { Change } from '../engine'
import { readerNoteOf } from './outside-change-fields'
// When readers' notes are collected (0.24 ticket 07): for one window's Collection, a look when it is
// bound, then every 15 seconds with an app window focused (60 otherwise), and whenever a link
// changes, one look at a time. Only while the window has
// the Collection open (one window per Collection per app). There is no Collection lock: two Macs on one
// synced Collection may both collect all retained items; service item identity and the current
// service receipt converge their review cards, including sync-created journal copies
// (docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md). The links and their owner tokens come from the publisher
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
  refresh?(root: string): Promise<void>
  claimAccept?(base: string, shareId: string, owner: string, key: string, claim: string): Promise<import('./sharing-client').ServiceAnswer<{ allowed: boolean; status?: string }>>
  releaseAccept?(base: string, shareId: string, owner: string, key: string, claim: string, force?: boolean, expectedAt?: number): Promise<unknown>
  links(root: string): ReaderLinkSource[]
  /** The mode shown locally when an owner writes a reply, before any sending or retry. */
  replyVisibility?(root: string, shareId: string): 'private' | 'open'
  fetchNotes: ReaderNotesPorts['fetchNotes']
  markCollected: ReaderNotesPorts['markCollected']
  /** Ticket 08: outcomes and replies to a link's service. Absent: nothing is sent back. */
  sendOutcomes?: ReaderRepliesPorts['sendOutcomes']
  /** Every link that still has a note source, in any Collection: what the per-link maps here may keep.
   *  Null: not known just now (the tokens could not be read); nothing is pruned. */
  shareIds?(): string[] | null
}

let source: ReaderNotesSource | null = null
const claimsByItem = new Map<string, { at: number; mine: boolean; ready: boolean }>()
export function rememberReaderClaims(shareId: string, notes: unknown[]): boolean {
  let changed = false
  for (const item of notes) {
    const v = item as { key?: unknown; claim?: { at?: unknown; mine?: unknown } } | null
    if (typeof v?.key !== 'string') continue
    const key = `${shareId}/${v.key}`
    const previous = claimsByItem.get(key)
    if (Number.isSafeInteger(v.claim?.at) && typeof v.claim?.mine === 'boolean') {
      const next = { at: v.claim.at as number, mine: v.claim.mine, ready: !v.claim.mine && Date.now() - (v.claim.at as number) > READER_CLAIM_RELEASE_MS }
      if (JSON.stringify(previous) !== JSON.stringify(next)) changed = true
      claimsByItem.set(key, next)
    } else if (claimsByItem.delete(key)) changed = true
  }
  return changed
}
export function readerClaimFor(change: Change): { at: number; mine: boolean } | null {
  const fields = readerNoteOf(change)
  const claim = fields ? claimsByItem.get(`${fields.shareId}/${fields.key}`) : null
  return claim ? { at: claim.at, mine: claim.mine } : null
}
/** The confirmation is a main-owned card. Re-read after it and let the service make the final check. */
export async function releaseReaderClaim(root: string, change: Change, confirm: () => Promise<boolean>): Promise<boolean> {
  const fields = readerNoteOf(change), from = source
  const link = fields && from?.links(root).find((link) => link.shareId === fields.shareId)
  if (!fields || !from || !link || !from.releaseAccept) return false
  const read = async () => {
    const answer = await from.fetchNotes(link.base, link.shareId, link.owner)
    if (answer.kind !== 'ok') return null
    rememberReaderClaims(link.shareId, answer.body.notes)
    return readerClaimFor(change)
  }
  const claim = await read()
  if (!claim || claim.mine || Date.now() - claim.at <= READER_CLAIM_RELEASE_MS || !await confirm()) return false
  const current = await read()
  if (!current || current.mine || current.at !== claim.at) return false
  const answer = await from.releaseAccept(link.base, link.shareId, link.owner, fields.key, randomUUID(), true, claim.at) as { kind?: string }
  if (answer?.kind !== 'ok') return false
  claimsByItem.delete(`${link.shareId}/${fields.key}`)
  readerLinksChanged()
  return true
}
// Only operations whose file-writing callback has never run can reuse a reservation after offline.
const unstartedClaims = new Map<string, string>()
/** The file-writing Accept path claims exactly one operation; ambiguous failures keep the claim. */
export async function guardReaderAcceptance<T extends { applied: boolean }>(root: string, change: Change, act: () => Promise<T>): Promise<T | { applied: false; message: string }> {
  const fields = readerNoteOf(change), from = source
  if (!fields || fields.kind !== 'edit' || !from?.claimAccept) return act()
  const link = from.links(root).find((link) => link.shareId === fields.shareId)
  if (!link) return { applied: false, message: 'This Mac cannot confirm the reader edit with the sharing service. Check sharing and try again.' }
  const operation = JSON.stringify([root, fields.shareId, fields.key])
  const claim = unstartedClaims.get(operation) ?? randomUUID()
  unstartedClaims.set(operation, claim)
  const answer = await from.claimAccept(link.base, link.shareId, link.owner, fields.key, claim).catch(() => null)
  if (answer?.kind !== 'ok') return { applied: false, message: 'The sharing service could not confirm this edit. Nothing was applied; check the connection and try again.' }
  if (!answer.body.allowed) { unstartedClaims.delete(operation); return { applied: false, message: 'This edit has already been handled, or is being applied, on another Mac. Nothing was applied here.' } }
  unstartedClaims.delete(operation)
  // A thrown error can follow a committed write, so it never releases the reservation.
  const result = await act()
  if (!result.applied) await from.releaseAccept?.(link.base, link.shareId, link.owner, fields.key, claim).catch(() => {})
  return result
}

const listeners = new Set<() => void>()
/** What each link's service last said it refused from readers (limits), by share id, for the Sharing page. */
const refusedByShare = new Map<string, NotesRefused>()

export function setReaderNotesSource(next: ReaderNotesSource | null): void { source = next; if (next === null) { unstartedClaims.clear(); claimsByItem.clear() } }
export function readerReplyVisibility(root: string, shareId: string): 'private' | 'open' {
  return source?.replyVisibility?.(root, shareId) === 'open' ? 'open' : 'private'
}
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
export const READER_NOTES_FOCUSED_INTERVAL_MS = 15_000

export function startReaderNotesCollection(input: {
  workspace: Workspace
  changes: ChangeStore
  /** Still bound to this Collection, and the Collection still open here. */
  owns(): boolean
  onCollected(outcome: CollectOutcome): void
  /** Ticket 08: a link's service confirmed outcomes or replies (the cards' "Sent" marks change). */
  onHeard?(): void
  report?(event: string, details: Record<string, unknown>): void
  onFocusChanged?(changed: () => void): () => void
  focused?(): boolean
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
        await from.refresh?.(input.workspace.root).catch(() => {})
        if (disposed || !input.owns()) return
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
  let timer: ReturnType<typeof setTimeout>
  const schedule = (): void => {
    clearTimeout(timer)
    const delay = input.intervalMs ?? (input.focused?.() ? READER_NOTES_FOCUSED_INTERVAL_MS : READER_NOTES_INTERVAL_MS)
    timer = setTimeout(() => { void look(); if (!disposed) schedule() }, delay)
    ;(timer as { unref?: () => void }).unref?.()
  }
  schedule()
  const stopFocus = input.onFocusChanged?.(() => { clearTimeout(timer); if (!disposed) schedule() })
  const listener = (): void => { void look() }
  listeners.add(listener)
  void look()
  return {
    look,
    dispose() { disposed = true; clearTimeout(timer); stopFocus?.(); listeners.delete(listener) },
  }
}
