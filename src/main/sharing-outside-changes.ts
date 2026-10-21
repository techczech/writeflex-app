// Publishing follows the piece through changes made OUTSIDE WriteFlex (sharing ticket 04; orchestrator
// ruling round 1, R-A to R-C; spec section 6.1 "Piece renamed or moved", "Piece deleted or in Trash",
// "Folio part missing on disk"). The workspace watcher (workspace-watcher.ts) names changed paths and
// nothing else: macOS reports a rename, a delete and a create alike. A share is on a FILE (its device
// inode and birth time, the publisher's `fileId`; sharing-piece-identity.ts I0), never on its bytes. So:
//
//   O1 a shared path (a piece, or a Folio's folder) the watcher names, or a folder above one, that is
//      not there now is held for the settle window (WATCH_SETTLE_MS). Unreadable (a drive gone, a
//      folder not synced, no permission) is held the same way: never taken as deleted.
//   O2 a path the watcher names, within the settle window before or after, that IS the held file (the
//      same device, inode and birth time; under a folder that went, the same file at the same place under the new
//      folder) is where it moved: every link follows (the publisher's `moved`), then it is published
//      there as a save. Equal bytes in another file are not the piece: a copy, a cross-volume move or a
//      new file with the same text is never followed. Nor is a new file given the freed inode (a new birth
//      time), nor a file whose birth time is not known (I0 'unknown'): that one is O4, then O5.
//   O3 a held path back on disk (the same file, or another file at the same path: an editor's atomic
//      save, ruling R-C) is the same piece, edited: found again and published as a save.
//   O4 a held path still not there when the window closes is "not found" (the publisher's `notFound`):
//      its links stop publishing and nothing is removed (ruling R-B). Only the in-app Trash and the
//      command line's Trash end a share.
//   O5 a path named (in the window or later) that may be the file of a not-found piece (I0 'same' or
//      'unknown') is offered to the writer ("Follow to", the publisher's `offer`), never followed by itself.
//   O6 a Folio whose PART went is not held: the save signal republishes it with the part "not available".
//
// Nothing here writes to a document. No Electron import.
import { isAtOrUnder, movedPath } from './sharing-follow'
import { presenceOf, sameFile, type Presence } from './sharing-piece-identity'
import { WATCH_SETTLE_MS } from './workspace-watcher'

export type FollowedShare = { root: string; kind: 'piece' | 'folio'; path: string; parts: readonly string[]; id: string | null; lost: boolean }
/** A timer the follower can be given (tests: a fake clock). */
export type Timers = { set(run: () => void, ms: number): unknown; clear(timer: unknown): void }

export type OutsideChangePorts = {
  /** Every share not ended (the publisher's `followed`). */
  followed(): readonly FollowedShare[]
  /** False when the move could not be saved (the publisher shows it; the share stays as it was). */
  moved(root: string, from: string, to: string): boolean
  notFound(root: string, path: string, why: 'gone' | 'unreadable'): void
  found(root: string, path: string, id: string): void
  offer(root: string, path: string, to: string): void
  saved(root: string, paths: readonly string[]): void
  /** What is at `path` in `root` now. Default: lstat (sharing-piece-identity.ts). */
  presence?(root: string, path: string): Presence
  now?(): number
  timers?: Timers
  settleMs?: number
}

/** A shared path not there now. `via`: the path the watcher named that went (the piece itself, or a folder above it). */
type Held = { root: string; path: string; kind: 'file' | 'folder'; id: string | null; via: string; timer: unknown }
type Seen = { root: string; path: string; at: number }

export function createOutsideChangeFollower(ports: OutsideChangePorts) {
  const presence = ports.presence ?? presenceOf
  const now = ports.now ?? Date.now
  const settleMs = ports.settleMs ?? WATCH_SETTLE_MS
  const timers: Timers = ports.timers ?? {
    set: (run, ms) => { const timer = setTimeout(run, ms); (timer as { unref?: () => void }).unref?.(); return timer },
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
  const held = new Map<string, Held>()
  let seen: Seen[] = []
  /** One batch at a time, in the order the watcher sent them. */
  let turn: Promise<void> = Promise.resolve()
  let disposed = false
  const key = (root: string, path: string): string => `${root}\0${path}`
  const kindOf = (share: FollowedShare): 'file' | 'folder' => (share.kind === 'piece' ? 'file' : 'folder')

  /** The shared pieces and Folio folders in `root`, once each. */
  function sharedIn(root: string): FollowedShare[] {
    const byPath = new Map<string, FollowedShare>()
    for (const share of ports.followed()) if (share.root === root && !byPath.has(share.path)) byPath.set(share.path, share)
    return [...byPath.values()]
  }

  /**
   * O2, O5: where the file `id` (at `path`, under `via` that went) is among the paths seen, or null.
   * `offer`: O5, a file that may be it (I0 not 'different'); otherwise O2, only the same file ('same').
   */
  function placeOf(root: string, path: string, kind: 'file' | 'folder', id: string | null, via: string, offer = false): { from: string; to: string; at: string } | null {
    if (!id) return null
    const isIt = (other: string): boolean => (offer ? sameFile(other, id) !== 'different' : sameFile(other, id) === 'same')
    for (const candidate of seen) {
      if (candidate.root !== root || isAtOrUnder(candidate.path, path) || held.has(key(root, candidate.path))) continue
      // The piece itself, at the new path.
      const there = presence(root, candidate.path)
      if (there.state === 'there' && there.kind === kind && isIt(there.id)) return { from: path, to: candidate.path, at: candidate.path }
      // A folder above it, moved whole: the piece at the same place under the new folder.
      if (via !== path && there.state === 'there' && there.kind === 'folder') {
        const under = movedPath(path, via, candidate.path)
        const inside = under === null ? null : presence(root, under)
        if (under !== null && inside?.state === 'there' && inside.kind === kind && isIt(inside.id)) return { from: via, to: candidate.path, at: under }
      }
    }
    return null
  }

  function release(entry: Held): void {
    timers.clear(entry.timer)
    held.delete(key(entry.root, entry.path))
  }

  /** O2: try every held path (and, O5, every not-found share) against the paths seen. */
  function match(root: string): void {
    for (const entry of [...held.values()].filter((item) => item.root === root)) {
      if (!held.has(key(entry.root, entry.path))) continue
      const place = placeOf(root, entry.path, entry.kind, entry.id, entry.via)
      if (!place) continue
      if (!ports.moved(root, place.from, place.to)) continue
      // Every held path under what moved moved with it.
      const went = [...held.values()].filter((item) => item.root === root && isAtOrUnder(item.path, place.from))
      for (const item of went) release(item)
      seen = seen.filter((item) => !(item.root === root && item.path === place.to))
      ports.saved(root, went.map((item) => movedPath(item.path, place.from, place.to) ?? place.to))
    }
    offerLost(root)
  }

  /** O5: a not-found share whose file may be at a path seen: offered, never followed. */
  function offerLost(root: string): void {
    for (const share of sharedIn(root).filter((item) => item.lost && !held.has(key(root, item.path)))) {
      const place = placeOf(root, share.path, kindOf(share), share.id, share.path, true)
      if (place) ports.offer(root, share.path, place.at)
    }
  }

  /** O4: the window is over for `entry`. */
  function settle(entry: Held): void {
    if (disposed || held.get(key(entry.root, entry.path)) !== entry) return
    match(entry.root)
    if (held.get(key(entry.root, entry.path)) !== entry) return
    release(entry)
    const there = presence(entry.root, entry.path)
    if (there.state === 'there' && there.kind === entry.kind) {
      ports.found(entry.root, entry.path, there.id)
      ports.saved(entry.root, [entry.path])
      return
    }
    ports.notFound(entry.root, entry.path, there.state === 'unreadable' ? 'unreadable' : 'gone')
    // O5: a path seen in the window that may be its file (its birth time not known) is offered.
    offerLost(entry.root)
  }

  function batch(root: string, paths: readonly string[]): void {
    const at = now()
    seen = seen.filter((entry) => at - entry.at <= settleMs)
    const shares = sharedIn(root)
    const named = [...paths].sort()
    for (const share of shares) {
      // A share the batch names: its own path, or a folder above it.
      const via = named.find((path) => isAtOrUnder(share.path, path))
      if (via === undefined) continue
      const there = presence(root, share.path)
      const entry = held.get(key(root, share.path))
      if (there.state === 'there' && there.kind === kindOf(share)) {
        // O3: back, or another file at the same path (an edit, R-C); a not-found piece is found again.
        if (entry) release(entry)
        if (share.lost || share.id !== there.id) {
          ports.found(root, share.path, there.id)
          ports.saved(root, [share.path])
        }
        continue
      }
      // O1: not there now. A share already not found waits for the writer (or for its file, O3 and O5).
      if (entry || share.lost) continue
      const hold: Held = { root, path: share.path, kind: kindOf(share), id: share.id, via, timer: null }
      hold.timer = timers.set(() => { void enqueue(async () => settle(hold)) }, settleMs)
      held.set(key(root, share.path), hold)
    }
    // Paths the batch names that are there and are no share's: where a held piece may have gone.
    const shared = new Set(shares.map((share) => share.path))
    for (const path of named) {
      if (shared.has(path)) continue
      const there = presence(root, path)
      if (there.state === 'there' && (there.kind === 'file' || there.kind === 'folder')) seen.push({ root, path, at })
    }
    match(root)
  }

  return {
    /** A watcher batch: the Workspace-relative paths it named. */
    changed(root: string, paths: readonly string[]): Promise<void> {
      return enqueue(async () => batch(root, paths))
    },
    /** Tests: every batch and every settled window has run. */
    async idle(): Promise<void> {
      for (let round = 0; round < 20; round += 1) {
        const before = turn
        await before
        if (turn === before) return
      }
    },
    dispose(): void {
      disposed = true
      for (const entry of held.values()) timers.clear(entry.timer)
      held.clear()
    },
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    turn = turn.then(() => (disposed ? undefined : work())).catch(() => {})
    return turn
  }
}

export type OutsideChangeFollower = ReturnType<typeof createOutsideChangeFollower>
