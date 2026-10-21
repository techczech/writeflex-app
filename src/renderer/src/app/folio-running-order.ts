import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { plainErrorForScreen } from '../error-text'
import { chapterSortOrder, inverseOrder, isIdentityOrder } from '../../../shared/folio-chapter-order'
import {
  addedAnnouncement,
  addedFlash,
  folioScope,
  movedAnnouncement,
  movedFlash,
  sortedAnnouncement,
  sortedFlash,
  undoneSortAnnouncement,
  successorOf,
  undoneAddAnnouncement,
  undoneAnnouncement,
  undoStepKeptAmong,
  undoStepUsableOnScreen,
  type PlanOrderResult,
  type PlanPartKey,
  type RunningOrderResult,
  type RunningOrderUndo,
} from '../../../shared/folio-running-order'

/** The Folio as the caller was looking at it: its folder and the running order it saw, with titles for the messages. */
export type FolioSeen = { dir: string; pieces: ReadonlyArray<{ path: string; title: string }> }

export type FlashAction = { label: string; run: () => void }

type Deps = {
  /** The status-bar flash. With an action it stays until the next flash. */
  say: (message: string, action?: FlashAction) => void
  /**
   * Make one request to main for the Folio in `dir`: first every open buffer of that Folio is saved (see
   * shared/folio-write-preparation.ts), then `call` runs through the editor's save queue. When a buffer
   * could not be saved `call` is not run and the answer carries the sentence that names the file.
   */
  write: <T>(dir: string, call: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; message: string }>
  /** The running order on screen is out of date: read it again. */
  refresh: () => void
  /** The open workspace's root, and the folder of the open file's Folio (null = the open file is in no Folio). */
  root: string | null
  openDir: string | null
  /** The folder whose Plan (or Collection) is on screen in place of the editor, or null. A step made there is that Folio's. */
  planDir?: string | null
}

/** The one Undo step, with the Folio it was made in (`folioScope`). */
type HeldUndo = { step: RunningOrderUndo; scope: string }

export type FolioRunningOrder = {
  /** Move one piece before another (null = to the end). */
  movePiece: (seen: FolioSeen, path: string, beforePath: string | null) => Promise<boolean>
  /** Add files to the end of the running order in one step. */
  addPieces: (seen: FolioSeen, files: ReadonlyArray<{ path: string; title: string }>) => Promise<boolean>
  /** The Plan's Sort by chapter number: the parts with a file, in chapter order, in one write and one Undo step (Plan write path). */
  sortPlan: (dir: string, parts: readonly PlanPartKey[], frontMatter?: readonly boolean[]) => Promise<boolean>
  /** The Plan's Add all from this folder: the files at the end, in the order given, in one write and one Undo step (Plan write path). */
  addToPlan: (dir: string, parts: readonly PlanPartKey[], files: ReadonlyArray<{ path: string; title: string }>) => Promise<boolean>
  undo: () => Promise<void>
  /** One request of another Folio write (the Details card's) through the same save of the Folio's open buffers and the editor's save queue. */
  write: Deps['write']
  canUndo: boolean
  /** The live-region text for the last change. */
  announcement: string
  /** The row to put focus on once the Outline has read the change: a tick so the same path can be asked twice. */
  touched: { tick: number; path: string; order: string[] } | null
  /** The pieces the last Add added, tinted until the next change. */
  justAdded: readonly string[]
  /** Forget the Undo step and the tint. Done here whenever another Folio comes on screen; a caller may also ask. */
  clear: () => void
}

/**
 * The renderer's side of a running-order change. It writes nothing itself: each step is one call over the
 * preload bridge, which names pieces by path and the running order the caller saw, and main refuses when
 * that is out of date. This keeps the one Undo step, the flash that offers it and the live-region text.
 *
 * The Undo step belongs to the Folio it was made in (workspace root and folder): the open file's Folio for
 * an Outline change, the Plan's folder for a Plan change. A Folio is on screen when it is the open file's
 * Folio or the one whose Plan is shown. The step is dropped when only other Folios are on screen, it is
 * offered and run only while its own Folio is on screen (and, while a Plan is shown, only when it is the
 * Plan's Folio: the Plan covers the Outline), and an answer from main that arrives after another
 * Folio came on screen does not put a step back.
 */
export function useFolioRunningOrder({ say, write, refresh, root, openDir, planDir = null }: Deps): FolioRunningOrder {
  const [announcement, setAnnouncement] = useState('')
  const [touched, setTouched] = useState<{ tick: number; path: string; order: string[] } | null>(null)
  const [justAdded, setJustAdded] = useState<readonly string[]>([])
  const [undoStep, setUndoStep] = useState<HeldUndo | null>(null)
  const undoRef = useRef<HeldUndo | null>(null)
  const openScopes = [openDir, planDir].flatMap((dir) => (dir === null ? [] : [folioScope(root, dir)]))
  const openScopesKey = openScopes.join('\u0001')
  // Read by answers that arrive later: the Folios on screen at that moment, not when the request was made.
  const openScopesRef = useRef(openScopes)
  openScopesRef.current = openScopes
  // While a Plan is shown it covers the Outline: only the Plan's own Folio may be undone (`undoStepUsableOnScreen`).
  const outlineScope = openDir === null ? null : folioScope(root, openDir)
  const planScope = planDir === null ? null : folioScope(root, planDir)
  const usableScopesRef = useRef({ outlineScope, planScope })
  usableScopesRef.current = { outlineScope, planScope }
  const rootRef = useRef(root)
  rootRef.current = root
  const busy = useRef(false)
  const tick = useRef(0)

  /** Keep `step` as the Undo step of the Folio `scope`, unless another Folio is on screen by now (then there is none). */
  const remember = useCallback((step: RunningOrderUndo | null, scope = '') => {
    const held = step && undoStepKeptAmong(scope, openScopesRef.current) ? { step, scope } : null
    undoRef.current = held
    setUndoStep(held)
  }, [])
  const touch = useCallback((path: string, order: string[]) => { tick.current += 1; setTouched({ tick: tick.current, path, order }) }, [])
  const tell = useCallback((message: string, action?: FlashAction) => { say(message, action); setAnnouncement(message) }, [say])

  const guarded = useCallback(async (step: () => Promise<boolean>): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    try {
      return await step()
    } catch (error) {
      tell(plainErrorForScreen(error, 'Could not change the running order.'))
      refresh()
      return false
    } finally {
      busy.current = false
    }
  }, [refresh, tell])

  const undo = useCallback(async (): Promise<void> => {
    const held = undoRef.current
    if (!held) return
    // Only in its own Folio: an Undo asked while another Folio (or none) is on screen changes nothing.
    if (!undoStepUsableOnScreen(held.scope, usableScopesRef.current.outlineScope, usableScopesRef.current.planScope)) return
    const { step } = held
    await guarded(async () => {
      const bridge = window.writeflex.folioRunningOrder
      const plan = window.writeflex.plan
      const asked = await write<RunningOrderResult | PlanOrderResult>(step.dir, () => (step.kind === 'move'
        ? bridge.movePiece(step.dir, step.path, step.before, step.after)
        : step.kind === 'add'
          ? bridge.removeAdded(step.dir, step.token)
          : step.kind === 'plan-reorder'
            ? plan.reorderParts(step.dir, step.order, step.after)
            : plan.removeAdded(step.dir, step.token)))
      if (!asked.ok) { tell(`${asked.message} The change was not undone.`); return false }
      const result = asked.value
      refresh()
      if (!result.ok) {
        // Main's own sentence is shown. An Undo of an Add is all or nothing (folio-add-undo.ts): nothing was written.
        tell(result.message)
        if (result.stale) remember(null)
        return false
      }
      remember(null)
      setJustAdded([])
      if (step.kind === 'move' && 'order' in result) {
        tell(undoneAnnouncement(step.title, result.order.indexOf(step.path) + 1, result.order.length))
        touch(step.path, result.order)
      } else if (step.kind === 'plan-reorder') {
        tell(undoneSortAnnouncement)
      } else if (step.kind === 'add' || step.kind === 'plan-add') {
        tell(undoneAddAnnouncement(step.paths.length))
      }
      return true
    })
  }, [guarded, refresh, remember, write, tell, touch])

  const movePiece = useCallback((seen: FolioSeen, path: string, beforePath: string | null): Promise<boolean> => guarded(async () => {
    const expected = seen.pieces.map((piece) => piece.path)
    const scope = folioScope(rootRef.current, seen.dir)
    const asked = await write(seen.dir, () => window.writeflex.folioRunningOrder.movePiece(seen.dir, path, beforePath, expected))
    if (!asked.ok) { tell(`${asked.message} The piece was not moved.`); return false }
    const result = asked.value
    if (!result.ok) { tell(result.message); refresh(); return false }
    if (!result.changed) return true
    const title = seen.pieces.find((piece) => piece.path === path)?.title ?? path
    const position = result.order.indexOf(path) + 1
    remember({ kind: 'move', dir: seen.dir, path, title, before: successorOf(expected, path), after: result.order }, scope)
    setJustAdded([])
    refresh()
    say(movedFlash(title, position, result.order.length), { label: 'Undo', run: () => { void undo() } })
    setAnnouncement(movedAnnouncement(title, position, result.order.length))
    touch(path, result.order)
    return true
  }), [guarded, refresh, remember, write, say, tell, touch, undo])

  const addPieces = useCallback((seen: FolioSeen, files: ReadonlyArray<{ path: string; title: string }>): Promise<boolean> => guarded(async () => {
    if (files.length === 0) return false
    const expected = seen.pieces.map((piece) => piece.path)
    const paths = files.map((file) => file.path)
    const scope = folioScope(rootRef.current, seen.dir)
    const asked = await write(seen.dir, () => window.writeflex.folioRunningOrder.addPieces(seen.dir, paths, expected))
    if (!asked.ok) { tell(`${asked.message} Nothing was added.`); return false }
    const result = asked.value
    if (!result.ok) { tell(result.message); refresh(); return false }
    // Files main did not add (no running-order line can name them) are named in `note`; the rest went in.
    const skipped = new Set(result.skipped ?? [])
    const taken = files.filter((file) => !skipped.has(file.path))
    const addedPaths = taken.map((file) => file.path)
    const titles = taken.map((file) => file.title)
    // The Undo names this Add's token: main undoes exactly this Add, or nothing.
    remember(result.undoToken ? { kind: 'add', dir: seen.dir, paths: addedPaths, titles, after: result.order, token: result.undoToken } : null, scope)
    setJustAdded(addedPaths)
    refresh()
    say(result.note ? `${addedFlash(titles)}. ${result.note}` : addedFlash(titles), result.undoToken ? { label: 'Undo', run: () => { void undo() } } : undefined)
    setAnnouncement(`${addedAnnouncement(titles, result.order.indexOf(addedPaths[0]) + 1, result.order.length)}${result.note ? ` ${result.note}` : ''}`)
    touch(addedPaths[0], result.order)
    return true
  }), [guarded, refresh, remember, write, say, tell, touch, undo])

  const sortPlan = useCallback((dir: string, parts: readonly PlanPartKey[], frontMatter?: readonly boolean[]): Promise<boolean> => guarded(async () => {
    // Front matter and contents are each sorted in place: the sort never moves a part across the boundary (ADR-0046).
    const order = chapterSortOrder(parts.map((part) => part.path), frontMatter)
    if (isIdentityOrder(order)) { tell('The running order is already in chapter order.'); return true }
    const expected = [...parts]
    const scope = folioScope(rootRef.current, dir)
    const asked = await write(dir, () => window.writeflex.plan.reorderParts(dir, order, expected))
    if (!asked.ok) { tell(`${asked.message} The running order was not sorted.`); return false }
    const result = asked.value
    if (!result.ok) { tell(result.message); refresh(); return false }
    if (!result.changed) return true
    const sorted = expected.filter((part) => part.path !== null).length
    remember({ kind: 'plan-reorder', dir, order: inverseOrder(order), after: result.parts }, scope)
    setJustAdded([])
    refresh()
    say(sortedFlash(sorted), { label: 'Undo', run: () => { void undo() } })
    setAnnouncement(sortedAnnouncement(sorted))
    return true
  }), [guarded, refresh, remember, write, say, tell, undo])

  const addToPlan = useCallback((dir: string, parts: readonly PlanPartKey[], files: ReadonlyArray<{ path: string; title: string }>): Promise<boolean> => guarded(async () => {
    if (files.length === 0) return false
    const paths = files.map((file) => file.path)
    const scope = folioScope(rootRef.current, dir)
    const asked = await write(dir, () => window.writeflex.plan.addParts(dir, paths, [...parts]))
    if (!asked.ok) { tell(`${asked.message} Nothing was added.`); return false }
    const result = asked.value
    if (!result.ok) { tell(result.message); refresh(); return false }
    // Files main did not add (no running-order line can name them) are named in `note`; the rest went in.
    const skipped = new Set(result.skipped ?? [])
    const taken = files.filter((file) => !skipped.has(file.path))
    const addedPaths = taken.map((file) => file.path)
    const titles = taken.map((file) => file.title)
    remember(result.undoToken ? { kind: 'plan-add', dir, paths: addedPaths, titles, after: result.parts, token: result.undoToken } : null, scope)
    setJustAdded([])
    refresh()
    say(result.note ? `${addedFlash(titles)}. ${result.note}` : addedFlash(titles), result.undoToken ? { label: 'Undo', run: () => { void undo() } } : undefined)
    setAnnouncement(`${addedAnnouncement(titles, result.parts.findIndex((part) => part.path === addedPaths[0]) + 1, result.parts.length)}${result.note ? ` ${result.note}` : ''}`)
    return true
  }), [guarded, refresh, remember, write, say, tell, undo])

  const clear = useCallback(() => { remember(null); setJustAdded([]) }, [remember])

  // Another Folio came on screen: its Outline must not offer, tint or run the step made in the one before.
  useEffect(() => {
    if (undoRef.current && !undoStepKeptAmong(undoRef.current.scope, openScopesRef.current)) clear()
  }, [openScopesKey, clear])

  const canUndo = undoStep !== null && undoStepUsableOnScreen(undoStep.scope, outlineScope, planScope)
  return useMemo(
    () => ({ movePiece, addPieces, sortPlan, addToPlan, undo, write, canUndo, announcement, touched, justAdded, clear }),
    [movePiece, addPieces, sortPlan, addToPlan, undo, write, canUndo, announcement, touched, justAdded, clear],
  )
}

