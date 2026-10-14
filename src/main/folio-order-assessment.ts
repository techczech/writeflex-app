/**
 * Whether the Outline may change the running order of a Folio that has an Index Note. It may only when the
 * Folio is one the Plan writes can move exactly: a manifest and an Index Note that list the same files in
 * the same order, each once, every entry a file that is there, inside the Folio's folder. Any other such
 * Folio is the Plan view's to change; the Outline shows no reorder or Add control for it and main refuses
 * the three routes.
 *
 * A Folio with a manifest and no Index Note file is judged by folio-manifest-order.ts instead (the same
 * refusals, for the one document it has).
 *
 * One rule, asked three times: by the Outline read (folio-order-facts.ts, to hide the controls), by each
 * route before it calls a Plan write, and again inside that write against the very read it is made from.
 */

import { manifestContentRootRefused, manifestEntryPointsOutsideFolio, resolveManifestFilePath, type Folio } from './folio'
import { readPlanWithManifest, type Plan } from './plan'
import type { Workspace } from './workspace'

export type OutlineOrderReason =
  | 'no-index' // the Index Note is a file the workspace does not list, so there is no Plan to read
  | 'no-manifest' // the order follows file names; a Plan write would change only the Index Note
  | 'outside-entry' // an entry points outside the Folio's folder (or content_root leaves it)
  | 'missing-file' // an entry's file is not there
  | 'unreadable-entry' // an element of `files` is not an entry with a path, so a rewrite from the Plan's parts would not carry it
  | 'listed-twice' // a file is listed twice, in the manifest or in the Index Note
  | 'part-without-file' // a running-order line of the Index Note has no file
  | 'disagree' // the Index Note and the manifest list different files or a different order

export type OutlineOrderAssessment =
  | { ok: true; order: string[] }
  /** `manifestOrder` is set when the manifest itself is sound and only the Index Note differs from it. */
  | { ok: false; reason: OutlineOrderReason; manifestOrder?: string[] }

const hasRepeat = (paths: readonly string[]): boolean => new Set(paths).size !== paths.length

/** Pure: the Plan and the manifest of one read, and the files present in the Folio's folder. */
export function assessOutlineOrder(plan: Plan | null, manifest: Folio | null, present: ReadonlySet<string>): OutlineOrderAssessment {
  if (!plan) return { ok: false, reason: 'no-index' }
  if (!manifest) return { ok: false, reason: 'no-manifest' }
  // `manifest.files` leaves such elements out; a Folio that has one is the Plan's to change, which keeps it as authored.
  if (manifest.unreadableEntries) return { ok: false, reason: 'unreadable-entry' }
  if (manifestContentRootRefused(plan.dir, manifest)) return { ok: false, reason: 'outside-entry' }
  const manifestOrder: string[] = []
  for (const file of manifest.files) {
    if (manifestEntryPointsOutsideFolio(plan.dir, manifest, file)) return { ok: false, reason: 'outside-entry' }
    const path = resolveManifestFilePath(plan.dir, manifest, file, present)
    if (!path) return { ok: false, reason: 'missing-file' }
    manifestOrder.push(path)
  }
  if (hasRepeat(manifestOrder)) return { ok: false, reason: 'listed-twice' }
  if (plan.parts.some((part) => part.path === null)) return { ok: false, reason: 'part-without-file', manifestOrder }
  const indexOrder = plan.parts.map((part) => part.path as string)
  if (hasRepeat(indexOrder)) return { ok: false, reason: 'listed-twice', manifestOrder }
  const agree = indexOrder.length === manifestOrder.length && indexOrder.every((path, at) => path === manifestOrder[at])
  return agree ? { ok: true, order: manifestOrder } : { ok: false, reason: 'disagree', manifestOrder }
}

/** The files the Folio's folder holds now (the listing `folioPieces` resolves entries against). */
export async function presentInFolio(ws: Workspace, dir: string): Promise<Set<string>> {
  return new Set((await ws.listFilesIn(dir)).map((file) => file.path))
}

/** The assessment from one fresh read, with the Plan it was made from. */
export async function readOutlineOrder(ws: Workspace, dir: string): Promise<{ assessment: OutlineOrderAssessment; plan: Plan | null }> {
  const read = await readPlanWithManifest(ws, dir)
  if (!read) return { assessment: { ok: false, reason: 'no-index' }, plan: null }
  return { assessment: assessOutlineOrder(read.plan, read.loaded.manifest, await presentInFolio(ws, dir)), plan: read.plan }
}
