import { readdir } from 'node:fs/promises'
import type { Workspace } from './workspace'
/** Every file beneath `dir` (not symbolic links, nothing hidden), as workspace-relative paths, bounded. Read only. */
export async function folioFiles(ws: Workspace, dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 8 || out.length >= 2000) return
    let entries
    try {
      // `Workspace.absolute('')` refuses the root, which is exactly where a root-level Folio's files sit.
      entries = await readdir(rel === '' ? ws.root : ws.absolute(rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (ws.isVisiblePath(`${child}/file.md`)) await walk(child, depth + 1)
      } else if (entry.isFile() && out.length < 2000) out.push(child)
    }
  }
  await walk(dir, 0)
  return out
}

