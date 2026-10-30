import { createFolioAuthorQueue, openFolioIdentityIfNeeded } from '../../../shared/folio-write-preparation'
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
import { moveOrder, newCardFlash, undoneNewCardAnnouncement, withManifestNote } from '../../../shared/folio-room-order'
import type { RoomAuthoringResult } from '../../../shared/folio-room-authoring'
import type { PlanCardKey } from '../../../shared/folio-running-order'

/** The Folio as the caller was looking at it: its folder and the running order it saw, with titles for the messages. */
export type FolioSeen = { dir: string; pieces: ReadonlyArray<{ path: string; title: string }> }

export type FlashAction = { label: string; run: () => void; kind?: 'folio-order' | 'scratchpad' }

type Deps = {
  /** Hide the preceding notice when another order change starts, without discarding Undo. */
  onChangeStart?: () => void
  /** The status-bar flash. */
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
  openIdentity: (dir: string, force?: boolean) => Promise<boolean>
  /** Move one piece before another (null = to the end). */
  movePiece: (seen: FolioSeen, path: string, beforePath: string | null) => Promise<boolean>
  /** Add files to the end of the running order in one step. */
  addPieces: (seen: FolioSeen, files: ReadonlyArray<{ path: string; title: string }>) => Promise<boolean>
  /** The Plan's Sort by chapter number: the parts with a file, in chapter order, in one write and one Undo step (Plan write path). */
  sortPlan: (dir: string, parts: readonly PlanPartKey[], frontMatter?: readonly boolean[]) => Promise<boolean>
  /** The Plan's Add all from this folder: the files at the end, in the order given, in one write and one Undo step (Plan write path). */
  addToPlan: (dir: string, parts: readonly PlanPartKey[], files: ReadonlyArray<{ path: string; title: string }>) => Promise<boolean>
  /**
   * The Folio room's move (a card or Outline row dragged, ⌥↑↓): the part at `from` to position `to` of `parts` (the
   * running order as the room shows it), in one room order write and one Undo step. Answers the order the write left,
   * or null when nothing was written (refused, or the same place).
   */
  reorderInRoom: (dir: string, parts: readonly PlanPartKey[], order: number[]) => Promise<boolean>
  moveInRoom: (dir: string, parts: readonly PlanPartKey[], from: number, to: number) => Promise<PlanPartKey[] | null>
  /** The Folio room's New card: an unwritten part at the end, one Undo step. Answers the order it left, or null when refused. */
  addRoomCard: (dir: string, parts: readonly PlanPartKey[], title: string) => Promise<PlanPartKey[] | null>
  /**
   * Remove parts from the Folio to the Folio bin (the Folio page's Remove, ADR-0049): one write, no question asked, one
   * Undo step offered in the flash. Answers main's answer, or null when nothing was asked (another change running).
   */
  removeToBin: (dir: string, indices: number[], expected: readonly PlanCardKey[]) => Promise<RoomAuthoringResult | null>
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
export function useFolioRunningOrder({ say, write, refresh, root, openDir, planDir = null, onChangeStart }: Deps): FolioRunningOrder {
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
  const authorQueue = useRef(createFolioAuthorQueue())
  const tick = useRef(0)

  /** Keep `step` as the Undo step of the Folio `scope`, unless another Folio is on screen by now (then there is none). */
  const remember = useCallback((step: RunningOrderUndo | null, scope = '') => {
    const held = step && undoStepKeptAmong(scope, openScopesRef.current) ? { step, scope } : null
    undoRef.current = held
    setUndoStep(held)
  }, [])
  const touch = useCallback((path: string, order: string[]) => { tick.current += 1; setTouched({ tick: tick.current, path, order }) }, [])
  const tell = useCallback((message: string, action?: FlashAction) => { say(message, action); setAnnouncement(message) }, [say])

  const guarded = useCallback((step: () => Promise<boolean>, linking = false): Promise<boolean> => {
    const run = authorQueue.current(async () => {
      onChangeStart?.()
      try { return await step() } catch (error) {
        tell(plainErrorForScreen(error, 'Could not change the running order.'))
        refresh()
        return false
      }
    }, linking)
    return run
  }, [refresh, tell, onChangeStart])

  const undo = useCallback(async (): Promise<void> => {
    await guarded(async () => {
      const held = undoRef.current
      if (!held || !undoStepUsableOnScreen(held.scope, usableScopesRef.current.outlineScope, usableScopesRef.current.planScope)) return false
      const { step } = held
      const bridge = window.writeflex.folioRunningOrder
      const plan = window.writeflex.plan
      const asked = await write<RunningOrderResult | PlanOrderResult | RoomAuthoringResult>(step.dir, () => (step.kind === 'bin'
        ? window.writeflex.folioRoom.author(step.dir, { op: 'undo', token: step.token })
        : step.kind === 'move'
        ? bridge.movePiece(step.dir, step.path, step.before, step.after)
        : step.kind === 'add'
          ? bridge.removeAdded(step.dir, step.token)
          : step.kind === 'plan-reorder'
            ? plan.reorderParts(step.dir, step.order, step.after, step.room ? { room: true } : undefined)
            : step.kind === 'room-card'
              ? plan.roomRemoveCard(step.dir, step.index, step.title, step.after)
              : plan.removeAdded(step.dir, step.token)))
      if (!asked.ok) { tell(`${asked.message} The change was not undone.`); return false }
      const result = asked.value
      refresh()
      if (!result.ok) {
        // Main's own sentence is shown. An Undo of an Add is all or nothing (folio-add-undo.ts): nothing was written.
        tell(result.message)
        if ('stale' in result && result.stale && undoRef.current === held) remember(null)
        return false
      }
      if (undoRef.current === held) remember(null)
      setJustAdded([])
      if (step.kind === 'identity') {
        tell('Undid the Folio’s file links.')
      } else if (step.kind === 'bin') {
        tell(`Put “${step.title}” back in the outline.`)
      } else if (step.kind === 'move' && 'order' in result) {
        tell(undoneAnnouncement(step.title, result.order.indexOf(step.path) + 1, result.order.length))
        touch(step.path, result.order)
      } else if (step.kind === 'plan-reorder' && step.room && step.title !== undefined && 'parts' in result) {
        const back = result.parts.findIndex((part) => part.title === step.title)
        tell(undoneAnnouncement(step.title, back + 1, result.parts.length))
      } else if (step.kind === 'plan-reorder') {
        tell(undoneSortAnnouncement)
      } else if (step.kind === 'room-card') {
        tell(undoneNewCardAnnouncement(step.title))
      } else if (step.kind === 'add' || step.kind === 'plan-add') {
        tell(undoneAddAnnouncement(step.paths.length))
      }
      return true
    })
  }, [guarded, refresh, remember, write, tell, touch])

  useEffect(() => window.writeflex.plan.onIdentityLinked?.(result => {
    if (result.root !== rootRef.current) return
    const scope = folioScope(result.root, result.dir)
    if (result.undoToken) remember({ kind: 'identity', dir: result.dir, token: result.undoToken }, scope)
    refresh()
    tell("WriteFlex now links this Folio's chapters to their files" + (result.warning ? ` — ${result.warning}` : ''), result.undoToken ? { label: 'Undo', run: () => { void undo() } } : undefined)
  }), [refresh, remember, tell, undo])

  const openIdentity = useCallback(async (dir: string, force = false): Promise<boolean> => {
    const capturedRoot = rootRef.current
    if (!capturedRoot) return false
    try { return await openFolioIdentityIfNeeded(
      () => window.writeflex.plan.identityCheck(dir, capturedRoot, force),
      () => guarded(async () => {
      const scope = folioScope(capturedRoot, dir)
      if (rootRef.current !== capturedRoot) return false
      const asked = await write(dir, () => window.writeflex.plan.open(dir, capturedRoot, force))
      if (!asked.ok) { tell(asked.message); return false }
      if (!asked.value.changed) { if (asked.value.warning) tell(asked.value.warning); return true }
      if (asked.value.undoToken) remember({ kind: 'identity', dir, token: asked.value.undoToken }, scope)
      refresh()
      tell("WriteFlex now links this Folio's chapters to their files" + (asked.value.warning ? ` — ${asked.value.warning}` : ''), { label: 'Undo', run: () => { void undo() } })
      return true
      }, true),
    ) } catch (error) { tell(plainErrorForScreen(error, 'Could not check the Folio’s chapter links.')); return false }
  }, [guarded, write, tell, remember, refresh, undo])

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

  const moveInRoom = useCallback(async (dir: string, parts: readonly PlanPartKey[], from: number, to: number): Promise<PlanPartKey[] | null> => {
    const order = moveOrder(parts.length, from, to)
    if (!order) return null
    let left: PlanPartKey[] | null = null
    await guarded(async () => {
      const expected = [...parts]
      const title = expected[from].title
      const scope = folioScope(rootRef.current, dir)
      const asked = await write(dir, () => window.writeflex.plan.reorderParts(dir, order, expected, { room: true }))
      if (!asked.ok) { tell(`${asked.message} The part was not moved.`); return false }
      const result = asked.value
      if (!result.ok) { tell(result.message); refresh(); return false }
      if (!result.changed) return true
      left = result.parts
      const position = result.parts.findIndex((part) => part.title === title) + 1
      remember({ kind: 'plan-reorder', dir, order: inverseOrder(order), after: result.parts, room: true, title }, scope)
      setJustAdded([])
      refresh()
      say(withManifestNote(movedFlash(title, position, result.parts.length), result.manifestCreated, result.notInRunningOrder), { label: 'Undo', run: () => { void undo() } })
      setAnnouncement(withManifestNote(movedAnnouncement(title, position, result.parts.length).replace(/\.$/, ''), result.manifestCreated, result.notInRunningOrder))
      return true
    })
    return left
  }, [guarded, refresh, remember, write, say, tell, undo])

  const reorderInRoom = useCallback(async (dir: string, parts: readonly PlanPartKey[], order: number[]): Promise<boolean> => guarded(async () => {
    const scope = folioScope(rootRef.current, dir)
    const asked = await write(dir, () => window.writeflex.plan.reorderParts(dir, order, [...parts], { room: true, createManifest: true }))
    if (!asked.ok) { tell(asked.message); return false }
    const result = asked.value
    if (!result.ok) { tell(result.message); refresh(); return false }
    if (result.changed) {
      remember({ kind: 'plan-reorder', dir, order: inverseOrder(order), after: result.parts, room: true }, scope)
      setJustAdded([]); refresh()
      say('Wrote the map path to the Folio running order.', { label: 'Undo', run: () => { void undo() } })
      setAnnouncement('Wrote the map path to the Folio running order.')
    }
    return true
  }), [guarded, refresh, remember, write, tell, undo, say])

  const addRoomCard = useCallback(async (dir: string, parts: readonly PlanPartKey[], title: string): Promise<PlanPartKey[] | null> => {
    let left: PlanPartKey[] | null = null
    await guarded(async () => {
      const scope = folioScope(rootRef.current, dir)
      const asked = await write(dir, () => window.writeflex.plan.roomNewCard(dir, title, [...parts]))
      if (!asked.ok) { tell(`${asked.message} Nothing was added.`); return false }
      const result = asked.value
      if (!result.ok) { tell(result.message); if (result.stale) refresh(); return false }
      left = result.parts
      const added = result.parts[result.index]?.title ?? title.trim()
      remember({ kind: 'room-card', dir, index: result.index, title: added, after: result.parts }, scope)
      setJustAdded([])
      refresh()
      const text = withManifestNote(newCardFlash(added, result.index + 1, result.parts.length), result.manifestCreated, result.notInRunningOrder)
      say(text, { label: 'Undo', run: () => { void undo() } })
      setAnnouncement(text)
      return true
    })
    return left
  }, [guarded, refresh, remember, write, say, tell, undo])

  const removeToBin = useCallback(async (dir: string, indices: number[], expected: readonly PlanCardKey[]): Promise<RoomAuthoringResult | null> => {
    let answer: RoomAuthoringResult | null = null
    await guarded(async () => {
      const scope = folioScope(rootRef.current, dir)
      const asked = await write(dir, () => window.writeflex.folioRoom.author(dir, { op: 'remove', indices, expected: [...expected] }))
      answer = asked.ok ? asked.value : { ok: false, message: `${asked.message} Nothing was removed.` }
      refresh()
      if (!answer.ok) { tell(answer.message); return false }
      const title = answer.removed?.length === 1 ? answer.removed[0].title : `${answer.removed?.length ?? indices.length} parts`
      if (answer.token) {
        remember({ kind: 'bin', dir, token: answer.token, title }, scope)
        say(answer.message, { label: 'Undo', run: () => { void undo() } })
        setAnnouncement(answer.message)
      } else tell(answer.message)
      setJustAdded([])
      return true
    })
    return answer
  }, [guarded, refresh, remember, write, say, tell, undo])

  const clear = useCallback(() => { remember(null); setJustAdded([]) }, [remember])

  // Another Folio came on screen: its Outline must not offer, tint or run the step made in the one before.
  useEffect(() => {
    if (undoRef.current && !undoStepKeptAmong(undoRef.current.scope, openScopesRef.current)) clear()
  }, [openScopesKey, clear])

  const canUndo = undoStep !== null && undoStepUsableOnScreen(undoStep.scope, outlineScope, planScope)
  return useMemo(
    () => ({ openIdentity, movePiece, addPieces, sortPlan, addToPlan, moveInRoom, reorderInRoom, addRoomCard, removeToBin, undo, write, canUndo, announcement, touched, justAdded, clear }),
    [openIdentity, movePiece, addPieces, sortPlan, addToPlan, moveInRoom, reorderInRoom, addRoomCard, removeToBin, undo, write, canUndo, announcement, touched, justAdded, clear],
  )
}

