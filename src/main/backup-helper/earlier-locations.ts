/** Main-owned confirmation tokens. Persistence does not enrol or start a helper. */
import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readHistoryProjection } from '../../backup-helper/history-projection'
import { insertedFileScopeTest } from '../../backup-helper/inserted-scope'
import { appendHistoryApproval, currentHistoryCohort, type EarlierLocations } from '../../backup-helper/history-approvals'
import { ordinaryScopeTest } from '@app-patterns/vault-sync/helper/host'
import type { BackupEarlierInput } from '../../shared/backup-enrolment'
// Same budget as the pinned helper engine's projection read (vault-sync 0.5.1).
export const HISTORY_INSPECTION_BUDGET_MS = 60_000
type Bound = { token: string; root: string; real: string; issued: number; binding: number; earlier: EarlierLocations; scope: { include: string[]; exclude: string[] } }
export function createEarlierLocations(options: { file: string; root(id: number): string | null; now(): number; ttl: number }) {
  // Resolve trusted userData ancestors; retain no-follow checks on backup-helper and its file.
  let ancestor = dirname(dirname(options.file))
  const missing: string[] = []
  let userData: string
  for (;;) {
    try { userData = join(realpathSync(ancestor), ...missing.reverse()); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(basename(ancestor)); ancestor = dirname(ancestor)
    }
  }
  const file = join(userData, basename(dirname(options.file)), basename(options.file))
  const tokens = new Map<number, Bound>(), bindings = new Map<number, number>()
  const timely = (b: Bound) => options.now() >= b.issued && options.now() - b.issued <= options.ttl
  const same = (id: number, b: Bound) => options.root(id) === b.root && (bindings.get(id) ?? 0) === b.binding
  return {
    retire(id: number) { tokens.delete(id); bindings.set(id, (bindings.get(id) ?? 0) + 1) },
    async inspect(real: string, scope: Bound['scope']) {
      const result = await readHistoryProjection(real, ordinaryScopeTest(scope), undefined, AbortSignal.timeout(HISTORY_INSPECTION_BUDGET_MS), file, insertedFileScopeTest(scope))
      return result.state === 'unavailable' ? result.earlier : undefined
    },
    bind(id: number, token: string, root: string, real: string, scope: Bound['scope'], earlier: EarlierLocations) {
      tokens.set(id, { token, root, real, scope, earlier, issued: options.now(), binding: bindings.get(id) ?? 0 })
    },
    async confirm(id: number, input: BackupEarlierInput): Promise<boolean> {
      const b = tokens.get(id); tokens.delete(id)
      if (!b || input.confirmEarlier !== true || input.previewId !== b.token || !same(id,b) || !timely(b)) return false
      try {
        if (realpathSync(b.root) !== b.real) return false
        const fresh = await this.inspect(b.real, b.scope)
        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(b.earlier)) return false
        appendHistoryApproval(file, b.real, fresh, () => timely(b) && same(id,b) && realpathSync(b.root) === b.real && currentHistoryCohort(b.real) === b.earlier.cohort)
        return true
      } catch { return false }
    },
  }
}
