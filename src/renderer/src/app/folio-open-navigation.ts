import { folioOpenTarget, type FolioOpenPart } from '../components/FolioOpenButton'

export type FolioOpenContext = { workspace: string | null | undefined; dir: string | null }
export type FolioOpenDecision = { kind: 'editor'; dir: string; path: string } | { kind: 'empty' }

type Apply = (decision: FolioOpenDecision) => void

/** The explicit Open Folio route owns the lookup until another navigation takes over. */
export function createFolioOpenNavigation(readParts: (dir: string) => Promise<readonly FolioOpenPart[]>) {
  let bound: FolioOpenContext | null = null
  let generation = 0
  const retire = (): void => { generation += 1 }

  return {
    bind(context: FolioOpenContext | null): void {
      if (bound === context) return
      bound = context
      retire()
    },
    retire,
    async openDefault(context: FolioOpenContext, apply: Apply): Promise<void> {
      const { workspace, dir } = context
      if (context !== bound || !workspace || dir === null) return
      const request = ++generation
      const parts = await readParts(dir)
      if (request !== generation) return
      const path = folioOpenTarget(parts)
      apply(path === null ? { kind: 'empty' } : { kind: 'editor', dir, path })
    },
    openAt(context: FolioOpenContext, path: string, apply: Apply): void {
      const { workspace, dir } = context
      if (context !== bound || !workspace || dir === null) return
      retire()
      apply({ kind: 'editor', dir, path })
    },
  }
}
