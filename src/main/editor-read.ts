import { lstat, stat } from 'node:fs/promises'
import type { EditorReadResult } from '../shared/editor-read'
import type { FileReadResult, Workspace } from './workspace'

export async function readEditorFile(workspace: Pick<Workspace, 'root' | 'readFile' | 'absolute'>, path: string): Promise<
  ({ kind: 'read' } & FileReadResult) | Exclude<EditorReadResult, { kind: 'read' | 'stale' }>
> {
  try {
    return { kind: 'read', ...(await workspace.readFile(path)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unavailable' }
  }
  // Validate the name through the same Workspace before checking its directory entry.
  let absolute: string
  try { absolute = workspace.absolute(path) } catch { return { kind: 'unavailable' } }
  // An absent file and an entry whose provider refuses to open it can both report ENOENT.
  // lstat sees an existing placeholder, including a dangling link.
  try {
    await lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      && await stat(workspace.root).then(info => info.isDirectory(), () => false)) return { kind: 'missing' }
  }
  return { kind: 'unavailable' }
}
