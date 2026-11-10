import { activateFolioDeclaration } from './folio-declaration'
import { MANIFEST_NAME, assertManifestAbsent } from './folio'
import { NameTaken, type Workspace } from './workspace'

/**
 * Make Folio's write, after the writer confirmed (Sol round 2, S1). The confirm card and the renderer's flush are
 * awaited, so an agent, another create request or another program can put a manifest in the folder before this
 * runs. Absence is checked again inside the workspace's write turn, immediately before the write, and the manifest is
 * created, never replaced (an exclusive link, EEXIST refused), so a manifest that appears even after that check is kept.
 */
export async function createFolioManifest(ws: Workspace, dir: string, draft: string, reportSkipped?: (message: string) => void): Promise<Awaited<ReturnType<Workspace['saveFile']>>> {
  const path = dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME
  return ws.exclusiveAll(async () => {
    await assertManifestAbsent(ws, dir, reportSkipped)
    let saved: Awaited<ReturnType<Workspace['saveFile']>>
    try {
      saved = await ws.saveFile(path, draft, { exclusive: true })
    } catch (error) {
      if (error instanceof NameTaken) throw new Error(`A Folio manifest appeared in ${dir || 'the workspace root'} while Make Folio was waiting. Nothing was replaced.`)
      throw error
    }
    await activateFolioDeclaration(ws, dir)
    return saved
  })
}
