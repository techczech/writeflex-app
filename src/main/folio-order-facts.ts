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

import { readOutlineOrder } from './folio-order-assessment'
import { cachedFolioOrderFacts } from './folio-order-cache'
import { indexNoteExists, manifestOnlyAddable, readManifestOnly } from './folio-manifest-order'
import type { Workspace } from './workspace'

export type FolioOrderFacts = {
  /** The Outline may change this Folio's running order (the rule main's routes apply). */
  changeable: boolean
  /** The files Add will accept; empty when `changeable` is false. */
  addable: string[]
  /** Files the Plan reports as not in the running order, wherever they are; the caller keeps those inside the Folio's folder. */
  unlisted: string[]
}

const NONE: FolioOrderFacts = { changeable: false, addable: [], unlisted: [] }

async function loadFacts(ws: Workspace, dir: string): Promise<FolioOrderFacts> {
  if (!indexNoteExists(ws, dir)) {
    const read = await readManifestOnly(ws, dir)
    if (!read.assessment.ok) return NONE
    const addable = await manifestOnlyAddable(ws, dir, read)
    return { changeable: true, addable, unlisted: addable }
  }
  const { assessment, plan } = await readOutlineOrder(ws, dir)
  const unlisted = (plan?.unlisted ?? []).flatMap((part) => (part.path ? [part] : []))
  return {
    changeable: assessment.ok,
    addable: assessment.ok ? unlisted.filter((part) => part.manifestBacked === false).map((part) => part.path as string) : [],
    unlisted: unlisted.map((part) => part.path as string),
  }
}

/** The kept answer for a Folio folder, or a fresh one. A failed read answers "not changeable" and is not kept. */
export function folioOrderFacts(ws: Workspace, dir: string): Promise<FolioOrderFacts> {
  return cachedFolioOrderFacts(ws.root, dir, () => loadFacts(ws, dir)).catch(() => NONE)
}
