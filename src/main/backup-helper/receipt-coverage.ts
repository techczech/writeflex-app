/**
 * What main may say about the receipts coverage of a captured view (locked plan §12, §13.7). Pure.
 *
 * Per document, for exactly the (path, owner-stamped doc, gen) the caller captured:
 * - `edited-not-saved`: main has no durable bytes of this exact gen for this exact document.
 * - `saved-not-registered`: main made this gen durable (synced, read back, blob computed) and no flush of
 *   that blob is applied.
 * - `receipt-registered`: the helper durably applied the flush of this gen and blob. A reply from the
 *   network is a registration only, never a backup.
 * - `captured` / `remote-verified`: the helper's status row, read after the view was captured, shows this
 *   exact document, gen and main's recorded blob captured / verified.
 * - `unknown`: anything else, including a mismatch, an omitted row, an uncertain document or no live lane.
 *
 * `covered` is the §12 green predicate, all-or-nothing: the lane is live; the view answers this outbox's
 * record; activation present; no quarantine, reset floor or vault-wide debt; every count zero (other
 * clients and other owners included); no requested row omitted; every requested document verified at its
 * gen with main's own blob; and the outbox owes nothing at all (no unsent or unacknowledged body, held
 * bytes, unreported debt, earlier-owner debt, overflow or stop). Counts without rows never make it true.
 */
import type { DocRef, ReceiptStatusView } from '@app-patterns/vault-sync'
import type { BackupReceiptDoc, BackupReceiptDocState } from '../../shared/backup-helper'
import { sameDocRef, type Outbox } from './outbox-store'
import type { LaneState } from './receipt-stream'

export type CapturedDoc = { path: string; doc: DocRef; gen: number }

export type CoverageInput = {
  lane: LaneState
  outbox: Outbox | null
  /** Read after the view was captured, through the live lane; null when none could be read. */
  view: ReceiptStatusView | null
  want: readonly CapturedDoc[]
}

export type Coverage = { docs: BackupReceiptDoc[]; covered: boolean; uncertainty: string[] }

const zero = (a: { count: number }): boolean => a.count === 0

/** Why the whole view cannot be green, if it cannot. */
function vaultDoubts(input: CoverageInput): string[] {
  const { lane, outbox, view } = input
  const doubts: string[] = []
  if (lane !== 'open') doubts.push(`receipts lane ${lane}`)
  if (!outbox) doubts.push('no receipt outbox')
  if (!view) { doubts.push('no receipt status'); return doubts }
  if (outbox && view.recordId !== outbox.recordId) doubts.push('status answers another record')
  if (view.activation === null) doubts.push('helper not activated')
  if (view.captureQuarantine !== null || view.vault.captureQuarantine !== null) doubts.push('capture quarantined')
  if (view.vault.resetFloor !== null) doubts.push('record reset floor')
  if (view.vault.oldestUnprotectedEdit !== null) doubts.push('unprotected edits in the vault')
  const v = view.vault
  const aggs = [v.legacyVaultWide, v.legacyPerPath, v.capturedUnverified, v.pending, v.unlisted, v.activeWrites.untagged, v.activeWrites.thisClient, v.activeWrites.otherClient, v.activeWrites.unknownOwner, v.otherClientDebt]
  if (!aggs.every(zero)) doubts.push('vault debt or active writes')
  const t = view.thisClient
  if (![t.unflushed, t.blobDebt, t.activeWrites].every(zero)) doubts.push('this app owes the helper')
  if (view.docs.omitted !== 0 || view.docs.items.length !== input.want.length) doubts.push('status rows omitted')
  if (outbox) {
    if (outbox.stopped) doubts.push('receipt stream stopped')
    if (outbox.sent.length > 0) doubts.push('receipts not acknowledged')
    if (outbox.held.length > 0) doubts.push('held bytes')
    if (outbox.overflowSince !== null) doubts.push('outbox overflow')
    if (outbox.docs.some((d) => d.unreported || d.editRefs.length > 0 || d.intents.length > 0 || d.uncertain)) doubts.push('local receipt debt')
  }
  return doubts
}

export function computeCoverage(input: CoverageInput): Coverage {
  const doubts = vaultDoubts(input)
  if (input.want.length === 0) doubts.push('no documents captured')
  const format = input.outbox?.objectFormat ?? null
  const live = input.lane === 'open' && input.view !== null
  const docs = input.want.map((w, index): BackupReceiptDoc => {
    const entry = input.outbox?.docs.find((d) => d.path === w.path && sameDocRef(d.doc, w.doc)) ?? null
    const row = live ? input.view!.docs.items[index] ?? null : null
    const matchesRow = row !== null && row.path === w.path && sameDocRef(row.doc, w.doc)
    const savedBlob = entry?.saved && entry.saved.gen === w.gen && format ? entry.saved.blob[format] : null
    let state: BackupReceiptDocState = 'unknown'
    let observedAt: number | null = null
    let verifiedAt: number | null = null
    let snapshot: string | null = null
    if (!entry || entry.uncertain || w.gen === 0) state = 'unknown'
    else if (!entry.saved || entry.saved.gen !== w.gen) state = 'edited-not-saved'
    else if (!savedBlob || !entry.flushed || entry.flushed.gen !== w.gen || entry.flushed.blobOid !== savedBlob) state = entry.flushed && entry.flushed.gen > w.gen ? 'unknown' : 'saved-not-registered'
    else {
      state = 'receipt-registered'
      if (matchesRow) {
        observedAt = input.view!.observedAt
        if (row.state === 'verified' && row.verified && row.verified.gen === w.gen && row.verified.blobOid === savedBlob) {
          state = 'remote-verified'
          verifiedAt = row.verified.at
          snapshot = row.verified.snapshot
        } else if (row.state === 'captured' && row.proof && row.proof.gen === w.gen && row.proof.blobOid === savedBlob) state = 'captured'
        else if (row.state === 'mismatch' || (row.proof && row.proof.gen === w.gen && row.proof.blobOid !== savedBlob)) state = 'unknown'
      }
    }
    const since = entry ? Math.min(...[entry.unreported?.at, ...entry.editRefs.map((r) => r.at), ...entry.intents.map((i) => i.at)].filter((t): t is number => typeof t === 'number')) : Number.POSITIVE_INFINITY
    return {
      path: w.path, docEpoch: w.doc.docEpoch, gen: w.gen, owner: w.doc.owner, state,
      blobOid: savedBlob, since: Number.isFinite(since) ? since : null, observedAt, verifiedAt, snapshot,
    }
  })
  const allVerified = docs.length > 0 && docs.every((d) => d.state === 'remote-verified')
  if (!allVerified) doubts.push('not every captured document is remote-verified')
  return { docs, covered: doubts.length === 0, uncertainty: doubts }
}
