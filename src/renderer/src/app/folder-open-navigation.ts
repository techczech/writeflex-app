import { folioOpenTarget, type FolioOpenPart } from '../components/FolioOpenButton'

type FolderOpenReads = {
  declaration: (dir: string) => Promise<{ isFolio: boolean }>
  parts: (dir: string) => Promise<readonly FolioOpenPart[]>
  rememberedPath: (dir: string) => Promise<string | null | undefined>
}

/** All destination reads finish before the caller changes the current route. */
export async function readFolderOpenDestination(dir: string, isCurrent: () => boolean, reads: FolderOpenReads) {
  const { isFolio } = await reads.declaration(dir)
  if (!isCurrent()) return null
  if (!isFolio) return { isFolio, path: null }

  const parts = await reads.parts(dir)
  if (!isCurrent()) return null
  const remembered = await reads.rememberedPath(dir)
  if (!isCurrent()) return null
  const path = parts.find(part => part.path === remembered)?.path ?? folioOpenTarget(parts)
  return { isFolio, path }
}
