import type { Change } from '../../../preload'
import { isNotApplied } from '../components/outside-dock-model'

/** The pending-run buckets the review surface groups changes into (quiet / held / provisional / yours /
 *  other), shared with the dock header's counts. */
export function reviewBuckets(changes: Change[]): {
  quietFixes: Change[]
  heldChanges: Change[]
  provisionalChanges: Change[]
  writerChanges: Change[]
  otherWorkingChanges: Change[]
  acceptedChanges: Change[]
  rejectedChanges: Change[]
  /** Closed by the app without being applied (`closedReason`): their own fold, never counted as rejected. */
  notAppliedChanges: Change[]
} {
  const quietFixes = changes.filter((change) => change.editClass === 'copy' && change.status !== 'rejected')
  const heldChanges = changes.filter((change) => change.status === 'held')
  const provisionalChanges = changes.filter(
    (change) => change.status === 'pending' && change.provenance === 'agent' && (change.editClass === 'content' || change.editClass === 'insert'),
  )
  // Pending only: once folded (accepted) an edit leaves the "to fold" list and stays in the ledger for
  // the next version. otherWorkingChanges is pending-only too, so a folded edit never leaks there.
  const writerChanges = changes.filter(
    (change) => change.provenance === 'writer' && change.editClass !== 'copy' && change.status === 'pending',
  )
  const used = new Set([
    ...quietFixes.map((change) => change.id),
    ...heldChanges.map((change) => change.id),
    ...provisionalChanges.map((change) => change.id),
    ...writerChanges.map((change) => change.id),
  ])
  const otherWorkingChanges = changes.filter((change) => !used.has(change.id) && change.status === 'pending')
  const acceptedChanges = changes.filter((change) => change.status === 'accepted' && change.editClass !== 'copy')
  // Rejected AGENT proposals fold away with a Reopen escape hatch (a mis-click is not a one-way door).
  // A rejected writer edit already reverted the buffer text, so reopening it has nothing to restore.
  const notAppliedChanges = changes.filter(isNotApplied)
  const rejectedChanges = changes.filter((change) => change.status === 'rejected' && change.provenance !== 'writer' && !isNotApplied(change))
  return { quietFixes, heldChanges, provisionalChanges, writerChanges, otherWorkingChanges, acceptedChanges, rejectedChanges, notAppliedChanges }
}
