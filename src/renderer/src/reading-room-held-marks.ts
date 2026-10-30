/**
 * What one reader instance is holding for each mark, so an edit or deletion can say what it changed.
 *
 * Zotero is written compare-and-set (ADR-0031): an edit is written only if Zotero still holds what the
 * person was looking at when he made it. That "before" belongs to the reader that showed it, not to
 * any list refreshed since: a list refresh may read a newer comment from Zotero while the open reader
 * still shows the older one, and an edit made in that reader was made against the older one.
 *
 * So each reader instance keeps its own record: the marks it was given when the document opened, then
 * every mark it created, painted or changed itself. An edit takes the held mark as its before-state and
 * the edit becomes what is held, so the next edit carries the right baseline.
 */
export type HeldMark = {
  /** The annotation type the reader showed; the write compares it too. */
  type?: string
  text: string | null
  comment: string | null
  color: string | null
  pageLabel: string | null
  sortIndex: string
  position: string
  /**
   * What Zotero held beyond the fields, when known: its tags and its modification stamp there. A
   * deletion carries it, and Zotero refuses the deletion if either changed since (ADR-0047).
   */
  zoteroState?: { modified: string | null; tags: string[] }
}

type MarkLike = {
  key?: unknown
  type?: unknown
  text?: unknown
  comment?: unknown
  color?: unknown
  pageLabel?: unknown
  sortIndex?: unknown
  position?: unknown
  zoteroState?: unknown
}

function stateFrom(value: unknown): HeldMark['zoteroState'] | null {
  if (!value || typeof value !== 'object') return null
  const state = value as { modified?: unknown; tags?: unknown }
  if (!Array.isArray(state.tags) || !state.tags.every((tag) => typeof tag === 'string')) return null
  if (state.modified !== null && state.modified !== undefined && typeof state.modified !== 'string') return null
  return { modified: (state.modified as string | null | undefined) ?? null, tags: [...state.tags as string[]] }
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function heldFrom(mark: MarkLike): HeldMark | null {
  if (typeof mark.sortIndex !== 'string') return null
  const position = typeof mark.position === 'string'
    ? mark.position
    : mark.position && typeof mark.position === 'object'
      ? JSON.stringify(mark.position)
      : null
  if (position === null) return null
  return {
    color: optionalText(mark.color),
    comment: optionalText(mark.comment),
    pageLabel: optionalText(mark.pageLabel),
    position,
    sortIndex: mark.sortIndex,
    text: optionalText(mark.text),
    ...(typeof mark.type === 'string' && mark.type ? { type: mark.type } : {}),
    ...(stateFrom(mark.zoteroState) ? { zoteroState: stateFrom(mark.zoteroState)! } : {}),
  }
}

export type HeldMarks = {
  /**
   * This reader instance's id, sent with each change. A create Zotero could not take under its own key
   * is re-keyed, and only this instance's later changes are resolved to the new key (ADR-0047).
   */
  readonly session: string
  /** The marks the reader was given when its document opened. Replaces anything held. */
  load(marks: readonly MarkLike[]): void
  /** A mark this reader now shows, painted into it by the host. */
  hold(mark: MarkLike): void
  /** A mark made in this reader: Zotero holds no tags for it (WriteFlex never writes tags). */
  created(mark: MarkLike): void
  /** An edit: returns what was held before it (null if nothing), then holds the edit. */
  edit(mark: MarkLike): HeldMark | null
  /** A deletion: returns what was held before it (null if nothing), then forgets the mark. */
  remove(mark: MarkLike): HeldMark | null
}

function newSession(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createHeldMarks(): HeldMarks {
  const held = new Map<string, HeldMark>()
  const session = newSession()
  // A mark the reader hands back (an edit, a repaint, a new mark) carries no Zotero state. Its tags
  // are what Zotero held before, since WriteFlex never writes tags (none at all for a new mark); its
  // stamp is unknown, since a write from here changes it.
  const keep = (mark: MarkLike) => {
    if (typeof mark.key !== 'string') return
    const value = heldFrom(mark)
    if (!value) {
      held.delete(mark.key)
      return
    }
    if (!value.zoteroState) {
      const previous = held.get(mark.key)
      value.zoteroState = { modified: null, tags: previous ? previous.zoteroState?.tags ?? [] : [] }
      if (previous && !previous.zoteroState) delete value.zoteroState
    }
    held.set(mark.key, value)
  }
  return {
    edit(mark) {
      const before = typeof mark.key === 'string' ? held.get(mark.key) ?? null : null
      // Whatever state the reader echoes back is the one from before this edit; the edit moves the stamp.
      const { zoteroState: _echoed, ...edited } = mark
      keep(edited)
      return before
    },
    hold: keep,
    created(mark) {
      if (typeof mark.key !== 'string') return
      const value = heldFrom(mark)
      if (!value) return
      value.zoteroState = { modified: null, tags: [] }
      held.set(mark.key, value)
    },
    session,
    load(marks) {
      held.clear()
      // As given. A mark painted from WriteFlex's own queue carries the tags of the Zotero mark it was
      // painted over, with no stamp (main's `mergeWithOutbox`); one with no state at all gets none, and
      // Zotero refuses its deletion rather than erase it unchecked.
      for (const mark of marks) {
        const value = typeof mark.key === 'string' ? heldFrom(mark) : null
        if (value) held.set(mark.key as string, value)
      }
    },
    remove(mark) {
      if (typeof mark.key !== 'string') return null
      const before = held.get(mark.key) ?? null
      held.delete(mark.key)
      return before
    },
  }
}
