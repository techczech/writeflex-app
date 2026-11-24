/**
 * The changed-on-disk notices ("this file changed on disk under your buffer"): which path has one, when it
 * is raised, cleared or moved, and the writer's answers to it (Reload, Keep mine, Merge). Upkeep ticket 13:
 * moved out of App.tsx unchanged in behaviour.
 *
 * Two layers:
 *   - plain transitions over the notice map and the decisions about it (no React), tested directly
 *     (tests/main/disk-notices.test.ts);
 *   - `useDiskNoticeStore` (the map, as a ref the save seam reads in the turn a notice is raised, and as
 *     React state for rendering) and `useDiskNotices` (the actions, bound to App's owner, editor and
 *     overlay guard). The store is its own hook because App's save seam and document owner are built
 *     before the actions' dependencies exist.
 *
 * The rule a save asks of a notice is `mayWriteUnderDiskNotice` (editor/reconcile.ts), unchanged.
 * Design: docs/plans/saving-over-an-outside-change/spec-save-only-over-the-version-you-saw.md.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { Transaction } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import type { ConflictPick } from '../../../shared/three-way-merge'
import type { EditorHandle } from '../components/EditorPane'
import { diskNoticeRefusalMessage, keepMineWrites, minimalReplace, noticeAfterRefusal, refusalMayReload, sameDiskNotice, type ExternalDiskNotice } from '../editor/reconcile'
import type { OverlayGuard } from '../hooks/useOverlayGuard'
import { applyDiskMerge, beginDiskMerge, diskMergeMessage, type DiskMergeSession } from './disk-merge'
import type { DocumentOwner, OutsideOutcome } from './document-owner'
import type { unsaved as unsavedRegistry } from './unsaved-text'

export type DiskNotices = ReadonlyMap<string, ExternalDiskNotice>

// ── Plain transitions ─────────────────────────────────────────────────────────────────────────────

/** The map with `notice` standing for `path` (a new map). */
export function withNotice(notices: DiskNotices, path: string, notice: ExternalDiskNotice): Map<string, ExternalDiskNotice> {
  return new Map(notices).set(path, notice)
}

/** The map without a notice for `path`; the same map when there was none. */
export function withoutNotice(notices: DiskNotices, path: string): DiskNotices {
  if (!notices.has(path)) return notices
  const next = new Map(notices)
  next.delete(path)
  return next
}

/** A rename or move by the app: the same notice object (so a Keep mine on it stays its answer) now stands
 *  for `to`, and none is left on `from`. The same map when `from` has none or nothing moved. */
export function movedNotice(notices: DiskNotices, from: string, to: string): DiskNotices {
  const notice = notices.get(from)
  if (!notice || from === to) return notices
  return withNotice(withoutNotice(notices, from), to, notice)
}

/** Paths whose notice must go: neither open in a tab nor listed in the tree. A notice must not stop the saves
 *  of a file made at that path later. */
export function stalePaths(notices: DiskNotices, open: readonly string[], listed: ReadonlySet<string>): string[] {
  return [...notices.keys()].filter((path) => !open.includes(path) && !listed.has(path))
}

/**
 * What the app does for the owner's answer to a read of the disk (the watcher's, a refused write's, a file
 * main returned). `notice`: 'clear' the standing notice, 'keep' it as it is, or raise this one. `cancelAutosave`:
 * freeze the pending automatic write. `replaced`: the buffer took the disk version. Null: nothing at all (a tab
 * not yet live; activation's own disk read seeds it).
 */
export type OutsideStep = { notice: 'clear' | 'keep' | ExternalDiskNotice; cancelAutosave: boolean; replaced: boolean }

export function stepForOutside(standing: ExternalDiskNotice | undefined, outcome: OutsideOutcome): OutsideStep | null {
  switch (outcome.kind) {
    case 'skipped': return null
    // Cloud providers may echo WriteFlex's own save long after the watcher's time window. If the bytes already
    // match the live buffer (or its saved baseline), this event is a complete no-op beyond dropping a notice.
    case 'none':
    // The disk holds the buffer's own document in another form (or the buffer caught up with it).
    case 'adopted': return { notice: 'clear', cancelAutosave: false, replaced: false }
    case 'replaced': return { notice: 'clear', cancelAutosave: false, replaced: true }
    case 'conflict':
      // The other version stays on disk until the writer chooses Reload or Keep mine. The same version as the
      // banner already up: that notice stays (a Keep mine clicked on it stays its answer).
      return { notice: noticeAfterOutsideWrite(standing, outcome.diskText) ?? 'keep', cancelAutosave: true, replaced: false }
    case 'removed': {
      // A file gone from disk is a question whether or not the buffer held unsaved text: no automatic write
      // recreates it until the writer chooses Keep mine (reconcile.ts, mayWriteUnderDiskNotice).
      const raise = !sameDiskNotice(standing, 'removed', null) || (outcome.dirty && !standing?.dirty)
      return { notice: raise ? { kind: 'removed', dirty: outcome.dirty, diskText: null } : 'keep', cancelAutosave: true, replaced: false }
    }
  }
}

/** The notice to raise when the disk holds `diskText` under a buffer with the writer's text, or null when the
 *  one standing is already for exactly that text (it stays, with any answer given to it). */
export function noticeAfterOutsideWrite(standing: ExternalDiskNotice | undefined, diskText: string): ExternalDiskNotice | null {
  return sameDiskNotice(standing, 'changed', diskText) ? null : { kind: 'changed', dirty: true, diskText }
}

/** Whether the Merge sheet still answers the notice it was opened for: it is dropped when another overlay
 *  replaced it, when its tab is no longer the one shown, or ('stale') when the disk moved again under it. */
export function mergeSheetVerdict(input: { session: DiskMergeSession; overlayActive: string | null; active: string | null; notices: DiskNotices }): 'stays' | 'replaced' | 'left' | 'stale' {
  if (input.overlayActive !== 'diskMerge') return 'replaced'
  if (input.active !== input.session.path) return 'left'
  return input.notices.get(input.session.path) !== input.session.notice ? 'stale' : 'stays'
}

// ── React bindings ────────────────────────────────────────────────────────────────────────────────

export type DiskNoticeStore = {
  /** What the save seam reads (writePath): it holds a notice from the turn it is raised, before React renders it. */
  ref: MutableRefObject<Map<string, ExternalDiskNotice>>
  /** The same notices, for rendering. */
  notices: DiskNotices
  setNotices: Dispatch<SetStateAction<DiskNotices>>
}

export function useDiskNoticeStore(): DiskNoticeStore {
  const ref = useRef(new Map<string, ExternalDiskNotice>())
  const [notices, setNotices] = useState<DiskNotices>(() => new Map())
  return { ref, notices, setNotices }
}

/** A ref this module only reads (what it holds may be a mutable collection). */
type Ref<T> = { readonly current: T }

export type DiskNoticeDeps = {
  owner: DocumentOwner
  unsaved: typeof unsavedRegistry
  tabs: readonly string[]
  tabsRef: Ref<readonly string[]>
  /** The files the tree lists (its identity changes only when the list does). */
  files: ReadonlyArray<{ path: string }>
  active: string | null
  activeRef: Ref<string | null>
  editorRef: Ref<EditorHandle | null>
  loadedPath: Ref<string | null>
  /** The path whose own "changed just after it was saved" line the callers' "could not save" lines give way to. */
  guardRefusalPath: MutableRefObject<string | null>
  refusalReasons: Ref<Map<string, string>>
  uncheckpointed: Ref<Set<string>>
  overlay: Pick<OverlayGuard, 'active' | 'open' | 'close' | 'hold'>
  bufferNow: (path: string) => string | null
  savePath: (path: string, answered?: ExternalDiskNotice) => Promise<boolean>
  cancelAutosaveFor: (path: string) => void
  queueLiveCompareRefresh: (path: string) => void
  /** The buffer took the disk version: rendered saved state moves on. */
  bumpSaved: () => void
  flash: (message: string) => void
}

export function useDiskNotices(store: DiskNoticeStore, deps: DiskNoticeDeps) {
  const { ref: noticesRef, notices, setNotices } = store
  const { owner, unsaved, tabs, tabsRef, files, active, activeRef, editorRef, loadedPath, guardRefusalPath, refusalReasons, uncheckpointed, bufferNow, savePath, cancelAutosaveFor, queueLiveCompareRefresh, bumpSaved, flash } = deps
  const { active: overlayActive, open: openOverlay, close: closeOverlay, hold: holdOverlay } = deps.overlay

  const clear = useCallback((path: string) => {
    noticesRef.current.delete(path)
    if (guardRefusalPath.current === path) guardRefusalPath.current = null
    setNotices((current) => withoutNotice(current, path))
  }, [noticesRef, guardRefusalPath, setNotices])
  // The ref first: the save seam reads it from this turn on, before React renders the notice.
  const raise = useCallback((path: string, notice: ExternalDiskNotice) => {
    noticesRef.current.set(path, notice)
    setNotices((current) => withNotice(current, path, notice))
  }, [noticesRef, setNotices])
  const move = useCallback((from: string, to: string) => {
    const notice = noticesRef.current.get(from)
    if (!notice || from === to) return
    clear(from)
    raise(to, notice)
  }, [noticesRef, clear, raise])
  // A notice is dropped with its tab. A tab also closes when its file leaves the tree (useTabs prunes it on
  // a removal). (A rename's notice has moved on first; the new path is listed before its tab opens.)
  useEffect(() => {
    for (const path of stalePaths(noticesRef.current, tabs, new Set(files.map((file) => file.path)))) clear(path)
  }, [tabs, files, noticesRef, clear])

  // What the app raises for the owner's answer to a read of the disk (the watcher's, and a file main
  // returned after writing it: reconcileAppliedFile).
  const raiseForOutside = useCallback((path: string, outcome: OutsideOutcome): void => {
    const step = stepForOutside(noticesRef.current.get(path), outcome)
    if (!step) return
    if (step.cancelAutosave) cancelAutosaveFor(path)
    if (step.notice === 'clear') clear(path)
    else if (step.notice !== 'keep') raise(path, step.notice)
    if (step.replaced) {
      bumpSaved()
      queueLiveCompareRefresh(path)
    }
  }, [noticesRef, cancelAutosaveFor, clear, raise, bumpSaved, queueLiveCompareRefresh])

  // The watcher (and a refused save over a clean buffer) asks the owner to apply what is on disk now. It
  // runs in the path's queue, after any route holding it (document-owner.ts); the owner replaces a buffer
  // only when it is saved, and says what the app should raise. `now`: from inside a hold (a Folio
  // running-order write's own reconcile), where queueing behind that hold would wait for itself.
  const reconcile = useCallback(async (paths: string[], options: { now?: boolean } = {}): Promise<void> => {
    await Promise.all(paths.map(async (path) => {
      if (!tabsRef.current.includes(path)) return
      const outcome = await owner.applyOutside(path, async () => (await window.writeflex.readFile(path)).content, options)
      if (!tabsRef.current.includes(path)) return
      raiseForOutside(path, outcome)
    }))
  }, [owner, tabsRef, raiseForOutside])

  // Main refused a write because the file changed after main read it (an accept's refusal): the owner reads
  // the disk and the writer is asked with the notice, whatever the watcher delivers (it holds events back
  // for a while after a write of ours). Final review round 2, finding 2.
  const askAboutRefusedWrite = useCallback(async (path: string, options: { now: boolean }): Promise<void> => {
    if (!tabsRef.current.includes(path)) return
    const outcome = await owner.refusedOnDisk(path, async () => (await window.writeflex.readFile(path)).content, options)
    if (!tabsRef.current.includes(path)) return
    raiseForOutside(path, outcome)
  }, [owner, tabsRef, raiseForOutside])

  // Main refused a write: the disk no longer holds the version the buffer was based on (its basis). The
  // buffer is kept and the writer is asked, as for any outside change; automatic saves stop. A buffer with
  // nothing unsaved simply takes the disk version, as the watcher would give it.
  // "Nothing unsaved" needs the baseline to be known: after a write of unknown outcome it is not (Sol M2),
  // and the buffer is replaced only by the writer's choice.
  const noteDiskChangedUnderBuffer = useCallback((path: string, diskText: string | null, buffer: string, answering?: ExternalDiskNotice) => {
    cancelAutosaveFor(path)
    const baseline = owner.baselineOf(path)
    if (refusalMayReload({ baseline, buffer, diskUnknown: unsaved.diskIsUnknown(path), answering }) && owner.unchangedSinceSave(path)) {
      void reconcile([path])
      return
    }
    // The notice already up for exactly this disk text stays (a Keep mine clicked on it stays its answer).
    const standing = noticesRef.current.get(path)
    const notice = noticeAfterRefusal(standing, diskText, answering)
    if (notice !== standing) raise(path, notice)
    const message = diskNoticeRefusalMessage(path, notice)
    refusalReasons.current.set(path, message)
    flash(message)
  }, [owner, unsaved, noticesRef, refusalReasons, cancelAutosaveFor, flash, raise, reconcile])

  // A write was made and the file read back holds other text: another program wrote it between the
  // commit and the readback. The buffer stays based on what was written, and the writer is asked
  // whether or not the buffer has typing since: their text was replaced on disk without their seeing it.
  const noteOutsideAfterWrite = useCallback((path: string, diskText: string) => {
    cancelAutosaveFor(path)
    const notice = noticeAfterOutsideWrite(noticesRef.current.get(path), diskText)
    if (notice) raise(path, notice)
    const name = path.split('/').at(-1) ?? path
    const message = `${name} was changed on disk by another program just after it was saved. Choose Reload or Keep mine above the text.`
    guardRefusalPath.current = path // the callers' own "could not save" lines give way to this one
    refusalReasons.current.set(path, message)
    flash(message)
  }, [noticesRef, guardRefusalPath, refusalReasons, cancelAutosaveFor, flash, raise])

  useEffect(
    () => window.writeflex.onFileChangedOnDisk((paths) => { void reconcile(paths) }),
    [reconcile],
  )

  const reload = useCallback(async () => {
    const path = activeRef.current
    if (!path) return
    cancelAutosaveFor(path)
    // The writer's choice: the owner replaces the buffer with the disk version, in the path's queue.
    const reloaded = await owner.reload(path, async () => (await window.writeflex.readFile(path)).content)
    if (reloaded.ok) {
      uncheckpointed.current.delete(path)
      clear(path)
      bumpSaved()
      queueLiveCompareRefresh(path)
      flash(`Reloaded ${path} from disk`)
    } else if (reloaded.reason === 'typed') {
      // Typing after Reload was pressed is kept: nothing replaced, the notice stays up for the new text.
      flash(`${path} was not reloaded: you typed after choosing Reload. Choose Reload or Keep mine again.`)
    } else {
      raise(path, { kind: 'removed', dirty: owner.isDirty(path), diskText: null })
      flash(`${path} is no longer on disk`)
    }
  }, [owner, activeRef, uncheckpointed, cancelAutosaveFor, clear, bumpSaved, flash, queueLiveCompareRefresh, raise])

  // "Keep mine": the writer's choice, and the one write a notice over unsaved text lets through. The
  // buffer goes to disk over the other version, as the answer to the notice that was on screen; the
  // notice goes once that write is made, and stays (with the reason in the status bar) if it is not.
  const keepMine = useCallback(async () => {
    const path = activeRef.current
    if (!path) return
    const notice = noticesRef.current.get(path)
    // Keep mine is the writer's explicit choice and is carried out against the notice whatever the dirty
    // dot says now (Sol S5: an undo can clear the dot while the disk holds another version). Only a notice
    // raised over a buffer with nothing unsaved, that still has nothing unsaved, is answered by dismissing it.
    if (keepMineWrites(notice, owner.isDirty(path) || unsaved.textOf(path) !== undefined || !owner.unchangedSinceSave(path))) {
      cancelAutosaveFor(path)
      if (guardRefusalPath.current === path) guardRefusalPath.current = null
      if (!notice || !(await owner.keepMine(path, notice))) {
        if (guardRefusalPath.current !== path) flash(`Could not save ${path.split('/').at(-1) ?? path}. Your version is still only in this tab.`)
        return
      }
      if (noticesRef.current.get(path) !== notice) return // a later outside change: its own notice stands
    }
    clear(path)
    flash(`Kept your version of ${path}`)
  }, [owner, unsaved, activeRef, noticesRef, guardRefusalPath, cancelAutosaveFor, clear, flash])

  // "Merge" (disk-merge.ts): the sheet shows both versions against the one they began from; opening and
  // cancelling it write nothing. Merging keeps exactly the disk version and the writer's (main returns a
  // History receipt for each; with no History nothing is written), writes the writer's over exactly the disk
  // version, then the merged text through the normal save.
  const [diskMerge, setDiskMerge] = useState<DiskMergeSession | null>(null)
  const [diskMergeBusy, setDiskMergeBusy] = useState(false)
  const openMerge = useCallback(() => {
    const path = activeRef.current
    if (!path) return
    const view = editorRef.current?.view()
    // Pending tracked changes (Reviewing) make the editor's text differ from the text that is saved, and
    // the merge is placed into the editor's text: it waits until they are settled.
    if (view && loadedPath.current === path && view.state.doc.toString() !== bufferNow(path)) {
      flash('Settle the tracked changes in this document first, then choose Merge.')
      return
    }
    const session = beginDiskMerge({ path, notice: noticesRef.current.get(path), buffer: bufferNow(path), baseline: owner.baselineOf(path) })
    if (!session) { flash('There is nothing on disk to merge with.'); return }
    cancelAutosaveFor(path)
    setDiskMerge(session)
    // Through the shared overlay guard, as every sheet: it replaces any other overlay, the window's own
    // shortcuts stand down behind it, and an overlay raised over it (⌘, or the palette) dismisses it.
    openOverlay('diskMerge')
  }, [owner, activeRef, editorRef, loadedPath, noticesRef, bufferNow, cancelAutosaveFor, flash, openOverlay])
  const cancelMerge = useCallback(() => {
    setDiskMerge(null)
    closeOverlay()
    editorRef.current?.view()?.focus() // back to the text, where the banner still asks
  }, [editorRef, closeOverlay])
  const runMerge = useCallback(async (session: DiskMergeSession, picks: ConflictPick[]) => {
    setDiskMergeBusy(true)
    // While it writes, the sheet is held up: no other overlay replaces it mid-write.
    holdOverlay(true)
    try {
      const outcome = await applyDiskMerge({
        notice: (p) => noticesRef.current.get(p),
        buffer: bufferNow,
        preserve: (p, text) => window.writeflex.preserveVersion(p, text),
        saved: (p) => ({ editor: owner.baselineOf(p), disk: owner.baselineDiskOf(p) }),
        checkpoint: (p) => window.writeflex.checkpoint(p),
        keepMine: (p, notice) => {
          cancelAutosaveFor(p)
          if (guardRefusalPath.current === p) guardRefusalPath.current = null
          return owner.keepMine(p, notice)
        },
        answered: clear,
        placeMerged: (p, merged) => {
          const view = editorRef.current?.view()
          if (!view || activeRef.current !== p || loadedPath.current !== p || view.state.readOnly) return false
          const doc = view.state.doc.toString()
          if (doc !== bufferNow(p)) return false // tracked changes appeared meanwhile
          const change = minimalReplace(doc, merged)
          if (change) {
            view.dispatch({ changes: change, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.merge')] })
          }
          return true
        },
        save: (p) => savePath(p),
      }, session, picks)
      if (outcome.kind === 'merged') {
        uncheckpointed.current.delete(session.path)
        queueLiveCompareRefresh(session.path)
      }
      holdOverlay(false)
      if (outcome.kind !== 'unresolved') {
        setDiskMerge(null)
        closeOverlay()
        editorRef.current?.view()?.focus()
      }
      const message = diskMergeMessage(session.path, outcome)
      if (message) flash(message)
    } finally {
      holdOverlay(false)
      setDiskMergeBusy(false)
    }
  }, [owner, activeRef, editorRef, loadedPath, noticesRef, guardRefusalPath, uncheckpointed, bufferNow, cancelAutosaveFor, clear, closeOverlay, flash, holdOverlay, queueLiveCompareRefresh, savePath])
  // The sheet answers one document's notice: it closes when that tab is no longer the one shown.
  // It closes too when the disk moves again under it (a newer notice): the merge it shows is out of date.
  // Another overlay raised over it (⌘, or the palette) replaced it in the shared guard: it is dismissed,
  // as Cancel would (nothing written).
  useEffect(() => {
    if (!diskMerge || diskMergeBusy) return
    const verdict = mergeSheetVerdict({ session: diskMerge, overlayActive, active, notices })
    if (verdict === 'stays') return
    setDiskMerge(null)
    if (verdict === 'replaced') return
    closeOverlay()
    if (verdict === 'stale') flash(`${diskMerge.path.split('/').at(-1) ?? diskMerge.path} changed on disk again while you were merging, so nothing was written. Choose Merge again to see the newer version.`)
  }, [active, closeOverlay, diskMerge, diskMergeBusy, notices, flash, overlayActive])

  return {
    clear, raise, move, raiseForOutside, reconcile, askAboutRefusedWrite, noteDiskChangedUnderBuffer, noteOutsideAfterWrite,
    reload, keepMine, diskMerge, diskMergeBusy, openMerge, cancelMerge, runMerge,
  }
}
