/**
 * Where the Outline's answer about a Folio's running order is kept between reads: per workspace root and
 * Folio folder, whether the Outline may change the order and which files Add will accept
 * (folio-order-facts.ts fills it). This file holds only the map and its invalidation, and imports
 * only folio-dir.ts (the one spelling of a root and a folder, which keys the map), so plan-lock.ts can
 * drop an entry when a Plan write ends without an import cycle.
 *
 * Dropped: for a whole root whenever main pushes `collection:changed` or `file:changed-on-disk` and on a
 * workspace bind (ipc.ts, beside `invalidateFolioPlaces`); for one Folio when a hold of its Plan lock
 * ends, which is after every Plan write in this process, whoever made it.
 *
 * The write routes never read this cache: each reads the documents again under the lock.
 */

import { folioKey } from './folio-dir'

const cache = new Map<string, Map<string, Promise<unknown>>>()

/** The held answer for a Folio folder, or the one `load` starts now. A failed load is not kept. */
export function cachedFolioOrderFacts<T>(givenRoot: string, givenDir: string, load: () => Promise<T>): Promise<T> {
  const { root, dir } = folioKey(givenRoot, givenDir)
  let byDir = cache.get(root)
  if (!byDir) cache.set(root, (byDir = new Map()))
  const held = byDir.get(dir)
  if (held) return held as Promise<T>
  const started = load()
  const map = byDir
  map.set(dir, started)
  started.catch(() => { if (map.get(dir) === started) map.delete(dir) })
  return started
}

/** Forget a whole root, or one Folio folder of it. */
export function invalidateFolioOrderFacts(givenRoot: string, givenDir?: string): void {
  const { root, dir } = folioKey(givenRoot, givenDir ?? '')
  if (givenDir === undefined) cache.delete(root)
  else cache.get(root)?.delete(dir)
}
