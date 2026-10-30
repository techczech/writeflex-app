import type { FolioPlaceKind } from '../../../shared/folio-place'
import { routeForOpenedFile, type PartRoute } from '../../../shared/folio-surface'

/**
 * Where a Folio, or a file inside one, opens (ADR-0049). Both answers ask main and write nothing but the workspace's own
 * tab state; the App applies the answer. Kept apart from App.tsx so each is tested without a window.
 */

/** What the routing says when it cannot send a part to its workspace's Text tab. The user stays where they were. */
export const PART_ROUTE_REFUSAL = 'Could not open that part in its Folio. Nothing was changed; try opening it again.'

/** Folder identity is read once in main; renderer applies the same answer. */
export type FolderFolioApi = { readFolioDeclaration: (dir: string) => Promise<{ isFolio: boolean }> }
export async function folderIsFolio(dir: string, api: FolderFolioApi): Promise<boolean> {
  return (await api.readFolioDeclaration(dir).catch(() => null))?.isFolio ?? false
}

export type PartRouting =
  | { kind: 'editor' }
  | { kind: 'workspace'; route: PartRoute }
  | { kind: 'refused'; message: string }

/**
 * Route a file that was opened: main says where it sits, a part's workspace is told to show it in the Text tab (with
 * the part selected, Split off), and only then does the App open that workspace. A failure at either step is a refusal:
 * the App stays where it was and says so, instead of landing on the workspace's remembered tab.
 */
export async function routeOpenedPart(path: string, api: {
  readFolioPlace: (path: string) => Promise<{ dir: string; kind: FolioPlaceKind } | null>
  setState: (dir: string, patch: PartRoute['patch']) => Promise<boolean>
  readPlan: (dir: string) => Promise<unknown | null>
}, editingDir: string | null = null): Promise<PartRouting> {
  // Main rejects a path outside the workspace: that file is in no Folio, so it opens in the editor, not a refusal.
  let route: PartRoute | null
  try { route = routeForOpenedFile(path, await api.readFolioPlace(path)) } catch { return { kind: 'editor' } }
  if (route === null) return { kind: 'editor' }
  // Open Folio is an explicit editing mode. Subsequent sidebar/heading/part navigation within that
  // Folio must stay in the editor, without changing the workspace's remembered view or selection.
  if (route.dir === editingDir) return { kind: 'editor' }
  // The Collection view opens the workspace only when the Plan reads; routing there without it would loop back to the plain list.
  try { if (!(await api.readPlan(route.dir))) return { kind: 'editor' } } catch { return { kind: 'editor' } }
  try {
    if ((await api.setState(route.dir, route.patch)) === false) return { kind: 'refused', message: PART_ROUTE_REFUSAL }
  } catch { return { kind: 'refused', message: PART_ROUTE_REFUSAL } }
  return { kind: 'workspace', route }
}
