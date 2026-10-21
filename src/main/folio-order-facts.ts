/**
 * What the Outline's Folio part needs to know about a Folio's running order besides the order itself:
 * whether the Outline may change it, which files Add will accept, and which files the Plan reports as
 * not in the running order. Computed once per Folio folder and kept (folio-order-cache.ts says when it
 * is dropped). Read-only, and only for drawing: the write routes read again under the lock.
 *
 * A Folio with an Index Note costs one Plan load (it lists the workspace and reads the titles of the
 * Folio's files); a Folio with a manifest and no Index Note costs one read of the manifest and one
 * listing of its folder.
 */

import { posix } from 'node:path'
import { manifestContentRootRefused, readManifest } from './folio'
import { readOutlineOrder } from './folio-order-assessment'
import { cachedFolioOrderFacts } from './folio-order-cache'
import { indexDeclaresPlan } from './folio-place'
import { indexNoteExists, manifestOnlyAddable, readManifestOnly } from './folio-manifest-order'
import { folioFrontMatter } from './folio-front-matter'
import { namedAfterManifestAdd, readFolioPlan, type Plan } from './plan'
import type { Workspace } from './workspace'

export type FolioOrderFacts = {
  /** The Outline may change this Folio's running order (the rule main's routes apply). */
  changeable: boolean
  /** The files Add will accept; empty when `changeable` is false. */
  addable: string[]
  /** Files the Plan reports as not in the running order, wherever they are; the caller keeps those inside the Folio's folder. */
  unlisted: string[]
  /** The folder the Folio takes its pieces from: `content_root` when it has an accepted one, else the Folio folder. */
  root: string
  /** False for a refused `content_root`: only the Folio folder's direct children are listed then. */
  deep: boolean
  /** The running-order pieces that are front matter (ADR-0046: a `#front-matter` line, a front-matter manifest entry, or the `title_matter` file). */
  frontMatter: string[]
  /** The Plan's running order (files of the parts that name one, in order) when the Folio has an Index Note whose Plan has parts (its running order, or the manifest's order the Plan reads when the Index Note names none), or has no Index Note (the order the Folio page reads, `readFolioPlan`); null otherwise (the manifest order stands). */
  order: string[] | null
}

const NONE = (dir: string): FolioOrderFacts => ({ changeable: false, addable: [], unlisted: [], root: dir, deep: false, frontMatter: [], order: null })

/** The Folio's front-matter pieces, by the rule the Plan and the export use (main/folio-front-matter.ts). `plan`: the Plan of this read (null: no Index Note). */
async function frontMatterOf(ws: Workspace, dir: string, plan: Plan | null): Promise<{ frontMatter: string[] }> {
  return { frontMatter: [...(await folioFrontMatter(ws, dir, { findTitlePage: false, plan })).front] }
}

/** The piece root of a Folio folder, from its manifest. */
async function pieceRoot(ws: Workspace, dir: string): Promise<{ root: string; deep: boolean }> {
  const manifest = await readManifest(ws, dir)
  if (!manifest?.contentRoot) return { root: dir, deep: manifest ? !manifest.contentRootRefused : true }
  if (manifestContentRootRefused(dir, manifest)) return { root: dir, deep: false }
  return { root: posix.join(dir, manifest.contentRoot), deep: true }
}

async function loadFacts(ws: Workspace, dir: string): Promise<FolioOrderFacts> {
  if (!indexNoteExists(ws, dir)) {
    const read = await readManifestOnly(ws, dir)
    // The Folio page reads this Folio as its first Index Note would (plan.ts `readFolioPlan`, `withManifestOrder`); the
    // Outline takes that very order, so the two never disagree: an entry no running-order line can name is out of
    // both. The Outline's own writes (the manifest alone) are offered only for a manifest they can change exactly and
    // while the page's order is that manifest's; otherwise the order is the page's to change. A page read that fails
    // leaves the manifest's order standing (the page shows its refusal, not an order).
    const plan = await readFolioPlan(ws, dir).catch(() => null)
    const order = plan ? plan.parts.flatMap((part) => (part.path ? [part.path] : [])) : null
    const shared = { order, ...(await pieceRoot(ws, dir)), ...(await frontMatterOf(ws, dir, null)) }
    const pageUnlisted = (plan?.unlisted ?? []).flatMap((part) => (part.path ? [part.path] : []))
    if (!read.assessment.ok) return { ...NONE(dir), ...shared, unlisted: plan ? pageUnlisted : [] }
    const manifestOrder = read.assessment.order
    const notInOrder = await manifestOnlyAddable(ws, dir, read)
    const agrees = order === null || (order.length === manifestOrder.length && order.every((path, at) => path === manifestOrder[at]))
    // Add is offered only for a file the page's order would name once Add lists it (`namedAfterManifestAdd`): never an
    // Add that succeeds and leaves the file "Not in the outline" on both surfaces (Sol round 3).
    const named = agrees && notInOrder.length ? await namedAfterManifestAdd(ws, dir, notInOrder) : new Set<string>()
    const addable = notInOrder.filter((path) => named.has(path))
    return agrees
      ? { ...shared, changeable: true, addable, unlisted: notInOrder }
      : { ...shared, changeable: false, addable: [], unlisted: pageUnlisted }
  }
  const { assessment, plan } = await readOutlineOrder(ws, dir)
  const unlisted = (plan?.unlisted ?? []).flatMap((part) => (part.path ? [part] : []))
  return {
    changeable: assessment.ok,
    addable: assessment.ok ? unlisted.filter((part) => part.manifestBacked === false && !part.putBackRefusal).map((part) => part.path as string) : [],
    unlisted: unlisted.map((part) => part.path as string),
    // An Index Note that names no part (plain `- Title` lines are not parts) shows the manifest's order: the Plan reads it
    // as its running order (`orderFrom: 'manifest'`, plan.ts `withManifestOrder`), so the Outline takes the Plan's parts,
    // the very list the Folio page shows, even when that list is shorter than the manifest's (an entry no line can
    // name is "Not in the outline" on both). Null only when the Plan reads no order at all: the manifest order stands.
    order: plan && (plan.orderFrom === 'manifest' || (plan.parts.length > 0 && (await indexDeclaresPlan(ws, dir)))) ? plan.parts.flatMap((part) => (part.path ? [part.path] : [])) : null,
    ...(await pieceRoot(ws, dir)),
    ...(await frontMatterOf(ws, dir, plan ?? null)),
  }
}

/** The kept answer for a Folio folder, or a fresh one. A failed read answers "not changeable" and is not kept. */
export function folioOrderFacts(ws: Workspace, dir: string): Promise<FolioOrderFacts> {
  return cachedFolioOrderFacts(ws.root, dir, () => loadFacts(ws, dir)).catch(() => NONE(dir))
}
