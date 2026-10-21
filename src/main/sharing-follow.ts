// Publishing follows the piece (sharing ticket 04; spec section 5 rule 5, section 6.1 "Piece renamed or
// moved", "Piece deleted or in Trash"). Pure path rules the publisher applies to its records:
//
//   F1 a rename or move of a file or a folder never ends a share: every record whose piece, Folio
//      folder, Folio part (its key in `partKeys`, its path in `parts`) is the moved path or lies under it
//      takes the new path. The share id, the address, the owner token and every key stay as they were.
//   F2 a file or folder sent to the Trash ends every share whose piece is that path or lies under it,
//      and every Folio share whose folder is that path or lies under it. A Folio whose PART went to the
//      Trash is not ended: it is published again with the part "not available" (the save signal).
//
// Paths are Workspace-relative with `/` separators, as the app's file IPC names them. No Electron import.

/** `path` is `base` or lies under it. `base` '' (the Workspace itself) holds every path. */
export function isAtOrUnder(path: string, base: string): boolean {
  if (base === '') return true
  return path === base || path.startsWith(`${base}/`)
}

/** `path` with `from` (itself, or a folder above it) replaced by `to`; null when `path` is not at or under `from`. */
export function movedPath(path: string, from: string, to: string): string | null {
  if (from === '' || !isAtOrUnder(path, from)) return null
  return path === from ? to : `${to}${path.slice(from.length)}`
}

type Followable = { root: string; kind: 'piece' | 'folio'; path: string; partKeys: Record<string, string>; parts: Array<{ path: string; title: string; missing: boolean }> }

/** F1: the record after `from` moved to `to` in `root`, or null when nothing in it changes. */
export function followMove<T extends Followable>(record: T, root: string, from: string, to: string): T | null {
  if (record.root !== root || from === to) return null
  const path = movedPath(record.path, from, to)
  let changed = path !== null
  const partKeys: Record<string, string> = {}
  for (const [part, key] of Object.entries(record.partKeys)) {
    const next = movedPath(part, from, to)
    if (next !== null) changed = true
    partKeys[next ?? part] = key
  }
  const parts = record.parts.map((part) => {
    const next = movedPath(part.path, from, to)
    if (next === null) return part
    changed = true
    return { ...part, path: next }
  })
  return changed ? { ...record, path: path ?? record.path, partKeys, parts } : null
}

/** F2: the share ends when one of `trashed` in `root` is its piece, its Folio's folder, or a folder above either. */
export function endedByTrash(record: Pick<Followable, 'root' | 'path'>, root: string, trashed: readonly string[]): boolean {
  // The Workspace itself is never sent to the Trash from inside it, so no path is "", and a Folio on the Workspace ends only with its Workspace.
  return record.root === root && trashed.some((gone) => gone !== '' && isAtOrUnder(record.path, gone))
}
