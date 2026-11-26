import { existsSync } from 'node:fs'
import { basename, dirname, posix } from 'node:path'
import { fileNameProblem } from '../shared/file-name-rules'
import type { Workspace } from './workspace'

/** The Files field takes the stem, with the Markdown extension drawn beside it. */
export function markdownNameProblem(name: string): string | null {
  return fileNameProblem(name) ?? fileNameProblem(name.replace(/\.(?:md|markdown|mdx)$/i, ''))
}

/** Check only names a write would introduce. Existing parent folders can still be used. */
export function newPathNameProblem(
  workspace: Workspace,
  path: string,
  { markdown = false, keepNameOf }: { markdown?: boolean; keepNameOf?: string } = {},
): string | null {
  const name = posix.basename(path)
  if (keepNameOf === undefined || name !== posix.basename(keepNameOf)) {
    const problem = markdown ? markdownNameProblem(name) : fileNameProblem(name)
    if (problem) return problem
  }
  for (let parent = dirname(workspace.absolute(path)); !existsSync(parent); parent = dirname(parent)) {
    const problem = fileNameProblem(basename(parent))
    if (problem) return problem
  }
  return null
}
