/**
 * The document owner (docs/plans/saving-over-an-outside-change/document-owner-plan.md, parcel 1): the one
 * place that decides whether an open document's buffer is saved, and the only one that sets its baseline,
 * its dirty state and its registry entry, or forgets or replaces its buffer.
 *
 * The rule, stated once: a buffer is forgotten, replaced or rebased only here, only when `gen === savedGen`
 * and nothing is in flight, unknown or under a notice; a baseline is only ever set from a receipt main
 * returned for the call that wrote it (or from a read of the disk the buffer then takes).
 *
 * - `gen` counts the editor's changes of the buffer (bumped synchronously by `edited`); `savedGen` is the
 *   `gen` the last confirmed write captured when it read the buffer. Saved-ness is never text equality
 *   with a snapshot; the dirty dot alone is a normalised text comparison, for display.
 * - Every operation on a path runs in that path's queue: a save, a flush, a watcher reconcile, Keep mine.
 *   `withFlushed` flushes, checks, snapshots and then runs the route's action while holding the queue, so
 *   an autosave or a watcher reconcile asked for meanwhile runs after the action, never inside it.
 * - Main's writes of an open document run as routes here too (parcel 2a): accept, goal, restore and clear
 *   in `withFlushed` (an accept with `inOrder`, taking its place in the queue when pressed), a suggestion's
 *   redo and every other resolution of a change in `inQueue`; each takes
 *   main's text only through `replaceFromMain`, from the receipt of that call's own write.
 * - `detach: true` makes the editor read-only for the route's paths in the turn of the final check; the
 *   paths still owned when the action returns are made editable again.
 * - Rename, move and duplicate run in `withFlushed` too (parcel 2b): main moves or copies the file while
 *   the queue is held, so no save of the old path runs between the flush and main's move. `moved` then
 *   takes a resident buffer to the new path in that turn, saved if nothing changed it since the snapshot
 *   and unsaved if it changed (by generation). A folder's routes name their members as a function, asked
 *   again at the final check, and a scope (the folder's prefix).
 * - Membership is path scope over every path the owner has a record of, never tabs, dirty dots or registry
 *   entries (2b round 3 ruling). A folder-scoped route starts only in the turn in which every path the owner
 *   has a record for under the folder is found idle (and saved, or held unwritten under a notice); from that
 *   turn until the route returns, no operation on any path under the folder starts, including on paths the
 *   owner had no record for. Every operation creates a record before it runs, so "every path with a record"
 *   is "every path with work in flight". A document activated under the folder during the route joins it
 *   (snapshot, detach) so its buffer moves with the folder. No two folder-scoped actions with overlapping
 *   prefixes run at once, whatever documents either holds (2b round 3 review, finding 2).
 *
 * Pure: no React, no IPC. Everything goes through the ports.
 */
import { EditorBaselines, isTextChange } from '../../../shared/line-endings'
import type { SaveBasis } from '../../../shared/save-basis'
import { externalContentReconcileAction, type ExternalDiskNotice } from '../editor/reconcile'
import type { UnsavedRegistry } from './unsaved-registry'
import { writeBuffer, type WriteAnswer } from './write-buffer'

/** What the owner says to the rest of the app about one write (App's flash, notices, status chip). */
export type OwnerReports = {
  slow(path: string, slow: boolean): void
  refusedByNotice(path: string, message: string): void
  refusedByMain(path: string, message: string): void
  diskChanged(path: string, diskText: string | null, buffer: string, answering?: ExternalDiskNotice): void
  /** `changed`: the write put other bytes on disk than the version it was based on. */
  saved(path: string, changed: boolean): void
  outsideAfterWrite(path: string, diskText: string): void
  unknown(path: string): void
}

export type DocumentOwnerPorts = {
  /** The buffer as it is now. `undefined`: no editor at all (unmounted by an error); null: not resident. */
  buffer(path: string): string | null | undefined
  /** The notice standing for the path now, if any (App raises and clears them; the owner reads them). */
  notice(path: string): ExternalDiskNotice | undefined
  registry: Pick<UnsavedRegistry, 'typed' | 'matchesDisk' | 'discard' | 'beginWrite' | 'textOf' | 'busy' | 'settled' | 'diskIsUnknown'>
  /** Main's file:save. */
  write(path: string, doc: string, basis: SaveBasis): Promise<WriteAnswer>
  /** e2e only: what the harness does before a save reaches main (hold it, fail it). */
  beforeSave?(): Promise<void>
  /** The editor read-only (true) or editable (false) for these paths, in this turn. */
  setReadOnly(paths: readonly string[], readOnly: boolean): void
  /** The editor drops its state for the path. */
  forgetBuffer(path: string): void
  /** The editor's state for `from` (its buffer, undo history, read-only flag) now belongs to `to`. */
  renameBuffer(from: string, to: string): void
  /** The editor's buffer for the path takes this disk text, silently (no `edited`). `discardLocal`: the
   *  writer's own Reload, which drops pending track changes too. */
  replaceBuffer(path: string, diskText: string, discardLocal?: boolean): void
  /** The dirty dots changed: the set as it is now. */
  dirtyChanged(paths: ReadonlySet<string>): void
  report: OwnerReports
}

type DocumentRecord = {
  gen: number
  savedGen: number
  diskUnknown: boolean
  /** Writes of this document in flight (the owner's own). */
  inflight: number
  /** Operations queued or running (a hold counts as one). */
  pending: number
  queue: Promise<unknown>
  /** The gen snapshotted by the hold now standing, if any. */
  heldGen?: number
}

export type FlushOutcome = { status: 'refused'; path: string } | { status: 'still-unsaved'; path: string }
export type Snapshot = { path: string; text: string | null; baselineDisk: string | undefined; gen: number }
export type WithFlushedResult<T> =
  | { status: 'acted'; result: T; moved: string[] }
  | FlushOutcome

export type WithFlushedOptions = {
  /** Make the editor read-only for the paths in the turn of the final check (forget routes). */
  detach?: boolean
  /** How many times new typing may send the flush round again before the route gives up. */
  rounds?: number
  /** Run once every path is written (the close checkpoint), before the final check. A rejection is a
   *  refusal for that path, never a throw (Sol r3 S1: a removed file's checkpoint ENOENT). */
  afterSave?(path: string): Promise<void>
  /**
   * Take the route's place in the paths' queues in the turn it is asked for (an accept, review F2): the
   * flush, the check and the action all run in that place, so every operation asked for before it runs
   * first and every one asked for after it (a Discard pressed next, an autosave) runs after it. Without
   * it the route waits for the queues to empty and then acts, and an operation asked for later can pass it.
   */
  inOrder?: boolean
  /**
   * Of the route's paths, the ones held but not written first, asked of each path at every check (a
   * rename's document under a changed-on-disk notice with nothing typed over its version: it cannot be
   * written until the writer answers, and the notice goes with it to the new name). Only structural routes
   * (rename, move, duplicate) pass it. A held path is still waited for: whatever its queue has asked for
   * (a Keep mine in flight) runs before the hold, never beside it (2b review P1). Ignored with `inOrder`.
   */
  holdOnly?: (path: string) => boolean
  /**
   * The route's folder scope, as a prefix (`f/`), for a folder's rename or trash (2b round 3 ruling). The
   * route's members are then also every path the owner has a record for under the prefix, asked again at
   * the final check; in the turn of the final check a lock on the prefix goes in with the holds, and until
   * the action returns no operation on any path under it starts (`enqueue`, `idle` and `idleNow` honour
   * it), including one on a path the owner had no record for. A document activated under the prefix while
   * the route holds, and not already held, joins the hold in that turn: it is detached when the route
   * detaches, and its snapshot is added to the map the action holds, so the action finds it there when it
   * settles the folder's documents (2b review P2: a buffer opened under the folder during the operation).
   * No two scoped routes whose prefixes overlap (ancestor, descendant or equal) run at once: the later one
   * waits for the earlier to return before its final check, whether or not either has members.
   */
  scope?: string
}

/** How a watcher read came out for the buffer (App raises notices and refreshes from this). */
export type OutsideOutcome =
  | { kind: 'skipped' }
  | { kind: 'none' }
  | { kind: 'adopted' }
  | { kind: 'replaced'; diskText: string }
  | { kind: 'conflict'; diskText: string }
  | { kind: 'removed'; dirty: boolean }

/** What main returned for a write it made to the document (accept, redo, goal, restore, clear): `written`,
 *  the receipt of that call's own write (absent: the call wrote nothing), and `content`, the file read back
 *  (absent: main wrote and could not read the file back, review F4; the outcome on disk is unknown). */
export type MainWriteAnswer = { written?: string | undefined; content?: string | undefined }

/**
 * How the buffer stands with a main write:
 * - `integrated`: the editor holds main's change as an undoable edit of its own (accept, redo). The
 *   baseline is the receipt; the buffer, whatever it holds now, is reported against it.
 * - `replace`: the buffer takes main's text (goal, restore, clear), only when nothing was typed since the
 *   route's snapshot. Typing that arrived meanwhile is kept and stays based on the old version: main's
 *   version is then an outside change to it, asked about (`moved`).
 */
export type MainWriteMode = 'integrated' | 'replace'
export type MainWriteOutcome =
  | { kind: 'clean' }
  | { kind: 'dirty' }
  | { kind: 'moved'; diskText: string }
  | { kind: 'outside'; diskText: string }
  /** Main wrote and did not read the file back: the disk is unknown for the document (review F4). */
  | { kind: 'unknown' }

export type DocumentOwner = ReturnType<typeof createDocumentOwner>

export function createDocumentOwner(ports: DocumentOwnerPorts) {
  const baselines = new EditorBaselines()
  const records = new Map<string, DocumentRecord>()
  const dirty = new Set<string>()
  const readOnly = new Set<string>()
  /** The folder scopes held now (`WithFlushedOptions.scope`): no operation on a path under `prefix` starts
   *  until `gate` resolves; `join` adds a document activated under it to the route's hold. */
  const scopes = new Set<{ prefix: string; gate: Promise<void>; join(path: string): void }>()
  /** The gates of the folder scopes covering the path now. */
  const covering = (path: string): Promise<void>[] => {
    const gates: Promise<void>[] = []
    for (const scope of scopes) if (path.startsWith(scope.prefix)) gates.push(scope.gate)
    return gates
  }
  /** The gates of the folder scopes held now whose prefix is the prefix's ancestor, descendant or itself:
   *  two folder-scoped routes conflict by prefix, whatever documents either has (2b round 3 review,
   *  finding 2: an empty folder's scope inside a held one). */
  const overlapping = (prefix: string): Promise<void>[] => {
    const gates: Promise<void>[] = []
    for (const scope of scopes) if (scope.prefix.startsWith(prefix) || prefix.startsWith(scope.prefix)) gates.push(scope.gate)
    return gates
  }
  /** Every path the owner has a record for under the prefix (open, in flight, or settled). */
  const pathsUnder = (prefix: string): string[] => [...records.keys()].filter((path) => path.startsWith(prefix))

  const record = (path: string): DocumentRecord => {
    let rec = records.get(path)
    if (!rec) {
      rec = { gen: 0, savedGen: 0, diskUnknown: false, inflight: 0, pending: 0, queue: Promise.resolve() }
      records.set(path, rec)
    }
    return rec
  }

  const setDot = (path: string, isDirty: boolean): void => {
    if (dirty.has(path) === isDirty) return
    if (isDirty) dirty.add(path)
    else dirty.delete(path)
    ports.dirtyChanged(new Set(dirty))
  }

  /** Run `op` in the path's queue, after everything queued before it and after every folder scope held
   *  over the path now. */
  const enqueue = <T>(path: string, op: () => Promise<T>): Promise<T> => {
    const rec = record(path)
    rec.pending += 1
    const scoped = covering(path)
    const before = scoped.length === 0 ? rec.queue : Promise.all([rec.queue, ...scoped])
    const run = before.then(op, op)
    rec.queue = run.then(() => undefined, () => undefined)
    void rec.queue.then(() => { rec.pending -= 1 })
    return run
  }

  /** Resolves once nothing is queued or running for the path, no folder scope is held over it, and the
   *  registry has no write or hold. */
  const idle = async (path: string): Promise<void> => {
    for (;;) {
      const scoped = covering(path)
      if (scoped.length > 0) {
        await Promise.all(scoped)
        continue
      }
      const rec = records.get(path)
      if (!rec || rec.pending === 0) {
        if (!ports.registry.busy(path)) return
        await ports.registry.settled(path)
        continue
      }
      await rec.queue
    }
  }
  const idleNow = (path: string): boolean => (records.get(path)?.pending ?? 0) === 0 && !ports.registry.busy(path) && covering(path).length === 0

  /** Saved, apart from a write or hold the registry has in flight outside the owner's queue. */
  const savedApartFromRegistryBusy = (path: string): boolean => {
    const rec = records.get(path)
    if (ports.notice(path)) return false
    // Text the registry holds is unsaved whoever put it there: a write of unknown outcome keeps its text
    // there, and so does a main write (accept, redo) whose buffer is not what it wrote.
    if (ports.registry.textOf(path) !== undefined) return false
    if (!rec) return true
    return rec.gen === rec.savedGen && rec.inflight === 0 && !rec.diskUnknown
  }
  const isSaved = (path: string): boolean => !ports.registry.busy(path) && savedApartFromRegistryBusy(path)

  /** One write of the buffer, run in the queue. True: the buffer's text (as read) is on disk. */
  const writeNow = async (path: string, answered?: ExternalDiskNotice, mayWrite?: () => Promise<boolean>): Promise<boolean> => {
    if (mayWrite && !(await mayWrite())) return false
    const rec = record(path)
    // The gen of the text this write carries: read with the buffer, ONCE. writeBuffer reads the buffer
    // again after main answers (to set the dot); typing that arrived meanwhile is not what was written.
    let captured: number | undefined
    // `committed`: main returned a receipt for this call (its text went to disk); `confirmed`: and the
    // readback was that text.
    let committed = false
    let confirmed = false
    rec.inflight += 1
    try {
      const ok = await writeBuffer({
        notice: ports.notice,
        buffer: (p) => { if (captured === undefined) captured = rec.gen; return ports.buffer(p) },
        baseline: (p) => baselines.get(p),
        baselineDisk: (p) => baselines.diskText(p),
        // The receipt main returned for this call (`written`) is the only thing a save sets a baseline from.
        setBaseline: (p, diskText) => { baselines.set(p, diskText) },
        registry: ports.registry,
        save: ports.write,
        ...(ports.beforeSave ? { beforeSave: ports.beforeSave } : {}),
        setDirty: (p, isDirty, text) => {
          if (isDirty) ports.registry.typed(p, text)
          else ports.registry.matchesDisk(p, text)
          setDot(p, isDirty)
        },
        setDirtyDot: setDot,
        slow: ports.report.slow,
        refusedByNotice: ports.report.refusedByNotice,
        refusedByMain: ports.report.refusedByMain,
        diskChanged: ports.report.diskChanged,
        saved: (p, changed) => { committed = true; confirmed = true; ports.report.saved(p, changed) },
        outsideAfterWrite: (p, diskText) => {
          // Muse r3 M1: the readback is not what this call wrote. The buffer is based on `written`, but its
          // text is not on disk: the disk is unknown for the document until a write is confirmed.
          committed = true
          rec.diskUnknown = true
          ports.report.outsideAfterWrite(p, diskText)
        },
        unknown: (p) => { rec.diskUnknown = true; ports.report.unknown(p) },
      }, path, answered)
      if ((ok || committed) && captured !== undefined && records.get(path) === rec) {
        // The gen this call read is on disk (or nothing needed writing). Whether the disk still holds it
        // is `diskUnknown`'s to say: a readback that differs keeps the document unsaved by that mark.
        rec.savedGen = captured
        if (confirmed) rec.diskUnknown = false
      }
      return ok
    } finally {
      rec.inflight -= 1
    }
  }

  /** Snapshot the paths, detach if asked and run `fn`; the caller holds the queues. */
  const runHolding = async <T>(paths: readonly string[], fn: (snapshots: Map<string, Snapshot>) => T | Promise<T>, options: WithFlushedOptions): Promise<WithFlushedResult<Awaited<T>>> => {
    const snapshots = new Map<string, Snapshot>()
    for (const path of paths) {
      const rec = record(path)
      const buffer = ports.buffer(path)
      snapshots.set(path, { path, text: buffer ?? null, baselineDisk: baselines.diskText(path), gen: rec.gen })
      rec.heldGen = rec.gen
    }
    if (options.detach) owner.detach(paths)
    try {
      const result = await fn(snapshots)
      const moved = paths.filter((path) => {
        const rec = records.get(path)
        return rec !== undefined && rec.gen !== snapshots.get(path)?.gen
      })
      return { status: 'acted', result: result as Awaited<T>, moved }
    } finally {
      if (options.detach) owner.attach(paths.filter((path) => records.has(path)))
      for (const path of paths) {
        const rec = records.get(path)
        if (rec) delete rec.heldGen
      }
    }
  }

  /**
   * `withFlushed` with `inOrder` (review F2): the route's place in each path's queue is taken now, in the
   * turn it is asked for. Once every place is reached, the buffers are written there (the owner's own
   * writes, not queued again: the route already holds the queue), and the action runs in the turn of the
   * last check. A hold the registry has meanwhile is a resolution asked for after this route, waiting
   * behind it: it is not waited for (that would wait for itself).
   */
  const withFlushedInOrder = async <T>(paths: readonly string[], fn: (snapshots: Map<string, Snapshot>) => T | Promise<T>, options: WithFlushedOptions): Promise<WithFlushedResult<Awaited<T>>> => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reached = paths.map((path) => new Promise<void>((arrived) => {
      void enqueue(path, () => { arrived(); return gate })
    }))
    try {
      await Promise.all(reached)
      const rounds = options.rounds ?? 3
      const firstUnsaved = (): string | undefined => paths.find((path) => !savedApartFromRegistryBusy(path))
      for (let round = 0; round < rounds; round += 1) {
        for (const path of paths) {
          while (!savedApartFromRegistryBusy(path)) {
            if (!(await writeNow(path))) return { status: 'refused', path }
            if (!savedApartFromRegistryBusy(path)) break // typed during the save: another round (bounded)
          }
        }
        if (firstUnsaved() !== undefined) continue
        if (options.afterSave) {
          for (const path of paths) {
            try { await options.afterSave(path) } catch { return { status: 'refused', path } }
          }
        }
        // The final check, the snapshot, the detach and the action: one turn, nothing awaited between.
        if (firstUnsaved() !== undefined) continue
        return await runHolding(paths, fn, options)
      }
      return { status: 'still-unsaved', path: firstUnsaved() ?? paths[0] ?? '' }
    } finally {
      release()
    }
  }

  const owner = {
    /** Every path the owner has a record for under the prefix (`''`: every path): open, in flight, or
     *  settled. A route's membership by path scope (2b round 3 ruling). */
    pathsUnder,
    /** The baselines (editor form and on-disk bytes). Read-only for the app outside the owner. */
    baselineOf: (path: string): string | undefined => baselines.get(path),
    baselineDiskOf: (path: string): string | undefined => baselines.diskText(path),
    isDirty: (path: string): boolean => dirty.has(path),
    dirtyPaths: (): string[] => [...dirty],
    isSaved,
    /** The document's change count and the count its last confirmed write carried (read-only; for tests
     *  and diagnostics: what `isSaved` is decided from, apart from the registry and the notice). */
    generationsOf: (path: string): { gen: number; savedGen: number } | undefined => {
      const rec = records.get(path)
      return rec ? { gen: rec.gen, savedGen: rec.savedGen } : undefined
    },
    isReadOnly: (path: string): boolean => readOnly.has(path),
    /** The editor changed the buffer (the writer typed, undid, pasted): synchronous. True = differs from
     *  the baseline (the dot). */
    edited(path: string, text: string): boolean {
      const rec = record(path)
      rec.gen += 1
      const differs = isTextChange(baselines.get(path), text)
      if (differs) ports.registry.typed(path, text)
      else ports.registry.matchesDisk(path, text)
      setDot(path, differs)
      return differs
    },
    /** Queue a write of the buffer (autosave, explicit Save, a close's flush). `answered`: Keep mine.
     *  `mayWrite`, asked when the write runs: false = it may not write now (a save queued behind a Folio
     *  running-order write whose file moved). */
    save(path: string, answered?: ExternalDiskNotice, mayWrite?: () => Promise<boolean>): Promise<boolean> {
      return enqueue(path, () => writeNow(path, answered, mayWrite))
    },
    keepMine(path: string, notice: ExternalDiskNotice): Promise<boolean> {
      return enqueue(path, () => writeNow(path, notice))
    },
    /** Resolves once the path's queue is empty. */
    settled: (path: string): Promise<void> => idle(path),
    /**
     * Run `op` in the path's queue, after everything asked for before it and before anything asked for
     * after: the routes where main writes or settles the document without a flush first (a suggestion's
     * redo puts its own pre-accept text back; undo and reject of a resolution write no document). Saves,
     * watcher reads and other resolutions asked for while it runs wait for it, so main receives every
     * resolution of a document in the order it was asked for (window-close.spec.ts, redo then undo under
     * a held save). `gen` is the document's change count when the op starts.
     */
    inQueue<T>(path: string, op: (gen: number) => Promise<T>): Promise<T> {
      return enqueue(path, () => op(record(path).gen))
    },
    /**
     * Write until every path is saved, then snapshot and run `fn` holding the queues. Up to `rounds`
     * rounds; `fn` runs in the turn of the last check (nothing awaited between).
     */
    /**
     * `paths` may be a function: the route's members are then asked again at the final check (a folder's
     * open documents), and one that joined since the round began sends the flush round again, so the hold
     * covers the members as they are in the turn it is installed (2b review P2). With a `scope`, the members
     * are also every path the owner has a record for under it, and the scope is locked with the holds.
     */
    async withFlushed<T>(paths: readonly string[] | (() => readonly string[]), fn: (snapshots: Map<string, Snapshot>) => T | Promise<T>, options: WithFlushedOptions = {}): Promise<WithFlushedResult<Awaited<T>>> {
      const asked = typeof paths === 'function' ? paths : (): readonly string[] => paths
      const scope = options.scope
      const members = scope === undefined ? asked : (): readonly string[] => [...new Set([...pathsUnder(scope), ...asked()])]
      if (options.inOrder) return withFlushedInOrder(members(), fn, options)
      const rounds = options.rounds ?? 3
      const holdOnly = (path: string): boolean => options.holdOnly?.(path) ?? false
      // Ready to be held: nothing queued or in flight for it (2b review P1: a held path too, so an earlier
      // save of it never runs beside the action), and saved unless it is held unwritten.
      const ready = (path: string): boolean => idleNow(path) && (holdOnly(path) || isSaved(path))
      let list = members()
      const firstUnready = (): string | undefined => list.find((path) => !ready(path))
      for (let round = 0; round < rounds; round += 1) {
        list = members()
        for (const path of list) {
          while (!ready(path)) {
            await idle(path)
            if (holdOnly(path) || isSaved(path)) break
            if (!(await owner.save(path))) return { status: 'refused', path }
            if (!isSaved(path)) break // typed during the save: another round (bounded)
          }
        }
        if (firstUnready() !== undefined) continue
        if (options.afterSave) {
          for (const path of list) {
            if (holdOnly(path)) continue
            try { await options.afterSave(path) } catch { return { status: 'refused', path } }
          }
          if (firstUnready() !== undefined) continue
        }
        // A folder-scoped route never runs beside another whose prefix overlaps its own (an ancestor, a
        // descendant or the same folder), even when neither holds a document: it waits for that one to
        // return and then goes round again, without spending a round (the wait is not new typing). Waiting
        // cannot deadlock: a route waiting here holds nothing yet, and a held scope's action asks main only,
        // never another folder route.
        if (scope !== undefined) {
          const blocking = overlapping(scope)
          if (blocking.length > 0) {
            await Promise.all(blocking)
            round -= 1
            continue
          }
        }
        // The final check, the snapshot, the detach, the hold and the scope's lock: one turn, nothing
        // awaited between. The members are asked once more: one that joined while the round awaited is
        // flushed in another round.
        const now = members()
        if (now.some((path) => !list.includes(path))) continue
        if (firstUnready() !== undefined) continue
        const held = [...list]
        const snapshots = new Map<string, Snapshot>()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const snapshot = (path: string): DocumentRecord => {
          const rec = record(path)
          snapshots.set(path, { path, text: ports.buffer(path) ?? null, baselineDisk: baselines.diskText(path), gen: rec.gen })
          rec.heldGen = rec.gen
          return rec
        }
        for (const path of held) {
          const rec = snapshot(path)
          rec.pending += 1
          // Every path in `held` is idle here (its queue settled), so the hold is the gate itself.
          rec.queue = gate
          void gate.then(() => { rec.pending -= 1; if (rec.heldGen !== undefined) delete rec.heldGen })
        }
        if (options.detach) owner.detach(held)
        const joined: string[] = []
        const lock = scope === undefined
          ? null
          : {
              prefix: scope,
              gate,
              // A document activated under the scope during the action: its snapshot goes into the map
              // the action holds, and it is detached with the others. Its queue needs no hold of its own:
              // nothing under the scope starts until the gate opens.
              join: (path: string): void => {
                if (snapshots.has(path)) return
                snapshot(path)
                held.push(path)
                joined.push(path)
                if (options.detach) owner.detach([path])
              },
            }
        if (lock) scopes.add(lock)
        try {
          const result = await fn(snapshots)
          const moved = held.filter((path) => {
            const rec = records.get(path)
            return rec !== undefined && rec.gen !== snapshots.get(path)?.gen
          })
          return { status: 'acted', result: result as Awaited<T>, moved }
        } finally {
          if (lock) scopes.delete(lock)
          if (options.detach) owner.attach(held.filter((path) => records.has(path)))
          for (const path of joined) {
            const rec = records.get(path)
            if (rec) delete rec.heldGen
          }
          release()
        }
      }
      return { status: 'still-unsaved', path: firstUnready() ?? list[0] ?? '' }
    },
    /**
     * Hold the paths' queues while `run` goes (a Folio running-order write): saves asked for meanwhile
     * run after it. Waits for what is queued first.
     */
    async exclusive<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
      // Review S5: the gate goes in in the turn every path is found idle. An operation queued between one
      // path going idle and the last one (a save asked for in a `then` of the write that just ended) would
      // otherwise run beside `run`, on the queue the gate replaced.
      while (!paths.every(idleNow)) await Promise.all(paths.map((path) => idle(path)))
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      for (const path of paths) {
        const rec = record(path)
        rec.pending += 1
        rec.queue = gate
        void gate.then(() => { rec.pending -= 1 })
      }
      try { return await run() } finally { release() }
    },
    /** Inside a `withFlushed` action only: forget the buffer if nothing moved since the snapshot and it is
     *  saved. False: it is kept (the route must not act as if it were gone). */
    forgetIfSaved(path: string): boolean {
      const rec = records.get(path)
      if (rec && rec.heldGen !== undefined && rec.gen !== rec.heldGen) return false
      if (!isSaved(path)) return false
      owner.drop(path)
      return true
    },
    /**
     * Write until every path is saved (the routes that need only the file on disk to be what is on screen:
     * opening the Board or the Plan, a folder's Collection, an export). `withFlushed` with no action.
     */
    async flush(paths: readonly string[], options: Pick<WithFlushedOptions, 'rounds'> = {}): Promise<{ status: 'saved' } | FlushOutcome> {
      const outcome = await owner.withFlushed(paths, () => undefined, options)
      return outcome.status === 'acted' ? { status: 'saved' } : outcome
    },
    /**
     * Inside a `withFlushed` action only, holding `from`: main moved the file at `from` to `to` (a rename, a
     * move, a folder's rename). A buffer the editor holds goes to `to` with its editor state, in this
     * turn, whether or not it changed: the editor's change callback then reports typing under `to` while
     * the app refreshes and opens the new name (2b review P1: a saved active buffer forgotten here left
     * the still-visible editor reporting its typing to no path, and the activation's read replaced it).
     * - Changed since the snapshot (`carried`): still based on the version it was saved as, and unsaved
     *   there (Sol r3 M2: the generation decides, never text equality; typing undone back to the
     *   snapshot's text is still a change of the buffer).
     * - Saved and unchanged (`renamed`): saved under the new name, as it was under the old one; the
     *   activation's read of `to` is reconciled with it as the watcher would.
     * No buffer resident (a tab never shown): forgotten; `to` is read when its tab opens. Nothing is left
     * at `from` in any case, so a save of `from` queued behind the route finds no buffer and writes
     * nothing (Muse r3 S3).
     */
    moved(from: string, to: string): 'forgotten' | 'carried' | 'renamed' {
      const rec = records.get(from)
      const changed = rec !== undefined && rec.heldGen !== undefined && rec.gen !== rec.heldGen
      // A rename whose destination is its source changes nothing in the owner: the buffer, its record, its
      // baseline, its registry entry and the editor's active path are as they were (2b round 2, finding 1).
      if (from === to) return !changed && isSaved(from) ? 'renamed' : 'carried'
      const buffer = ports.buffer(from)
      if (!rec || buffer == null) {
        owner.drop(from)
        return 'forgotten'
      }
      const saved = !changed && isSaved(from)
      const disk = baselines.diskText(from)
      const wasReadOnly = readOnly.delete(from)
      ports.renameBuffer(from, to)
      records.delete(from)
      baselines.delete(from)
      ports.forgetBuffer(from) // the app's traces of `from`; the editor's state is under `to` now
      ports.registry.discard(from)
      setDot(from, false)
      records.set(to, { gen: rec.gen, savedGen: rec.savedGen, diskUnknown: rec.diskUnknown, inflight: 0, pending: 0, queue: Promise.resolve() })
      if (disk !== undefined) baselines.set(to, disk)
      if (wasReadOnly) readOnly.add(to)
      if (saved) {
        ports.registry.matchesDisk(to, buffer)
        setDot(to, false)
        return 'renamed'
      }
      // Unsaved under the new name whatever its text (the registry holds it); the dot, for display only,
      // is the text's difference from the version it is based on.
      ports.registry.typed(to, buffer)
      setDot(to, isTextChange(baselines.get(to), buffer))
      return 'carried'
    },
    /**
     * Main wrote the document in a route holding the path (inside `withFlushed`'s action or `inQueue`) and
     * returned `answer`. `since`: the gen the route snapshotted. The baseline is only ever the receipt
     * (`written`); without one main wrote nothing and the baseline stays. A readback that is not the
     * receipt is another program's write: the disk is unknown for the document, its text stays held, and
     * the app is told (`outside`). No readback at all (`content` absent: main wrote and could not read the
     * file back, review F4): the baseline is still the receipt, and the outcome is unknown (`unknown`): the
     * registry keeps the buffer's text with the disk marked unknown, so a close asks and nothing treats the
     * buffer as saved until a write is confirmed. `lastKnown`: the buffer's text when the route began, for a
     * window that has no buffer to read now (unmounted by an error): kept when it is not on disk.
     */
    replaceFromMain(path: string, answer: MainWriteAnswer, options: { since: number; mode: MainWriteMode; lastKnown?: string; discardLocal?: boolean }): MainWriteOutcome {
      const rec = record(path)
      const moved = rec.gen !== options.since
      const previousDisk = baselines.diskText(path)
      const readBack = answer.content !== undefined
      const base = answer.written ?? previousDisk ?? answer.content
      if (options.mode === 'replace' && moved) {
        // Typed while main wrote: kept, still based on what it was; main's version is asked about (the
        // readback, or with none what main says it wrote, the disk then being unknown).
        const buffer = ports.buffer(path)
        const diskText = answer.content ?? answer.written
        if (buffer != null) ports.registry.typed(path, buffer)
        setDot(path, true)
        if (!readBack) owner.mainWriteUnknown(path, buffer ?? null)
        // A readback that is not what main wrote (or, when main wrote nothing, not the baseline) is another
        // hand's write: the disk is unknown, as in the `outside` case below (review P2). A readback equal to
        // it changes nothing.
        else if (answer.content !== (answer.written ?? previousDisk)) owner.mainWriteUnknown(path, buffer ?? null)
        return diskText === undefined ? { kind: 'unknown' } : { kind: 'moved', diskText }
      }
      if (base === undefined) {
        // Nothing known of the disk at all (no receipt, no baseline, no readback): the buffer stays as it
        // is, and the outcome is unknown.
        owner.mainWriteUnknown(path, ports.buffer(path) ?? options.lastKnown ?? null)
        return { kind: 'unknown' }
      }
      const outside = readBack && answer.content !== base
      baselines.set(path, base)
      let buffer = ports.buffer(path)
      if (options.mode === 'replace' && !moved && buffer != null && answer.written !== undefined) {
        ports.replaceBuffer(path, answer.written, options.discardLocal)
        buffer = ports.buffer(path) ?? answer.written
      }
      if (buffer != null) {
        const differs = isTextChange(base, buffer)
        if (differs) ports.registry.typed(path, buffer)
        else ports.registry.matchesDisk(path, buffer)
        setDot(path, differs)
        if (!differs && !moved && rec.inflight === 0 && !rec.diskUnknown && !outside && readBack) rec.savedGen = rec.gen
      } else if (options.lastKnown !== undefined && isTextChange(base, options.lastKnown) && ports.registry.textOf(path) === undefined) {
        ports.registry.typed(path, options.lastKnown)
      }
      if (outside && answer.content !== undefined) {
        // Muse r3 M1: what is on disk now is not what main wrote. Nothing treats the buffer as saved.
        owner.mainWriteUnknown(path, buffer ?? null)
        ports.report.outsideAfterWrite(path, answer.content)
        return { kind: 'outside', diskText: answer.content }
      }
      if (!readBack) {
        // Review F4: main wrote and the file was not read back. The baseline is the receipt (above); what
        // is on disk is not known, so the buffer's text is held with the disk unknown: a close asks, and
        // an Undo back to the old text cannot clear it against a baseline nothing confirmed.
        owner.mainWriteUnknown(path, buffer ?? options.lastKnown ?? null)
        return { kind: 'unknown' }
      }
      return owner.isSaved(path) ? { kind: 'clean' } : { kind: 'dirty' }
    },
    /** The buffer holds text that is not on disk (a refused or raced main write left it so): held in the
     *  registry with the dot, without counting as an edit. */
    markUnsaved(path: string, text: string): void {
      ports.registry.typed(path, text)
      setDot(path, true)
    },
    /** The writer's confirmed discard of a buffer (a removed file's tab: "discard the text?" answered yes). */
    discardConfirmed(path: string): void {
      owner.drop(path)
    },
    /** Every trace of the path in the owner and the editor: the owner's own ops, and a tab the app pruned
     *  once its file left the tree (review S8), when nothing in it is unsaved. */
    drop(path: string): void {
      records.delete(path)
      baselines.delete(path)
      readOnly.delete(path)
      ports.forgetBuffer(path)
      ports.registry.discard(path)
      setDot(path, false)
    },
    detach(paths: readonly string[]): void {
      for (const path of paths) readOnly.add(path)
      ports.setReadOnly(paths, true)
    },
    attach(paths: readonly string[]): void {
      const back = paths.filter((path) => readOnly.delete(path))
      if (back.length > 0) ports.setReadOnly(back, false)
    },
    /**
     * A tab activated and its file was read: the baseline is that read. `show` puts the buffer on screen
     * (a cached one, or the read) and returns it. A cached buffer is reconciled with the read as the
     * watcher would; the answer says what the app should raise.
     */
    activated(path: string, disk: string, show: () => string): 'conflict' | 'replaced' | 'kept' {
      // A document opened inside the scope of a route holding it now (a folder's rename or trash) joins
      // that hold before it is shown: detached with the route's documents and settled by the route's action
      // with them (2b review P2); its saves wait for the scope's lock as every operation under it does.
      for (const scope of scopes) if (path.startsWith(scope.prefix)) scope.join(path)
      const previousEditor = baselines.get(path)
      const previousDisk = baselines.diskText(path)
      const rec = record(path)
      baselines.set(path, disk)
      const buffer = show()
      if (previousDisk === undefined) {
        // A fresh buffer is the read itself.
        if (!isTextChange(disk, buffer) && rec.inflight === 0 && !rec.diskUnknown) rec.savedGen = rec.gen
        const differs = isTextChange(disk, buffer)
        if (differs) ports.registry.typed(path, buffer)
        else ports.registry.matchesDisk(path, buffer)
        setDot(path, differs)
        return 'kept'
      }
      const action = externalContentReconcileAction({ buffer, baseline: previousEditor, baselineDisk: previousDisk, disk, diskUnknown: rec.diskUnknown || ports.registry.diskIsUnknown(path) })
      if (action === 'conflict' || (action === 'replace' && !owner.unchangedSinceSave(path))) {
        baselines.set(path, previousDisk) // still based on the old version (main compares against it)
        ports.registry.typed(path, buffer)
        setDot(path, true)
        return 'conflict'
      }
      if (action === 'replace') {
        ports.replaceBuffer(path, disk)
        rec.savedGen = rec.gen
        ports.registry.matchesDisk(path, disk)
        setDot(path, false)
        return 'replaced'
      }
      const differs = isTextChange(disk, buffer)
      if (differs) ports.registry.typed(path, buffer)
      else ports.registry.matchesDisk(path, buffer)
      setDot(path, differs)
      return 'kept'
    },
    /** A removed file's tab activated with the text it holds. True when that text is unsaved. */
    activatedRemoved(path: string, buffer: string): boolean {
      const rec = record(path)
      const baseline = baselines.get(path)
      const unsaved = baseline === undefined || isTextChange(baseline, buffer) || ports.registry.textOf(path) !== undefined || rec.gen !== rec.savedGen
      if (unsaved) {
        ports.registry.typed(path, buffer)
        setDot(path, true)
      }
      return unsaved
    },
    /** Every change of the buffer since the last confirmed write went to disk (gen, in flight, unknown). */
    unchangedSinceSave(path: string): boolean {
      if (ports.registry.textOf(path) !== undefined || ports.registry.diskIsUnknown(path)) return false
      const rec = records.get(path)
      if (!rec) return true
      return rec.gen === rec.savedGen && rec.inflight === 0 && !rec.diskUnknown
    },
    /**
     * The watcher saw the file change (or go). Queued: runs after any route holding the path. `read` is
     * made when it runs, so the version applied is the one on disk then. A buffer is replaced only when
     * it is saved (gen, in flight, unknown); otherwise the writer is asked (reconcile.ts rules).
     */
    applyOutside(path: string, read: () => Promise<string>, options: { now?: boolean } = {}): Promise<OutsideOutcome> {
      const op = async (): Promise<OutsideOutcome> => {
        if (!records.has(path) && baselines.get(path) === undefined) return { kind: 'skipped' }
        let disk: string
        try {
          disk = await read()
        } catch {
          const buffer = ports.buffer(path)
          const baseline = baselines.get(path)
          const unsaved = (buffer != null && baseline !== undefined && isTextChange(baseline, buffer))
            || ports.registry.textOf(path) !== undefined || !owner.unchangedSinceSave(path)
          return { kind: 'removed', dirty: unsaved }
        }
        const buffer = ports.buffer(path)
        if (buffer == null) return { kind: 'skipped' } // activation's own read will seed a tab not yet live
        const rec = record(path)
        const action = externalContentReconcileAction({
          buffer,
          baseline: baselines.get(path),
          baselineDisk: baselines.diskText(path),
          disk,
          diskUnknown: rec.diskUnknown || ports.registry.diskIsUnknown(path),
        })
        if (action === 'none') return { kind: 'none' }
        if (action === 'adopt') {
          // The disk holds the buffer's own document in another form (or the buffer caught up with it).
          baselines.set(path, disk)
          const differs = isTextChange(disk, buffer)
          if (!differs && rec.inflight === 0 && !rec.diskUnknown) rec.savedGen = rec.gen
          if (differs) ports.registry.typed(path, buffer)
          else ports.registry.matchesDisk(path, buffer)
          setDot(path, differs)
          return { kind: 'adopted' }
        }
        if (action === 'replace' && owner.unchangedSinceSave(path)) {
          baselines.set(path, disk)
          ports.replaceBuffer(path, disk)
          rec.savedGen = rec.gen
          ports.registry.matchesDisk(path, disk)
          setDot(path, false)
          return { kind: 'replaced', diskText: disk }
        }
        return { kind: 'conflict', diskText: disk }
      }
      return options.now ? op() : enqueue(path, op)
    },
    /**
     * Main refused a write of the document because the file changed after main read it (an accept's
     * ChangedSinceRead). The writer is asked whatever the watcher delivers (it may hold the event back after
     * a recent write): the disk is read when this runs, and a version other than the one the buffer is based
     * on is a `conflict` (the changed-on-disk notice, Reload or Keep mine), never taken silently, saved buffer
     * or not; no file is `removed`. Either way the disk is marked unknown, so the document is not saved until
     * the writer chooses. The disk back on the buffer's version: nothing to ask (`none`). Queued, or `now`
     * from inside a route holding the path. Final review round 2, finding 2.
     */
    refusedOnDisk(path: string, read: () => Promise<string>, options: { now?: boolean } = {}): Promise<OutsideOutcome> {
      const op = async (): Promise<OutsideOutcome> => {
        if (!records.has(path) && baselines.get(path) === undefined) return { kind: 'skipped' }
        let disk: string
        try {
          disk = await read()
        } catch {
          const buffer = ports.buffer(path)
          if (buffer == null) return { kind: 'skipped' }
          const baseline = baselines.get(path)
          const unsaved = (baseline !== undefined && isTextChange(baseline, buffer))
            || ports.registry.textOf(path) !== undefined || !owner.unchangedSinceSave(path)
          record(path).diskUnknown = true
          return { kind: 'removed', dirty: unsaved }
        }
        if (ports.buffer(path) == null) return { kind: 'skipped' }
        if (disk === baselines.diskText(path)) return { kind: 'none' }
        record(path).diskUnknown = true
        return { kind: 'conflict', diskText: disk }
      }
      return options.now ? op() : enqueue(path, op)
    },
    /** The writer's Reload: the buffer takes the disk version (queued, like any op on the buffer). Only the
     *  text there when Reload was pressed is given up: typing after the press (the generation moved by the
     *  time the read answers) is kept, nothing is replaced, and the notice stands (`typed`). The check and
     *  the replacement are in one turn. Final review round 1, finding 3. */
    reload(path: string, read: () => Promise<string>): Promise<{ ok: true; diskText: string } | { ok: false; reason: 'unreadable' | 'typed' }> {
      const pressedAt = record(path).gen
      return enqueue(path, async () => {
        let disk: string
        try { disk = await read() } catch { return { ok: false as const, reason: 'unreadable' as const } }
        const rec = record(path)
        if (rec.gen !== pressedAt) return { ok: false as const, reason: 'typed' as const }
        baselines.set(path, disk)
        ports.replaceBuffer(path, disk, true)
        rec.savedGen = rec.gen
        // The writer chose the disk version: the buffer is that version now, known (review S6).
        rec.diskUnknown = false
        // The registry keeps a mark of unknown outcome (accepted residual: a later close asks once more).
        ports.registry.matchesDisk(path, disk)
        setDot(path, false)
        return { ok: true as const, diskText: disk }
      })
    },
    /** Main wrote the document and the outcome is not the buffer on disk (an accept or redo whose readback
     *  differs from what it wrote, Muse r3 M1, or a redo write that threw): the disk is unknown for the
     *  document and its text stays in the registry, so nothing treats it as saved. */
    mainWriteUnknown(path: string, bufferText: string | null): void {
      const rec = record(path)
      rec.diskUnknown = true
      if (bufferText !== null) {
        ports.registry.beginWrite(path, bufferText).unknown()
        setDot(path, true)
      }
    },
  }
  return owner
}
