import type { Change } from '../../../preload'
import { resolveChangeRange } from '../editor/change-marks'

export type ReviewCursorEvent = { id: string | null; reveal: boolean }

type Entry = { id: string; position: number; sourceIndex: number }

function orderedUnresolved(changes: Change[], document: string): Entry[] {
  return changes
    .map((change, sourceIndex) => ({
      change,
      sourceIndex,
      position: resolveChangeRange(document, change)?.from ?? Number.POSITIVE_INFINITY,
    }))
    .filter(({ change }) => (change.status === 'pending' || change.status === 'held') && !change.snapshotId)
    .sort((a, b) => a.position - b.position || a.sourceIndex - b.sourceIndex)
    .map(({ change, position, sourceIndex }) => ({ id: change.id, position, sourceIndex }))
}

/**
 * The review cursor owns current-change invariants and document-order movement. Its sole outward event
 * distinguishes deliberate navigation (`reveal`) from invariant repair after a resolution.
 */
export class ReviewCursor {
  #entries: Entry[] = []
  #currentId: string | null = null

  constructor(private readonly onChange: (event: ReviewCursorEvent) => void) {}

  get currentId(): string | null {
    return this.#currentId
  }

  sync(changes: Change[], document: string): void {
    const previousEntries = this.#entries
    const previousIndex = previousEntries.findIndex((entry) => entry.id === this.#currentId)
    this.#entries = orderedUnresolved(changes, document)
    if (this.#currentId === null || this.#entries.some((entry) => entry.id === this.#currentId)) return

    const fallbackIndex = Math.min(Math.max(previousIndex, 0), this.#entries.length - 1)
    this.publish(this.#entries[fallbackIndex]?.id ?? null, false)
  }

  select(id: string): boolean {
    if (!this.#entries.some((entry) => entry.id === id)) return false
    this.publish(id, true)
    return true
  }

  move(direction: -1 | 1): boolean {
    if (this.#entries.length === 0) return false
    const currentIndex = this.#entries.findIndex((entry) => entry.id === this.#currentId)
    const targetIndex = currentIndex === -1
      ? (direction === 1 ? 0 : this.#entries.length - 1)
      : currentIndex + direction
    const target = this.#entries[targetIndex]
    if (!target) return false
    this.publish(target.id, true)
    return true
  }

  settle(id: string, advance: boolean): void {
    const removedIndex = this.#entries.findIndex((entry) => entry.id === id)
    if (removedIndex === -1) return
    this.#entries = this.#entries.filter((entry) => entry.id !== id)
    if (this.#currentId !== id && !advance) return

    const next = this.#entries[removedIndex]
    const previous = this.#entries[removedIndex - 1]
    const target = next ?? previous
    this.publish(target?.id ?? null, advance && target !== undefined)
  }

  private publish(id: string | null, reveal: boolean): void {
    if (id === this.#currentId && !reveal) return
    this.#currentId = id
    this.onChange({ id, reveal })
  }
}

export type RevealRequest = { revealId: string | null; revealSerial: number }

/**
 * The change a reveal request still owes, or null. Each reveal serial is honoured once: a later refresh of
 * the change list (a new array for the same request) must never re-select a change the writer has since
 * moved away from. A request whose change is not listed yet stays owed until the list catches up.
 */
export function owedReveal<T extends { id: string }>(request: RevealRequest, honouredSerial: number | null, changes: T[]): T | null {
  if (!request.revealId || request.revealSerial === honouredSerial) return null
  return changes.find((change) => change.id === request.revealId) ?? null
}
