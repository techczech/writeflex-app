/** Read-only fold shared by the app and backup helper. Caller supplies validated rows and physical
 * evidence. Last finish wins; assigned paths survive later name updates; unresolved IDs stay hidden.
 * No journal reads, app writes or Electron dependencies.
 */
import { sortVersionsNewestFirst, type Version } from './index'
export type Assignment = { id: string; from: string; to: string }
export type Evidence = { from: string; to: string; dev: number; ino: number; hash?: string; beforeHash?: string }
export type MoveRecord = { kind: 'version-paths'; id: string; ts?: number; assignments: Assignment[]; destinationIds?: string[]; evidence?: Evidence; undoes?: string; reattachedIds?: string[]; heldBackIds?: string[] }
export type Finish = { kind: 'version-paths-finish'; id: string; state: 'done' | 'cancelled' }
export type JournalRecord = Version | MoveRecord | Finish

export type MoveState = 'happened' | 'not-happened' | 'held-back'
/** Last finish wins, consistently across reads and every journal lookup. */
export function finishState(rows: JournalRecord[]): Map<string, Finish['state']> {
  const states = new Map<string, Finish['state']>()
  for (const row of rows) if ('kind' in row && row.kind === 'version-paths-finish') states.set(row.id, row.state)
  return states
}

export function projectVersionRows(rows: JournalRecord[], evidence: (e: Evidence) => MoveState, observe?: (row: Version, current: Version | undefined) => void, check?: () => void): { visible: Version[]; heldBack: Version[] } {
  const states = finishState(rows)
  const versions = new Map<string, Version>()
  const assignedPaths = new Map<string, string>()
  const unresolved = new Set<string>()
  for (const row of rows) {
    check?.()
    if (!('kind' in row)) {
      const current = versions.get(row.id)
      observe?.(row, current)
      if (!current || row.ts >= current.ts) versions.set(row.id, { ...row, path: assignedPaths.get(row.id) ?? row.path })
    } else if (row.kind === 'version-paths' && states.get(row.id) !== 'cancelled') {
      const state = states.get(row.id) === 'done' || !row.evidence ? 'happened' : evidence(row.evidence)
      for (const a of row.assignments) {
        check?.()
        const version = versions.get(a.id)
        if (version?.path !== a.from) continue
        if (state === 'happened') {
          unresolved.delete(a.id)
          assignedPaths.set(a.id, a.to)
          versions.set(a.id, { ...version, path: a.to })
          if (row.heldBackIds?.includes(a.id)) unresolved.add(a.id)
        } else if (state === 'held-back') unresolved.add(a.id)
      }
    }
  }
  return {
    visible: sortVersionsNewestFirst([...versions.values()].filter(version => !unresolved.has(version.id))),
    heldBack: sortVersionsNewestFirst([...versions.values()].filter(version => unresolved.has(version.id))),
  }
}

