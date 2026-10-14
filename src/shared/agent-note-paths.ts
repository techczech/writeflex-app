/**
 * One spelling for "which document is this note about". `notes.create` writes `source_document`
 * workspace-relative and `.md`-suffixed; a hand-written or older note may spell the same file
 * `./essays//metaphor`. Both the main-side lister and the Agent notes pane compare through here,
 * so a note is matched to the open piece by the document it names, not by the string it used.
 */
const MARKDOWN_EXTENSION = /\.(md|markdown)$/i

export function normaliseWorkspaceDocumentPath(path: string): string {
  const segments = path.trim().normalize('NFC').replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { out.pop(); continue }
    out.push(segment)
  }
  const joined = out.join('/')
  if (!joined) return ''
  return MARKDOWN_EXTENSION.test(joined) ? joined : `${joined}.md`
}

export function sameWorkspaceDocument(left: string, right: string): boolean {
  const a = normaliseWorkspaceDocumentPath(left)
  return a !== '' && a === normaliseWorkspaceDocumentPath(right)
}

/** The folder a workspace-relative path sits in ('' at the root). */
export function workspaceDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}
