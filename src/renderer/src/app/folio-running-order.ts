import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { plainErrorForScreen } from '../error-text'
import {
  addedAnnouncement,
  addedFlash,
  folioScope,
  movedAnnouncement,
  movedFlash,
  successorOf,
  undoneAddAnnouncement,
  undoneAnnouncement,
  undoStepKept,
  undoStepUsable,
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
  /** The open workspace's root, and the folder of the Folio on screen (null = the open file is in no Folio). */
  root: string | null
  openDir: string | null
}

/** The one Undo step, with the Folio it was made in (`folioScope`). */
type HeldUndo = { step: RunningOrderUndo; scope: string }

export type FolioRunningOrder = {
  /** Move one piece before another (null = to the end). */
  movePiece: (seen: FolioSeen, path: string, beforePath: string | null) => Promise<boolean>
  /** Add files to the end of the running order in one step. */
  addPieces: (seen: FolioSeen, files: ReadonlyArray<{ path: string; title: string }>) => Promise<boolean>
  undo: () => Promise<void>
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
 * The Undo step belongs to the Folio it was made in (workspace root and folder). It is dropped when another
 * Folio comes on screen, it is offered and run only while its own Folio is on screen, and an answer from
 * main that arrives after another Folio came on screen does not put a step back.
 */
export function useFolioRunningOrder({ say, write, refresh, root, openDir }: Deps): FolioRunningOrder {
  const [announcement, setAnnouncement] = useState('')
  const [touched, setTouched] = useState<{ tick: number; path: string; order: string[] } | null>(null)
  const [justAdded, setJustAdded] = useState<readonly string[]>([])
  const [undoStep, setUndoStep] = useState<HeldUndo | null>(null)
  const undoRef = useRef<HeldUndo | null>(null)
  const openScope = openDir === null ? null : folioScope(root, openDir)
  // Read by answers that arrive later: the Folio on screen at that moment, not when the request was made.
  const openScopeRef = useRef(openScope)
  openScopeRef.current = openScope
  const rootRef = useRef(root)
  rootRef.current = root
  const busy = useRef(false)
  const tick = useRef(0)

  /** Keep `step` as the Undo step of the Folio `scope`, unless another Folio is on screen by now (then there is none). */
  const remember = useCallback((step: RunningOrderUndo | null, scope = '') => {
    const held = step && undoStepKept(scope, openScopeRef.current) ? { step, scope } : null
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
    if (!undoStepUsable(held.scope, openScopeRef.current)) return
    const { step, scope } = held
    await guarded(async () => {
      const bridge = window.writeflex.folioRunningOrder
      const asked = await write(step.dir, () => (step.kind === 'move'
        ? bridge.movePiece(step.dir, step.path, step.before, step.after)
        : bridge.removeAdded(step.dir, step.paths, step.after)))
      if (!asked.ok) { tell(`${asked.message} The change was not undone.`); return false }
      const result = asked.value
      refresh()
      if (!result.ok) {
        // Main's own sentence is shown: after an Undo that stopped part-way it says exactly which pieces
        // were taken out and which remain, and the Undo step is kept for the ones that remain.
        tell(result.message)
        if (step.kind === 'add' && result.partial) {
          const { remaining, order } = result.partial
          const titles = remaining.map((path) => step.titles[step.paths.indexOf(path)] ?? path)
          remember(remaining.length ? { kind: 'add', dir: step.dir, paths: remaining, titles, after: order } : null, scope)
          setJustAdded(remaining)
        } else if (result.stale) remember(null)
        return false
      }
      remember(null)
      setJustAdded([])
      if (step.kind === 'move') {
        tell(undoneAnnouncement(step.title, result.order.indexOf(step.path) + 1, result.order.length))
        touch(step.path, result.order)
      } else {
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
    const titles = files.map((file) => file.title)
    remember({ kind: 'add', dir: seen.dir, paths, titles, after: result.order }, scope)
    setJustAdded(paths)
    refresh()
    say(addedFlash(titles), { label: 'Undo', run: () => { void undo() } })
    setAnnouncement(addedAnnouncement(titles, result.order.indexOf(paths[0]) + 1, result.order.length))
    touch(paths[0], result.order)
    return true
  }), [guarded, refresh, remember, write, say, tell, touch, undo])

  const clear = useCallback(() => { remember(null); setJustAdded([]) }, [remember])

  // Another Folio came on screen: its Outline must not offer, tint or run the step made in the one before.
  useEffect(() => {
    if (undoRef.current && !undoStepKept(undoRef.current.scope, openScope)) clear()
  }, [openScope, clear])

  const canUndo = undoStep !== null && undoStepUsable(undoStep.scope, openScope)
  return useMemo(
    () => ({ movePiece, addPieces, undo, canUndo, announcement, touched, justAdded, clear }),
    [movePiece, addPieces, undo, canUndo, announcement, touched, justAdded, clear],
  )
}
