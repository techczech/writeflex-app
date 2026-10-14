export type DroppedPath = { path: string; kind: 'file' | 'directory' }
export type DropClassification =
  | { openable: true; path: DroppedPath }
  | { openable: false; reason: string }

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(path)
}

/** External drops are deliberately all-or-nothing: a mixed selection must not open one item and
 * silently ignore the rest. */
export function classifyExternalDrop(paths: DroppedPath[]): DropClassification {
  if (paths.length === 0) return { openable: false, reason: 'WriteFlex opens Markdown files and folders.' }
  const offender = paths.find((item) => item.kind === 'file' && !isMarkdownPath(item.path))
  if (offender) return { openable: false, reason: `WriteFlex opens Markdown files and folders, not ${offender.path.split('/').at(-1) ?? offender.path}.` }
  if (paths.length > 1) return { openable: false, reason: 'Drop one Markdown file or folder at a time.' }
  return { openable: true, path: paths[0]! }
}
