/**
 * A Folio's front matter as the export and the sidebar read it (ADR-0046), by the same rule as the Plan
 * (`partIsFrontMatter`, shared/folio-front-matter.ts): a running-order line tagged `#front-matter`, a manifest entry
 * whose role is `front-matter` or `title-matter`, or the manifest's `title_matter` file. Any one suffices. With an
 * Index Note the Plan's own reading of its parts is taken (plan.ts applies the rule to every line), so the Plan, the
 * Outline and the export cannot disagree; the manifest's entries are read as well, for a Folio with no Index Note
 * and for a listed file the running order does not name. The title page among them is the export's cover.
 * Read-only. Only files inside the Folio’s folder are ever read (`manifestPartEntries`, `titleMatterPath`).
 */

import { manifestPartEntries, readManifest, titleMatterPath, type Folio } from './folio'
import { parseFrontmatter } from './frontmatter'
import { readPlan, type Plan } from './plan'
import type { Workspace } from './workspace'
import { isAgentInstructionsName } from '../shared/folio-agent-files'
import { headerSaysTitlePage, isFrontMatterPart, partIsFrontMatter } from '../shared/folio-front-matter'

export { titleMatterPath }

export type FolioFrontMatter = {
  /** The front-matter parts: the running order's first, then any other the manifest marks, in manifest order. */
  front: readonly string[]
  /** The first front-matter part that is a title page (its header says `role: title-matter`, or it is the
   *  manifest's `title_matter` file); null when there is none, and the export then generates its cover. */
  titlePage: string | null
}

const NONE: FolioFrontMatter = { front: [], titlePage: null }

type Options = {
  /** `false`: read no part file (`titlePage` is then null). */
  findTitlePage?: boolean
  /** The Plan of this same read, when the caller has one (null: the folder has no Index Note); absent: read here. */
  plan?: Plan | null
}

/** The front matter of the Folio at `dir`; none when the folder declares no manifest and its running order tags none. */
export async function folioFrontMatter(ws: Workspace, dir: string, { findTitlePage = true, plan }: Options = {}): Promise<FolioFrontMatter> {
  const manifest = await readManifest(ws, dir)
  const read = plan === undefined ? await readPlan(ws, dir).catch(() => null) : plan
  const present = manifest ? new Set((await ws.listFilesIn(dir)).map((file) => file.path)) : new Set<string>()
  // The running order as the Plan reads it (a part's role is `front-matter` when any marker says so), then the manifest.
  const front = [...frontMatterPathSet(dir, manifest, present, read?.parts ?? [])].filter((path) => !isAgentInstructionsName(path))
  const titleMatter = manifest ? titleMatterPath(dir, manifest, present) : null
  if (!front.length) return NONE
  if (!findTitlePage) return { front, titlePage: null }
  let titlePage: string | null = null
  for (const path of front) {
    if (path === titleMatter) { titlePage = path; break }
    let content: string
    try { content = (await ws.readFile(path)).content } catch { continue }
    if (headerSaysTitlePage(parseFrontmatter(content)?.extra.role)) { titlePage = path; break }
  }
  return { front, titlePage }
}

/**
 * An export's pieces in the order they are exported (ADR-0046): the title page first of all, then the other front
 * matter, then the contents, each keeping the order it was given in. Pure.
 */
export function frontMatterExportOrder(paths: readonly string[], frontMatter: FolioFrontMatter): { titlePage: string | null; front: string[]; contents: string[] } {
  const isFront = new Set(frontMatter.front)
  const titlePage = frontMatter.titlePage !== null && paths.includes(frontMatter.titlePage) ? frontMatter.titlePage : null
  return {
    titlePage,
    front: paths.filter((path) => isFront.has(path) && path !== titlePage),
    contents: paths.filter((path) => !isFront.has(path)),
  }
}

export type FrontMatterLine = { path: string | null; role?: string; tags: readonly string[] }

/**
 * The paths of a Folio's front-matter parts by the one rule (`partIsFrontMatter`), from what the Plan and the manifest
 * readers already give: the running-order lines' roles and tags, the manifest's `files[].role`, and its `title_matter`
 * file (always front matter). In order: the running order's, then the manifest's, then `title_matter` when neither
 * names it. Sync and read-free; `folioFrontMatter` here and `readFolioFrontMatter` (plan.ts) do the reading.
 */
export function frontMatterPathSet(dir: string, manifest: Folio | null, present: ReadonlySet<string>, lines: readonly FrontMatterLine[]): Set<string> {
  const found = new Set<string>()
  const titleMatter = manifest ? titleMatterPath(dir, manifest, present) : null
  for (const line of lines) {
    if (line.path && isFrontMatterPart({ lineTags: line.role ? [line.role, ...line.tags] : line.tags, path: line.path })) found.add(line.path)
  }
  for (const { file, path } of manifest ? manifestPartEntries(dir, manifest, present) : []) {
    if (path && partIsFrontMatter({ entry: file, isTitleMatter: path === titleMatter })) found.add(path)
  }
  if (titleMatter) found.add(titleMatter)
  return found
}
