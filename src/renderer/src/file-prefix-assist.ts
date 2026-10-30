// Adapted from TalkWeaver talklist/prefixAssist.ts; no slide-text widening.
import {
  FILE_FIELD_PREFIXES, folderFrom, foldText, formatPrefixed, replaceToken, tokenizeFileQuery
} from './file-query'
export type FileFolderCount = { path: string; files: number }

export const MAX_COMPLETIONS = 8

export type CompletionItem =
  | { kind: 'prefix'; key: string; label: string; hint: string; insert: string }
  | { kind: 'folder'; key: string; label: string; count: number; insert: string }

export interface Completion {
  heading: string
  /** The token being completed: [start, end) into the query. */
  start: number
  end: number
  items: CompletionItem[]
}

export interface QueryEdit {
  query: string
  caret: number
}

/** How many files `fo:<value>` finds: the files of every folder whose path holds the value. */
export function filesForFolderTerm(folders: readonly FileFolderCount[], value: string): number {
  const v = foldText(value).trim()
  if (!v) return 0
  return folders.reduce((n, f) => n + (foldText(f.path).includes(v) ? f.files : 0), 0)
}

/** Folders for `fo:<value>`, each as the path from the segment the value matched
 *  (`fo:yo` → York-July-2026, York-July-2026 / day-1, …), with the files it would find.
 *  Folders whose name starts with the value first, then shallower, then by name. An empty
 *  value offers the top-level folders. */
export function folderCompletions(folders: readonly FileFolderCount[], value: string): CompletionItem[] {
  const v = foldText(value).trim()
  const inserts = new Set<string>()
  for (const f of folders) {
    if (!v) { if (!f.path.includes('/')) inserts.add(f.path); continue }
    const tail = folderFrom(f.path, v)
    if (tail) inserts.add(tail)
  }
  return [...inserts]
    .map((insert) => ({ insert, starts: foldText(insert).startsWith(v), depth: insert.split('/').length }))
    .sort((a, b) =>
      Number(b.starts) - Number(a.starts) ||
      a.depth - b.depth ||
      a.insert.localeCompare(b.insert))
    .slice(0, MAX_COMPLETIONS)
    .map(({ insert }): CompletionItem => ({
      kind: 'folder', key: `fo:${insert}`, label: insert.split('/').join(' / '), insert,
      count: filesForFolderTerm(folders, insert)
    }))
}

/** What the box offers for the token that ends at the caret, or null. */
export function completionAt(query: string, caret: number, folders: readonly FileFolderCount[]): Completion | null {
  const token = tokenizeFileQuery(query).find((t) => t.end === caret)
  if (!token) return null
  if (token.prefix === 'fo') {
    const items = folderCompletions(folders, token.value)
    // Nothing left to complete once the value is the one folder offered.
    if (items.length === 0 || (items.length === 1 && foldText(items[0].insert) === foldText(token.value))) return null
    return { heading: 'Folders', start: token.start, end: token.end, items }
  }
  if (token.prefix !== null || token.text.includes(':')) return null
  const typed = token.text.toLowerCase()
  const items = FILE_FIELD_PREFIXES
    .filter((p) => p.prefix.startsWith(typed))
    .map((p): CompletionItem => ({ kind: 'prefix', key: p.token, label: p.token, hint: p.hint, insert: p.token }))
  return items.length > 0 ? { heading: 'Prefixes', start: token.start, end: token.end, items } : null
}

/** The query after completing: a prefix leaves the caret after its colon (folders follow); a
 *  folder completes the term and a space. */
export function applyCompletion(query: string, completion: Completion, item: CompletionItem): QueryEdit {
  const before = query.slice(0, completion.start)
  const after = query.slice(completion.end)
  if (item.kind === 'prefix') return { query: `${before}${item.insert}${after}`, caret: before.length + item.insert.length }
  const term = formatPrefixed('fo', item.insert)
  const gap = /^\s/.test(after) ? '' : ' '
  return { query: `${before}${term}${gap}${after}`, caret: before.length + term.length + 1 }
}

/** A hint-row click types the prefix at the caret, apart from any word already there. */
export function insertPrefix(query: string, caret: number, prefix: string): QueryEdit {
  const at = Math.max(0, Math.min(caret, query.length))
  const before = query.slice(0, at)
  const after = query.slice(at)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  return { query: `${before}${lead}${prefix}${trail}${after}`, caret: before.length + lead.length + prefix.length }
}

// ── no results (frame L8) ───────────────────────────────────────────────────

export type Suggestion =
  | { kind: 'folder'; key: string; name: string; count: number; query: string }
  | { kind: 'drop'; key: string; label: string; query: string }

/** Fewest edits turning `term` into some stretch of `text` (Sellers' approximate substring). */
function substringDistance(term: string, text: string): number {
  let prev = new Array(text.length + 1).fill(0)
  for (let i = 1; i <= term.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= text.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (term[i - 1] === text[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return Math.min(...prev)
}

/** The folder name nearest a mistyped fo: value (`jersy` → jersey-2026), with the files it would
 *  find; null when the value already finds a folder or nothing is close. */
export function nearestFolder(folders: readonly FileFolderCount[], value: string): { name: string; count: number } | null {
  const v = foldText(value).trim()
  if (v.length < 2 || filesForFolderTerm(folders, v) > 0) return null
  const limit = Math.max(1, Math.floor(v.length / 3))
  const names = new Set(folders.flatMap((f) => f.path.split('/')))
  let best: { name: string; count: number; distance: number } | null = null
  for (const name of names) {
    const distance = substringDistance(v, foldText(name))
    if (distance > limit) continue
    const count = filesForFolderTerm(folders, name)
    const better = !best || distance < best.distance ||
      (distance === best.distance && (Math.abs(name.length - v.length) < Math.abs(best.name.length - v.length) ||
        (Math.abs(name.length - v.length) === Math.abs(best.name.length - v.length) && count > best.count)))
    if (better) best = { name, count, distance }
  }
  return best ? { name: best.name, count: best.count } : null
}


/** Nearest folder and term-removal suggestions, using the same tokens as search. */
export function noResultSuggestions(query: string, folders: readonly FileFolderCount[]): Suggestion[] {
  const tokens = tokenizeFileQuery(query).filter((t) => t.value.trim())
  const out: Suggestion[] = []
  const drops: Suggestion[] = []
  for (const token of tokens) {
    if (!token.prefix) continue
    const near = token.prefix === 'fo' ? nearestFolder(folders, token.value) : null
    if (near) {
      out.push({ kind: 'folder', key: `near:${token.start}`, name: near.name, count: near.count, query: replaceToken(query, token, formatPrefixed('fo', near.name)) })
    } else {
      drops.push({ kind: 'drop', key: `drop:${token.start}`, label: `Drop ${token.text}`, query: replaceToken(query, token, null) })
    }
  }
  out.push(...drops)
  return out
}
