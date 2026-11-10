import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { onEditorUpdate } from '../editor/setup'
import { canonicalSyncPath, nextSyncBoundary, presentSync, SyncSession, type SyncAction, type SyncAdapter, type SyncDocument, type SyncInput, type SyncOperation, type SyncPresentation, type SyncSubscription } from './sync-status'

/** Renderer-only boundary. Subscription lifetime follows the vault, not keystrokes. */
export function useSyncStatus(root: string | null, dirtyPaths: ReadonlySet<string>, savedTick: number, adapter?: SyncAdapter, readEditorDocument?: () => unknown, defaultAdapter?: SyncAdapter) {
  const [testAdapter, setTestAdapter] = useState<SyncAdapter>()
  const selectedAdapter = adapter ?? (window.writeflex.e2eEnabled && window.writeflex.e2eWriteHooks ? testAdapter : undefined) ?? defaultAdapter
  const [scope, setScope] = useState(() => ({ root, adapter: selectedAdapter, session: new SyncSession({ vaultId: root ?? '', epoch: 1, revision: 0 }) }))
  // React's guarded state adjustment discards this render before commit. Epochs
  // advance even when returning to a previously opened vault or adapter.
  if (scope.root !== root || scope.adapter !== selectedAdapter) setScope({ root, adapter: selectedAdapter,
    session: new SyncSession({ vaultId: root ?? '', epoch: scope.session.view.epoch + 1, revision: 0 }) })
  const session = scope.session
  const [version, redraw] = useState(0)
  const [busy, setBusy] = useState<SyncAction | null>(null)
  const activeOperation = useRef<SyncOperation | null>(null)
  const subscription = useRef<{ session: SyncSession; port: SyncSubscription } | null>(null)
  const [freshnessFailed, setFreshnessFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const updateTimer = useRef<ReturnType<typeof setTimeout>>()
  const requestView = useCallback(() => {
    if (subscription.current?.session !== session || updateTimer.current !== undefined) return
    // Bounded coalescing: continuous typing still requests the latest exact view
    // every 250ms. Invalidation itself must never wait for this timer.
    updateTimer.current = setTimeout(() => {
      updateTimer.current = undefined
      const captured = session.view
      try { if (subscription.current?.session === session) subscription.current.port.updateView(captured) }
      catch { session.invalidate(); setError('Sync status could not be read. Try checking again.'); redraw(n => n + 1) }
    }, 250)
  }, [session])
  const invalidate = useCallback(() => {
    const visibleChange = (!session.stale && session.current !== null) || session.invalid
    session.reset({ ...session.view, revision: session.view.revision + 1 })
    requestView()
    if (visibleChange) { setFreshnessFailed(false); setError(null); redraw(n => n + 1) }
  }, [session, requestView])
  // Commit-phase invalidation precedes paint; editor events below invalidate synchronously.
  useLayoutEffect(invalidate, [invalidate, dirtyPaths, savedTick])
  useEffect(() => {
    let lastDocument = readEditorDocument?.()
    return onEditorUpdate(() => {
      const document = readEditorDocument?.()
      if (document === lastDocument) return
      lastDocument = document
      invalidate()
    })
  }, [readEditorDocument, invalidate])
  useEffect(() => {
    if (!window.writeflex.e2eEnabled || !window.writeflex.e2eWriteHooks || !window.__writeflexE2E) return
    const api = window.__writeflexE2E
    api.setSyncAdapter = setTestAdapter
    return () => { delete api.setSyncAdapter }
  }, [])
  useEffect(() => {
    setFreshnessFailed(false); setError(null)
    if (!selectedAdapter || !root) return
    let active = true
    let port: SyncSubscription | undefined
    try {
      port = selectedAdapter.subscribe(session.view, input => {
        if (!active) return
        const accepted = session.publish(input)
        if (accepted || session.invalid) {
          setFreshnessFailed(false)
          setError(session.invalid ? 'Sync status could not be read: invalid or duplicate document/source details. Check again.' : null)
          redraw(n => n + 1)
        }
      })
      if (!port || typeof port.updateView !== 'function' || typeof port.unsubscribe !== 'function') throw new Error('Invalid sync subscription')
      subscription.current = { session, port }
    } catch { session.invalidate(); setError('Sync status could not be read. Try checking again.'); redraw(n => n + 1) }
    return () => {
      active = false
      if (subscription.current?.session === session) subscription.current = null
      session.invalidate()
      clearTimeout(updateTimer.current); updateTimer.current = undefined
      // Disposal is best effort; a broken adapter must not crash the editor.
      try { if (typeof port?.unsubscribe === 'function') port.unsubscribe() } catch { /* old scope is already invalid */ }
    }
  }, [session, root, selectedAdapter])
  const reason = useCallback((action: SyncAction): string | null => {
    if (!root) return 'Sync is not available for this vault yet.'
    if (activeOperation.current) return 'An operation is already in progress.'
    if (action === 'review' && (session.stale || session.invalid)) return 'Document comparison is awaiting current sync details.'
    if (!selectedAdapter?.actions[action]) return action === 'history' ? 'Backup history is not available for this vault yet.'
      : action === 'review' ? 'Document comparison is not available for this vault yet.' : 'Sync is not available for this vault yet.'
    if ((action === 'check' || action === 'syncNow') && session.current !== null && session.current.availability !== 'ready') return 'Sync is not ready for this vault. Check its availability in Sync.'
    return null
  }, [session, selectedAdapter, root])
  const run = useCallback(async (action: SyncAction, document?: SyncDocument) => {
    if (reason(action) || (action === 'review' && (!document || session.stale || session.invalid || !session.current?.documents.includes(document)))) return
    const captured = session.view
    const operation = session.begin()
    activeOperation.current = operation; setBusy(action); setError(null)
    try {
      if (action === 'check' || action === 'syncNow') {
        const result = await selectedAdapter!.actions[action]!(captured)
        if (!session.isCurrent(operation)) return
        if (!session.complete(operation, result)) {
          if (session.isCurrent(operation) || session.invalid) { setFreshnessFailed(true); setError(session.invalid ? 'Sync status could not be read. Check again.' : 'This sync result no longer matches the current view. Check again.'); redraw(n => n + 1) }
          return
        }
        setFreshnessFailed(false); redraw(n => n + 1)
      } else if (action === 'review') await selectedAdapter!.actions.review!({ view: captured, document: document! })
      else await selectedAdapter!.actions.history!(captured)
    } catch {
      if (!session.isCurrent(operation)) return
      if (action === 'check' || action === 'syncNow') setFreshnessFailed(true)
      setError(action === 'history' || action === 'review' ? 'This view could not be opened. Try again.' : 'Sync could not finish. Your local writing remains available.')
    } finally {
      if (activeOperation.current === operation) { activeOperation.current = null; setBusy(null) }
    }
  }, [session, selectedAdapter, reason])
  const current = useMemo<SyncInput>(() => {
    const input = session.current ?? { view: session.view, observation: 0, availability: selectedAdapter && root ? 'ready' : 'unconfigured', connection: 'unknown', automatic: null,
      local: { dirtyPaths: [], complete: false }, backup: null, check: null, documents: [] }
    // Both producers use the same canonical vault-relative path contract.
    const validLocal = [...dirtyPaths].filter(canonicalSyncPath)
    return { ...input, local: { complete: input.local.complete && validLocal.length === dirtyPaths.size,
      dirtyPaths: [...new Set([...input.local.dirtyPaths, ...validLocal])] } }
  }, [session, selectedAdapter, root, dirtyPaths, version])
  const [boundaryNow, setBoundaryNow] = useState(Date.now)
  useEffect(() => {
    const next = nextSyncBoundary(current, Date.now())
    if (next === null) return
    const timer = setTimeout(() => setBoundaryNow(Date.now()), Math.min(next - Date.now(), 2_147_483_647))
    return () => clearTimeout(timer)
  }, [current, boundaryNow])
  const stale = session.stale || session.invalid || freshnessFailed
  const presentation = useMemo(() => decorateSync(presentSync(current, Date.now()), stale, busy, Boolean(selectedAdapter && root) && session.current === null), [current, stale, busy, boundaryNow, selectedAdapter, session, root])
  // Preserve gutter identities when only facts or clocks changed.
  const stableMarks = useRef(presentation.marks)
  const marks = [...presentation.marks].every(([path, row]) => JSON.stringify(stableMarks.current.get(path)) === JSON.stringify(row)) && stableMarks.current.size === presentation.marks.size ? stableMarks.current : presentation.marks
  useLayoutEffect(() => { stableMarks.current = marks }, [marks])
  const stablePresentation = useMemo(() => ({ ...presentation, marks }), [presentation, marks])
  const commandState = (['syncNow', 'check', 'history', 'review'] as const).map(reason).join('\n')
  const coverageExplanation = selectedAdapter?.coverageExplanation?.() ?? null
  return useMemo(() => ({ commandState, presentation: stablePresentation, input: current, stale, busy, error, run, reason, coverageExplanation }), [commandState, stablePresentation, current, stale, busy, error, run, reason, coverageExplanation])
}
function decorateSync(p: SyncPresentation, stale: boolean, busy: SyncAction | null, awaiting: boolean): SyncPresentation {
  if (stale || awaiting) {
    if (p.tone === 'green') p.tone = 'grey'
    p.label = stale ? 'Sync status stale · awaiting observation' : 'Sync status unknown · awaiting observation'
    p.heading = p.label; p.checked += ' · stale'; p.unchangedDocuments = null
    p.description = 'Previous dated facts are last known only. Awaiting an observation matching your current writing.'
    p.groups = p.groups.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row, detail: `${row.detail} · last known, awaiting observation` })) }))
    p.marks = new Map(p.groups.flatMap(group => group.rows.map(row => [row.document.path, row] as const)))
    p.facts = { ...p.facts, backup: `${p.facts.backup} · last known`, branch: `${p.facts.branch} · stale` }
  }
  if (busy === 'check' || busy === 'syncNow') { if (p.tone !== 'red') p.tone = 'blue'; p.label = busy === 'check' ? 'Checking…' : 'Syncing…'; p.heading = p.label }
  return p
}
/** Age/calendar updates stay inside the small status surfaces, never App/commands/Sidebar. */
export function useSyncDisplay(controller: SyncStatusController): SyncPresentation {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const next = nextSyncBoundary(controller.input, Date.now(), true)
    if (next === null) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(1, next - Date.now()), 2_147_483_647))
    return () => clearTimeout(timer)
  }, [controller.input, now])
  return useMemo(() => decorateSync(presentSync(controller.input, Date.now()), controller.stale, controller.busy,
    controller.presentation.label.startsWith('Sync status unknown')), [controller, now])
}
export type SyncStatusController = ReturnType<typeof useSyncStatus>
