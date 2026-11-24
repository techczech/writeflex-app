import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { Workspace } from './workspace'
import { isMarkdownPath } from './writeflex-url'

export type DocumentLocationRequest = { path: string; location: 'default-app' | 'containing-folder' }

type DocumentLocationShell = {
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

export async function openDocumentLocation(
  workspace: Workspace,
  { path, location }: DocumentLocationRequest,
  shell: DocumentLocationShell,
): Promise<void> {
  if (location !== 'default-app' && location !== 'containing-folder') throw new Error('Unknown file location action.')
  if (typeof path !== 'string' || isAbsolute(path) || !isMarkdownPath(path) || workspace.classifyPath(path) !== 'document') {
    throw new Error('Choose a document in the open vault.')
  }

  const absolute = workspace.absolute(path)
  let real: string
  try { real = realpathSync(absolute) }
  catch { throw new Error('That document is no longer in the open vault.') }

  const within = relative(realpathSync(workspace.root), real)
  if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + sep) || !isMarkdownPath(real)) {
    throw new Error('Choose a document in the open vault.')
  }
  if (!statSync(real, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('That document is no longer in the open vault.')
  }

  if (location === 'containing-folder') {
    // Opening a directory through Launch Services may launch a package. Reveal the file in Finder.
    shell.showItemInFolder(absolute)
    return
  }
  const failure = await shell.openPath(real)
  if (failure) throw new Error(failure)
}
