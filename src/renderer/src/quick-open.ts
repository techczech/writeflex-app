import { fuzzyScore } from './fuzzy'

/**
 * Quick open (⇧⌘K, house rule R12): fuzzy matching on a file's TITLE and on its FILE NAME and folder, whichever
 * scores better. Every file is a candidate: what "Writing only" hides in the Files pane is still found here,
 * and is marked as hidden so the person sees why it is not in the tree.
 */
export type QuickOpenHit = { path: string; title: string | null; hidden: boolean }

export function isHiddenByView(path: string, hiddenPaths: readonly string[]): boolean {
  return hiddenPaths.some((hidden) => path === hidden || path.startsWith(`${hidden}/`))
}

export function quickOpenFiles(
  query: string,
  paths: readonly string[],
  options: { titles?: Readonly<Record<string, string>>; hiddenPaths?: readonly string[]; limit?: number } = {},
): QuickOpenHit[] {
  const { titles = {}, hiddenPaths = [], limit = 50 } = options
  const hit = (path: string): QuickOpenHit => ({ path, title: titles[path] ?? null, hidden: isHiddenByView(path, hiddenPaths) })
  if (query.trim() === '') return paths.slice(0, limit).map(hit)
  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const byPath = fuzzyScore(query, path)
    const title = titles[path]
    const byTitle = title ? fuzzyScore(query, title) : null
    const score = byPath === null ? byTitle : byTitle === null ? byPath : Math.max(byPath, byTitle)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.length - b.path.length))
  return scored.slice(0, limit).map((entry) => hit(entry.path))
}
