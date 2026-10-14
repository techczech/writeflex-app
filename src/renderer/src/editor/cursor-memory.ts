/**
 * Per-file cursor + scroll memory, keyed by workspace root AND path so two Workspaces that happen
 * to share a relative path (e.g. two folders each with a `notes.md`) never collide in the one
 * shared `localStorage`.
 */
export type CursorPos = { head: number; scrollTop: number }

function storageKey(root: string, path: string): string {
  return `writeflex:cursor:${root}:${path}`
}

export function saveCursor(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  root: string,
  path: string,
  pos: CursorPos
): void {
  try {
    storage.setItem(storageKey(root, path), JSON.stringify(pos))
  } catch {
    // setItem can throw (quota exceeded, storage disabled); losing one cursor save is harmless,
    // crashing the editor over it is not.
  }
}

export function loadCursor(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  root: string,
  path: string
): CursorPos | null {
  try {
    const raw = storage.getItem(storageKey(root, path))
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as CursorPos).head === 'number' &&
      typeof (parsed as CursorPos).scrollTop === 'number'
    ) {
      return { head: (parsed as CursorPos).head, scrollTop: (parsed as CursorPos).scrollTop }
    }
    return null
  } catch {
    return null
  }
}
