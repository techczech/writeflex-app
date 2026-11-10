import { useEffect, useState, useSyncExternalStore } from 'react'
import type { FolioCues } from '../../../shared/folio-version-changes'

/**
 * One read of a Folio's change cues, shared (Folio versions ticket 06): the Binder's dots, the status-bar chip, the margin's
 * heading and the Versions tab's working-draft row take the same answer, so one save is one read. Every reason to read again
 * (a collection change, a change on disk, a new Folio version) asks for a refresh, the asks that arrive within one short window
 * become ONE read, and a read asked while one is in flight runs once more after it. Nothing is read while nobody shows the cues.
 * Reading writes nothing (`folio-versions:cues` is read only).
 */

export const CUES_REFRESH_COALESCE_MS = 120
const NONE: FolioCues = { state: 'none' }

type Listener = () => void
type Entry = { listeners: Set<Listener>; last: FolioCues; timer: ReturnType<typeof setTimeout> | null; reading: boolean; again: boolean }

const entries = new Map<string, Entry>()
let wired = false

function wire(): void {
  if (wired || typeof window === 'undefined' || !window.writeflex) return
  wired = true
  const all = (): void => { for (const dir of entries.keys()) refreshCues(dir) }
  window.writeflex.onCollectionChanged(all)
  window.writeflex.onFileChangedOnDisk(all)
  window.writeflex.onVersionsChanged(all)
}

async function read(dir: string, entry: Entry): Promise<void> {
  entry.reading = true
  try {
    const answer = await window.writeflex.folioVersions.cues(dir)
    if (entries.get(dir) !== entry) return
    if (JSON.stringify(answer) !== JSON.stringify(entry.last)) {
      entry.last = answer
      for (const listener of [...entry.listeners]) listener()
    }
  } catch {
    // A read that failed leaves what is drawn as it is: a cue that cannot be sure says nothing new.
  } finally {
    if (entries.get(dir) === entry) {
      entry.reading = false
      if (entry.again) { entry.again = false; refreshCues(dir) }
    }
  }
}

/** Read the cues of the Folio at `dir` again soon (`now`: at once), once for every ask in the window. Nothing when nobody shows them. */
export function refreshCues(dir: string, now = false): void {
  const entry = entries.get(dir)
  if (!entry) return
  if (entry.reading) { entry.again = true; return }
  if (entry.timer) return
  entry.timer = setTimeout(() => { entry.timer = null; void read(dir, entry) }, now ? 0 : CUES_REFRESH_COALESCE_MS)
}

/** Hear every change to the cues of the Folio at `dir`; answers the unsubscribe. The first read is asked for when the first subscriber arrives. */
export function subscribeCues(dir: string, listener: Listener): () => void {
  wire()
  let entry = entries.get(dir)
  if (!entry) {
    entry = { listeners: new Set(), last: NONE, timer: null, reading: false, again: false }
    entries.set(dir, entry)
    refreshCues(dir, true)
  }
  const mine = entry
  mine.listeners.add(listener)
  return () => {
    mine.listeners.delete(listener)
    if (mine.listeners.size > 0) return
    if (mine.timer) clearTimeout(mine.timer)
    if (entries.get(dir) === mine) entries.delete(dir)
  }
}

/** The cues now held for `dir` (`none` before the first read). */
export function cuesNow(dir: string): FolioCues { return entries.get(dir)?.last ?? NONE }

/** The cues of the Folio at `dir`, kept up to date; `none` for no Folio (null) and for a Folio with no Folio version of the writer's own. */
export function useFolioCues(dir: string | null): FolioCues {
  const [, force] = useState(0)
  useEffect(() => {
    if (dir === null) return
    return subscribeCues(dir, () => force((value) => value + 1))
  }, [dir])
  return dir === null ? NONE : cuesNow(dir)
}

// ---- The margin's heading ---------------------------------------------------------------------

let marginHeading: string | null = null
const marginListeners = new Set<Listener>()

/** The app says what the margin's heading reads ("Changes since “After pilot numbers”"), or null for none. */
export function setMarginSince(text: string | null): void {
  if (text === marginHeading) return
  marginHeading = text
  for (const listener of [...marginListeners]) listener()
}

/** The margin's heading, kept up to date. */
export function useMarginSince(): string | null {
  return useSyncExternalStore((listener) => { marginListeners.add(listener); return () => { marginListeners.delete(listener) } }, () => marginHeading, () => null)
}
