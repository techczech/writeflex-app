/**
 * The Details card's pickers read the Workspace (0.26): the Author, Audience and Language values other files
 * already use, most used first, with the writer's own name offered first for Author. Read-only: nothing is written
 * and no file is created. Header facts come through the per-file facts cache (file-facts.ts), so a second look reads
 * only the files that changed.
 */

import { detailItemsInHeader } from './folio-details'
import { factsReader } from './file-facts'
import type { Workspace } from './workspace'
import type { FolioDetailField, FolioDetailUsedValue, FolioDetailValues } from '../shared/folio-details'

type Counted = 'author' | 'audience' | 'language'
const COUNTED: readonly Counted[] = ['author', 'audience', 'language']

/** The most values a picker is given for one field (the commonest first). */
export const DETAIL_VALUES_KEPT = 60

type Header = Record<Counted, string[]>

const headerOf = (text: string): Header => ({
  author: detailItemsInHeader(text, 'author'),
  audience: detailItemsInHeader(text, 'audience'),
  language: detailItemsInHeader(text, 'language'),
})

/** Most used first, then alphabetical, so equal counts keep a stable order; `you` is kept off the list and added by the caller. */
function ranked(counts: Map<string, number>): FolioDetailUsedValue[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, DETAIL_VALUES_KEPT)
}

export async function workspaceDetailValues(ws: Workspace, you: string | null): Promise<FolioDetailValues> {
  const files = await ws.listFiles()
  const reader = await factsReader(ws, files, files)
  const counts: Record<Counted, Map<string, number>> = { author: new Map(), audience: new Map(), language: new Map() }
  for (const file of files) {
    let header: Header
    try { header = (await reader.read(file)).derive('folio-detail-header', headerOf) } catch { continue }
    for (const field of COUNTED) {
      // Once per file: a value named twice in one header is one file.
      for (const value of new Set(header[field])) counts[field].set(value, (counts[field].get(value) ?? 0) + 1)
    }
  }
  const author = ranked(counts.author)
  const yours = you === null ? undefined : author.find((entry) => entry.value.toLocaleLowerCase() === you.toLocaleLowerCase())
  return {
    you,
    // You first, whether or not any file names you yet.
    author: you === null ? author : [yours ?? { value: you, count: 0 }, ...author.filter((entry) => entry !== yours)],
    audience: ranked(counts.audience),
    language: ranked(counts.language),
  }
}

export type { FolioDetailField }
