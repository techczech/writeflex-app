import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Change, OutsideSummary } from '../../../preload'
import { isFromOutside, isUndecided, scopeOutsideSummary, outsideChangesElsewhere } from '../components/outside-dock-model'
import { loadDismissed, saveDismissed, withDismissed } from './dismissed-not-applied'
import { outsideSourceRows, type OutsideSourceRow } from './outside-source-bulk'

/**
 * What the review dock reads about changes from outside beyond the open document's own list: the
 * undecided and closed outside changes of every OTHER document, the ledger's summary (counts, last
 * look), and the arrival notice (outside changes that appeared since the last look, cleared when one of
 * the waiting ones is decided). Re-reads on `changes:changed`.
 */
export function useOutsideDock(active: string | null, root: string | null | undefined, folioDir: string | null = null): {
  others: Change[]
  summary: OutsideSummary | null
  arrived: Change[]
  clearArrived: () => void
  /** Every outside source (never readers) with changes waiting anywhere in the collection: for Accept all / Decline all from one source. */
  sources: OutsideSourceRow[]
  /** The undecided outside changes of the whole collection. */
  waiting: Change[]
} {
  const [all, setAll] = useState<Change[]>([])
  const [summary, setSummary] = useState<OutsideSummary | null>(null)
  const [arrived, setArrived] = useState<Change[]>([])
  const seen = useRef<Set<string> | null>(null)
  const generation = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const mine = generation.current
    try {
      const [list, next] = await Promise.all([window.writeflex.listChanges({ provenance: 'agent' }), window.writeflex.outsideSummary()])
      if (generation.current !== mine) return
      const outside = list.filter((change) => isFromOutside(change) && !change.snapshotId)
      const undecided = outside.filter(isUndecided)
      const ids = new Set(undecided.map((change) => change.id))
      const before = seen.current
      seen.current = ids
      setAll(outside)
      setSummary(next)
      if (before === null) return // the first look is the baseline, not an arrival
      const decided = [...before].some((id) => !ids.has(id))
      const fresh = undecided.filter((change) => !before.has(change.id))
      setArrived((current) => {
        const kept = decided ? [] : current.filter((change) => ids.has(change.id))
        return fresh.length > 0 ? [...kept, ...fresh] : kept.length === current.length ? current : kept
      })
    } catch {
      // The ledger could not be read: the dock keeps what it had.
    }
  }, [])

  useEffect(() => {
    generation.current += 1
    seen.current = null
    setAll([])
    setSummary(null)
    setArrived([])
    // No workspace open: there is no Change Ledger to ask (main refuses `changes:list` then).
    if (typeof root !== 'string' || root === '') return
    void refresh()
    return window.writeflex.onChangesChanged(() => void refresh())
  }, [refresh, root])

  const [partPaths, setPartPaths] = useState<{ dir: string; paths: string[] } | null>(null)
  useEffect(() => {
    let cancelled = false
    setPartPaths(null)
    if (folioDir === null) return
    const load = (): void => { void window.writeflex.plan.read(folioDir).then(plan => {
      if (!cancelled) setPartPaths({ dir: folioDir, paths: plan?.parts.flatMap(part => part.path ? [part.path] : []) ?? [] })
    }).catch(() => { if (!cancelled) setPartPaths(null) }) }
    load()
    const off = window.writeflex.onCollectionChanged(load)
    return () => { cancelled = true; off() }
  }, [folioDir, root])
  const paths = useMemo(() => new Set([
    ...(folioDir === null && active ? [active] : []),
    ...(folioDir !== null && partPaths?.dir === folioDir ? partPaths.paths : []),
  ]), [active, folioDir, partPaths])
  const others = useMemo(
    () => outsideChangesElsewhere(all, active),
    [all, active],
  )
  const scopedSummary = useMemo(() => scopeOutsideSummary(summary, all, paths), [summary, all, paths])
  const scopedArrived = useMemo(() => arrived.filter(change => paths.has(change.path)), [arrived, paths])
  const clearArrived = useCallback(() => setArrived([]), [])
  const sources = useMemo(() => outsideSourceRows(all), [all])
  const waiting = useMemo(() => all.filter(isUndecided), [all])
  return { others, summary: scopedSummary, arrived: scopedArrived, clearArrived, sources, waiting }
}

/** The dismissed closed-change ids of this Collection. */
export function useDismissedNotApplied(root: string | null | undefined): { ids: ReadonlySet<string>; dismiss: (ids: string[]) => void } {
  const [list, setList] = useState<string[]>([])
  useEffect(() => setList(typeof root === 'string' ? loadDismissed(root) : []), [root])
  const dismiss = useCallback(
    (ids: string[]) => {
      if (typeof root !== 'string' || ids.length === 0) return
      setList((current) => {
        const next = withDismissed(current, ids)
        saveDismissed(root, next)
        return next
      })
    },
    [root],
  )
  const set = useMemo(() => new Set(list), [list])
  return { ids: set, dismiss }
}
