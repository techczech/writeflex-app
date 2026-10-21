/** Export titles are declared metadata, independent of the heading-derived editor listing (ADR-0034).
 * Never substitute an on-disk locator for a reader-facing title. Reading never repairs source files. */
import { documentTitle, parseFrontmatter } from './frontmatter'
import { collectionCoverPaths, folioPieces, indexNotePath, readManifest, resolveManifestFilePath } from './folio'
import { folioFrontMatter } from './folio-front-matter'
import { partTitle } from '../shared/folio-part-title'
import { isAgentInstructionsName } from '../shared/folio-agent-files'
import type { Workspace } from './workspace'

/** XML 1.0 disallows these controls and lone surrogates even in escaped Word properties.
 * Unicode mode preserves valid surrogate pairs (including supplementary-plane title text). */
export function normaliseExportTitle(title: string): string | null {
  return title.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/gu, '').trim() || null
}

function declaredTitle(source: string): string | null {
  const title = parseFrontmatter(source)?.title
  return title === undefined ? null : normaliseExportTitle(title)
}

function headingTitle(source: string): string | null {
  // An empty locator makes documentTitle's no-heading fallback empty, rather than a file stem.
  return normaliseExportTitle(documentTitle(source, ''))
}

export function exportDocumentTitle(source: string, folioPartPath?: string): string {
  const declared = declaredTitle(source)
  if (declared) return declared
  if (folioPartPath !== undefined) {
    // A missing part title does not promote its first subsection to the title.
    const part = partTitle(source, folioPartPath)
    return (part.from === 'heading' ? normaliseExportTitle(part.title) : null) ?? 'Untitled document'
  }
  return headingTitle(source) ?? 'Untitled document'
}

/**
 * THE title of a Collection's export: the browser title, the generated or title-page cover, the Word properties, the
 * Export sheet and the suggested file name all take this one answer. In order: the Folio's Details title (its Index
 * Note's declared `title`, what the Details card writes), the title page's declared title, the manifest's title, then
 * the older fallbacks (title-matter and cover metadata, then those documents' headings). Title matter and the title
 * page use the same path and containment rules as every other Folio reader. `buffers`: open, unsaved texts by path.
 */
export async function exportCollectionTitle(workspace: Workspace, dir: string, buffers: ReadonlyMap<string, string> = new Map()): Promise<string> {
  const manifest = await readManifest(workspace, dir)
  const present = new Set((await workspace.listFiles()).map(file => file.path))
  const read = async (path: string): Promise<string | null> => {
    if (buffers.has(path)) return buffers.get(path)!
    if (!present.has(path)) return null
    try { return (await workspace.readFile(path)).content } catch { return null }
  }
  const index = await read(indexNotePath(workspace, dir))
  const details = index === null ? null : declaredTitle(index)
  if (details) return details
  const page = await exportTitlePage(workspace, dir)
  const pageSource = page && !isAgentInstructionsName(page) ? await read(page) : null
  const pageTitle = pageSource === null ? null : declaredTitle(pageSource)
  if (pageTitle) return pageTitle
  const title = manifest?.title === undefined ? null : normaliseExportTitle(manifest.title)
  if (title) return title
  const titleMatter = manifest?.titleMatter
    ? resolveManifestFilePath(dir, manifest, { path: manifest.titleMatter }, present)
    : null
  const paths = [...new Set([
    ...(titleMatter && !isAgentInstructionsName(titleMatter) ? [titleMatter] : []),
    ...collectionCoverPaths(workspace, dir).filter(path => present.has(path) || buffers.has(path)),
  ])]
  const sources: string[] = []
  for (const path of paths) sources.push(buffers.get(path) ?? (await workspace.readFile(path)).content)
  for (const source of sources) {
    const title = declaredTitle(source)
    if (title) return title
  }
  for (const source of sources) {
    const title = headingTitle(source)
    if (title) return title
  }
  return manifest ? 'Untitled Folio' : 'Untitled collection'
}

/** The title page an export of the Folio at `dir` draws as its cover (folio-front-matter.ts, by the export's own
 *  rule: only one the Folio lists); null when there is none. */
async function exportTitlePage(workspace: Workspace, dir: string): Promise<string | null> {
  const listed = (await folioPieces(workspace, dir))?.pieces
  if (!listed) return null
  const { titlePage } = await folioFrontMatter(workspace, dir)
  return titlePage !== null && listed.includes(titlePage) ? titlePage : null
}
