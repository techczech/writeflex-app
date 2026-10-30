/** Read-only inventory. Folio membership comes from the existing Plan resolver, never prose identity. */
import type { Workspace } from './workspace'
import { ScratchpadStore } from './scratchpad-store'
import { readFolioPlan } from './plan'
import { documentAssetsProjected, projectedWritingContent, validRemovedSpans } from '../shared/scratchpad-inventory'
import type { ScratchItem, ScratchLiveBuffer } from '../shared/scratchpad-items'
import { validateScratchAsset } from './scratchpad-assets'

export type OwnedScratchBuffer = ScratchLiveBuffer
export type ScratchLiveReader = (root: string, paths: readonly string[]) => Promise<OwnedScratchBuffer[]>
let liveReader: ScratchLiveReader | null = null
/** Installed by main, also used by typed headless reads routed to the running app. */
export function configureScratchLiveReader(reader: ScratchLiveReader | null): void { liveReader = reader }

const sameOwnedBuffer = (a: OwnedScratchBuffer, b: OwnedScratchBuffer): boolean => a.content === b.content && JSON.stringify(a.removedSpans ?? []) === JSON.stringify(b.removedSpans ?? [])

/**
 * The shared live-owner seam. This module owns the live reader registry (`configureScratchLiveReader`,
 * installed by `scratchpad-live.ts`); `scratchpad-references.ts` consumes this projection instead of
 * importing the registry or re-reading disk, which keeps one owner-resolution rule and no import cycle
 * (this module never imports `scratchpad-references`).
 *
 * For each requested path with a live (current or cached unsaved) owner, `projected` holds its writing
 * content — raw bytes with Reviewing's excluded spans removed. A path whose owner is present but
 * unavailable, conflicting across windows, or inconsistently projected lands in `blocked` with the
 * notice to surface: callers must fail closed for it and never substitute stale disk text. Paths with
 * no live owner appear in neither map, so callers may read disk. A reader that itself fails (no window
 * could answer) throws, again so no caller silently falls back to disk.
 */
export async function readLiveOwnerProjections(root: string, paths: readonly string[], readLive: ScratchLiveReader | null = liveReader): Promise<{ projected: Map<string, string>; blocked: Map<string, string> }> {
  const projected = new Map<string, string>()
  const blocked = new Map<string, string>()
  if (!readLive || !paths.length) return { projected, blocked }
  const owned = await readLive(root, paths)
  for (const path of paths) {
    const holders = owned.filter(buffer => buffer.path === path)
    if (!holders.length) continue
    if (holders.length > 1 && holders.some(holder => !sameOwnedBuffer(holder, holders[0]))) {
      blocked.set(path, `${path} has different text in more than one open window. Its live text is unavailable until those windows agree. Disk was not substituted.`)
      continue
    }
    if (holders[0].content === null) { blocked.set(path, `${path} has a live owner whose text is unavailable. Disk was not substituted.`); continue }
    if (!validRemovedSpans(holders[0].removedSpans, holders[0].content.length)) { blocked.set(path, `${path} has a live owner whose text projection is inconsistent. Disk was not substituted.`); continue }
    projected.set(path, projectedWritingContent(holders[0].content, holders[0].removedSpans))
  }
  return { projected, blocked }
}

export async function readScratchInventory(ws: Workspace, input: { activePath: string; scope: 'part' | 'folio' }, readLive: ScratchLiveReader | null = liveReader): Promise<{ items: ScratchItem[]; notices: string[] }> {
  const store = new ScratchpadStore(ws, null)
  const active = store.documentPath(input.activePath)
  const notices: string[] = []
  let paths = [active]
  if (input.scope === 'folio') {
    const dir = store.folioDirFor(active)
    if (dir !== null) {
      const plan = await readFolioPlan(ws, dir)
      if (!plan) throw new Error('The Folio could not be read. Open its outline and try again.')
      paths = [...new Set([active, ...[...plan.parts, ...plan.unlisted].flatMap(part => part.path && !part.resolution ? [store.documentPath(part.path)] : [])])]
      notices.push(...(plan.notices ?? []))
    }
  }
  const owned = readLive ? await readLive(ws.root, paths) : []
  const items: ScratchItem[] = []
  for (const path of paths) {
    const holders = owned.filter(buffer => buffer.path === path)
    if (holders.length > 1 && holders.some(holder => !sameOwnedBuffer(holder, holders[0]))) {
      notices.push(`${path} has different text in more than one open window. Its inventory is unavailable until those windows agree.`)
      continue
    }
    let content: string
    let basis: 'live' | 'disk'
    let removedSpans: OwnedScratchBuffer['removedSpans']
    if (holders.length) {
      if (holders[0].content === null) { notices.push(`${path} has a live owner whose text is unavailable. Disk was not substituted.`); continue }
      if (!validRemovedSpans(holders[0].removedSpans, holders[0].content.length)) { notices.push(`${path} has a live owner whose text projection is inconsistent. Disk was not substituted.`); continue }
      content = holders[0].content
      removedSpans = holders[0].removedSpans
      basis = 'live'
    } else {
      try { content = (await ws.readFile(path)).content; basis = 'disk' }
      catch { notices.push(`${path} could not be read. Its inventory is unavailable.`); continue }
    }
    for (const item of documentAssetsProjected(path, content, basis, removedSpans)) {
      if (item.kind === 'pic' || item.kind === 'svg' || item.kind === 'table' || item.kind === 'widget') {
        try { await validateScratchAsset(ws.root, path, item.kind, item.markdown) }
        catch (error) { item.problem = (error as Error).message }
      }
      items.push(item)
    }
  }
  return { items, notices }
}
