import { isAbsolute, relative } from 'node:path'
import type { Workspace } from '../workspace'
import { CliError } from './operation'

const MARKDOWN = /\.(?:md|markdown|mdx)$/i

/**
 * A Collection-relative path the sidebar would show, as `Workspace.classifyPath` judges it: the typed
 * path and its real location on disk (links resolved) must both stay inside the Collection and clear
 * of dot-folders and ignored folders, where the app keeps its own stores. An absolute path inside the
 * Collection is accepted and made relative. `allowRoot` lets "" (the Collection root) through for
 * folder arguments. A `markdown` argument is a file; anything else is a folder.
 *
 * THE PATH IS USED EXACTLY AS GIVEN. Nothing is trimmed: a file named ` york.md` (with the space) and
 * `york.md` are two files, and an argument names the one whose characters it holds. An empty path is
 * refused.
 */
export function visiblePath(ws: Workspace, input: string, opts: { markdown?: boolean; allowRoot?: boolean } = {}): string {
  const raw = input
  if (raw === '' || raw === '.' || raw === '/') {
    if (opts.allowRoot) return ''
    throw new CliError('A path is needed.', 'usage')
  }
  const typed = isAbsolute(raw) ? relative(ws.root, raw) : raw
  const verdict = ws.classifyPath(typed, opts.markdown ? 'file' : 'folder')
  if (verdict === 'outside') throw new CliError(`${input} is outside the Collection at ${ws.root}.`)
  if (verdict === 'hidden') {
    throw new CliError(`${input} is under a dot-folder or an ignored folder, which is not part of the Collection.`)
  }
  const rel = ws.relative(ws.absolute(typed))
  if (opts.markdown && !MARKDOWN.test(rel)) throw new CliError(`${input} is not a Markdown file.`)
  return rel
}

/** `path` with `.md` added when it has no Markdown extension. Nothing else about it changes: no trimming. */
export function markdownPath(path: string): string {
  if (path === '') throw new CliError('A path is needed.', 'usage')
  return MARKDOWN.test(path) ? path : `${path}.md`
}
