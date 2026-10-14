/**
 * The Board's per-collection view choices, kept in this browser's storage: a convenience, never
 * content. Every read and write tolerates storage being unavailable (the Board then uses defaults).
 */

const OFFCUTS_HIDDEN = 'writeflex.board.offcutsHidden:'
const SOURCES_COLLAPSED = 'writeflex.board.sourcesCollapsed:'

export function offcutsHidden(dir: string): boolean {
  try {
    return localStorage.getItem(`${OFFCUTS_HIDDEN}${dir}`) === '1'
  } catch {
    return false
  }
}

export function setOffcutsHidden(dir: string, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(`${OFFCUTS_HIDDEN}${dir}`, '1')
    else localStorage.removeItem(`${OFFCUTS_HIDDEN}${dir}`)
  } catch {
    // Storage unavailable: the choice lasts until the Board remounts.
  }
}

/** Whether the Sources rail is collapsed to its strip (locked design frame 8) in this collection. */
export function sourcesCollapsed(dir: string): boolean {
  try {
    return localStorage.getItem(`${SOURCES_COLLAPSED}${dir}`) === '1'
  } catch {
    return false
  }
}

export function setSourcesCollapsed(dir: string, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(`${SOURCES_COLLAPSED}${dir}`, '1')
    else localStorage.removeItem(`${SOURCES_COLLAPSED}${dir}`)
  } catch {
    // Storage unavailable: the choice lasts until the Board remounts.
  }
}
