import type { Change } from '../engine'
import { pendingOutsideBatchChange, type BatchTarget } from '../shared/outside-batch-review'
import { acceptOrder, byDocument } from './outside-bulk-accept'
import { readDocumentBytesGuarded } from './guarded-document-read'
import type { Workspace } from './workspace'

export function batchTargets(value: unknown): BatchTarget[] {
  if (!Array.isArray(value) || value.length > 1000 || !value.every(target =>
    target && typeof target.id === 'string' && typeof target.path === 'string')) {
    throw new Error('Choose up to 1,000 pending outside changes.')
  }
  return [...new Map(value.map((target: BatchTarget) => [target.id, { id: target.id, path: target.path }])).values()]
}

export async function orderOutsideBatch(ws: Workspace, changes: readonly Change[], targets: readonly BatchTarget[]): Promise<BatchTarget[]> {
  const selected = new Map(targets.map(target => [target.id, target.path]))
  const ordered: BatchTarget[] = []
  for (const [path, group] of byDocument(changes.filter(change => selected.get(change.id) === change.path && pendingOutsideBatchChange(change)))) {
    const read = await readDocumentBytesGuarded(ws, path).catch(() => null)
    for (const change of read ? acceptOrder(read.bytes.toString('utf8'), group) : group) ordered.push({ id: change.id, path })
  }
  const present = new Set(ordered.map(target => target.id))
  // Stale rows still go through the decision guard so their refusal is reported.
  return [...ordered, ...targets.filter(target => !present.has(target.id))]
}
