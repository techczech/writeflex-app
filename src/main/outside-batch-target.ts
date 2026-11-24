import { lstat } from 'node:fs/promises'
import type { Workspace } from './workspace'

export async function missingOutsideDocument(ws: Workspace, path: string): Promise<boolean> {
  if (ws.classifyPath(path) !== 'document') return false
  try {
    await lstat(ws.absolute(path))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}
