/**
 * The compatibility adapter between the floating Scratchpad's lossless items (ADR-0050) and the places
 * that grew up reading SCRAPS.md files: the Agent panel's embedded scraps list, the agent's
 * `scraps.list`, the `writeflex scraps` command, and the Board's Offcuts column, piece drawer and counts.
 *
 * A cut now lands as an exact payload under `.writeflex`, never in the legacy heading grammar, so these
 * readers would not see it. This module lists both: every legacy scrap as before, then each lossless item
 * still waiting to be used (active, not put back) in the same shape, marked `source: 'lossless'` with its
 * `p_…` id and its exact Markdown as `text`. Nothing is converted or written here; legacy files and their
 * `{trigger}` expansions stay as they are, and a lossless item never gains a heading line.
 */
import type { Scrap, ScrapStore } from './scraps'
import type { Workspace } from './workspace'
import { isLosslessItemId, isPlaced, type ScratchItem } from '../shared/scratchpad-items'

export type ScrapListing = Scrap & { source: 'legacy' | 'lossless'; how?: 'cut' | 'copy'; createdAt?: string }

/** A lossless Scratchpad id (`p_…`), which the legacy SCRAPS.md operations must never be handed. */
export const isLosslessScrapId = isLosslessItemId

/** The lossless items a scraps reader should show: set aside and still waiting (not rejected, not put back). */
export function waitingLossless(items: readonly ScratchItem[]): ScratchItem[] {
  return items.filter((item) => item.source === 'lossless' && item.kind === 'text' && item.status === 'active' && !isPlaced(item))
}

export function listingOf(item: ScratchItem): ScrapListing {
  return {
    id: item.id, origin: item.origin.path, text: item.markdown, done: item.done,
    ...(item.colour ? { colour: item.colour } : {}),
    source: 'lossless', ...(item.how ? { how: item.how } : {}), ...(item.createdAt ? { createdAt: item.createdAt } : {}),
  }
}

/** The waiting lossless items of `ws`; none when the Scratchpad's store cannot be read. The store module is
 *  loaded on first use, so the many modules that import this one (verbs, Board) do not load it eagerly. */
export async function readWaitingLossless(ws: Workspace): Promise<ScratchItem[]> {
  const { readLosslessItems } = await import('./scratchpad-store')
  return waitingLossless(await readLosslessItems(ws).catch(() => []))
}

/** Legacy scraps (as `ScrapStore.list` gives them), then the waiting lossless items; `origin` filters both. */
export async function listScrapsWithScratchpad(ws: Workspace, legacy: Pick<ScrapStore, 'list'>, scope?: { origin?: string }): Promise<ScrapListing[]> {
  const old = await legacy.list(scope?.origin ? { origin: scope.origin } : undefined)
  const fresh = (await readWaitingLossless(ws)).filter((item) => !scope?.origin || item.origin.path === scope.origin)
  return [...old.map((scrap): ScrapListing => ({ ...scrap, source: 'legacy' })), ...fresh.map(listingOf)]
}

/** Board promote/append take a lossless text item through the Scratchpad store's Board seam
 *  (board-material.ts, ticket 04); legacy scraps-file operations still refuse a `p_…` id rather
 *  than guess which file holds it. */
