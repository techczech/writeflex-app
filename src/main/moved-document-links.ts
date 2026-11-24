import { lstat, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { posix } from 'node:path'
import { parseMarkdown } from '../shared/markdown/dialect'
import { movedFrontMatterPaths } from './moved-front-matter-paths'
import type { Workspace } from './workspace'

/** Plan URL edits only; callers own verification, conditional writes and rollback. HTML and
 * wikilinks keep their existing repair coverage. Lezer supplies source spans, including definitions. */
export async function movedDocumentLinks(
  workspace: Workspace,
  source: string,
  from: string,
  to: string,
  locate: LocateTarget = mappedLocator(workspace, (path) => path === from ? to : path),
): Promise<{ content: string; references: string[]; destinations: string[]; unrepairedReferences: string[] }> {
  const urls: Array<{ from: number; to: number }> = []
  parseMarkdown(source).iterate({ enter(node) {
    if (['CodeBlock', 'FencedCode', 'InlineCode'].includes(node.name)) return false
    if (node.name === 'URL') urls.push({ from: node.from, to: node.to })
  } })
  let content = source
  const references: string[] = []
  const destinations = new Set<string>()
  const unrepairedReferences: string[] = []
  for (const span of urls.reverse()) {
    const raw = source.slice(span.from, span.to)
    const angle = raw.startsWith('<') && raw.endsWith('>')
    const url = angle ? raw.slice(1, -1) : raw
    if (!url || /^(?:[/\\#?]|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(url)) continue
    const suffixAt = url.search(/[?#]/)
    const path = suffixAt < 0 ? url : url.slice(0, suffixAt)
    const suffix = suffixAt < 0 ? '' : url.slice(suffixAt)
    let decoded: string
    try { decoded = decodeURIComponent(path.replace(/\\([\\() ])/g, '$1')) } catch { continue }
    if (posix.isAbsolute(decoded) || decoded.startsWith('\\')) continue
    const oldTarget = posix.normalize(posix.join(posix.dirname(from), decoded))
    const newResolution = posix.normalize(posix.join(posix.dirname(to), decoded))
    const outside = oldTarget === '..' || oldTarget.startsWith('../')
    if (outside) {
      if (newResolution !== oldTarget) unrepairedReferences.unshift(`${to}: ${raw} was left unchanged because its target is outside the vault and the move changes its resolution.`)
      continue
    }
    const located = await locate(oldTarget).catch(() => null)
    if (!located) continue // Already-broken links retain their exact bytes.
    const { target, entry } = located
    const changesResolution = newResolution !== target
    if (!entry.isFile()) {
      if (entry.isDirectory() && changesResolution) unrepairedReferences.unshift(`${to}: ${raw} was left unchanged because it links to a folder and the move changes its resolution.`)
      continue
    }
    if (!changesResolution) continue
    let relative = posix.relative(posix.dirname(to), target)
    if (!relative) continue
    if (path.startsWith('./') && !relative.startsWith('../')) relative = `./${relative}`
    // Reuse each authored segment verbatim, preserving mixed encoding and percent-escape case.
    const segments = new Map(path.split('/').map((part) => {
      try { return [decodeURIComponent(part), part] } catch { return [part, part] }
    }))
    const encoded = relative.split('/').map((part) => segments.get(part)
      ?? (/%[0-9a-f]{2}/i.test(path) || /[#?%<>\[\]\\]/.test(part) || (!angle && /[\s()]/.test(part)) ? encodeURIComponent(part).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : part)).join('/')
    const next = `${angle ? '<' : ''}${encoded}${suffix}${angle ? '>' : ''}`
    if (next === raw) continue
    content = `${content.slice(0, span.from)}${next}${content.slice(span.to)}`
    references.unshift(`${to}: ${raw}`)
    destinations.add(target)
  }
  // Plain paths in front matter (`image: ../img/cover.png`) reach their files as links do.
  const frontMatter = await movedFrontMatterPaths(content, from, to, async (oldTarget) => {
    const found = await locate(oldTarget)
    return found?.entry.isFile() ? found.target : null
  })
  content = frontMatter.content
  references.unshift(...frontMatter.references)
  for (const target of frontMatter.destinations) destinations.add(target)
  return { content, references, destinations: [...destinations], unrepairedReferences }
}

/** Where a link's old target is now: the file it reaches, and the path that file has once the moves are made.
 *  Null when nothing is there (the link is already broken and keeps its bytes). */
export type LocateTarget = (oldTarget: string) => Promise<{ target: string; entry: Stats } | null>

/** The file at the link's old path, which will be at `moved(oldTarget)` once the move is made. */
export function mappedLocator(workspace: Workspace, moved: (path: string) => string): LocateTarget {
  return async (oldTarget) => {
    const entry = await stat(workspace.absolute(oldTarget)).catch(() => null)
    return entry ? { target: moved(oldTarget), entry } : null
  }
}

const sameFile = (left: Stats, right: Stats | null): boolean => Boolean(right && left.dev === right.dev && left.ino === right.ino)

/**
 * Locating link targets during one move of a batch (the Collection's multi-select move), where `moves` are the
 * moves already made in it (from → to) and `moving` is this move.
 * - A file at the link's old path is the file the writer means, even when an earlier move of the batch started
 *   from that path: a document written there since is never traded for the one that left.
 * - Only when nothing is there is the batch asked where the document went: by exact path, or on a volume that
 *   ignores case, by the same path in another case. The file found there is the target.
 * - A link that reaches the document being moved (the same file on disk, whatever case it is written in)
 *   names its new place.
 */
export async function batchLocator(
  workspace: Workspace,
  moves: ReadonlyMap<string, string>,
  moving: { from: string; to: string },
): Promise<LocateTarget> {
  const movingFile = await stat(workspace.absolute(moving.from)).catch(() => stat(workspace.absolute(moving.to)).catch(() => null))
  return async (oldTarget) => {
    const live = await stat(workspace.absolute(oldTarget)).catch(() => null)
    if (live) return { entry: live, target: oldTarget === moving.from || (live.isFile() && sameFile(live, movingFile)) ? moving.to : oldTarget }
    const went = await earlierMove(workspace, moves, oldTarget)
    if (!went) return null
    const entry = await stat(workspace.absolute(went)).catch(() => null)
    return entry ? { target: went, entry } : null
  }
}

async function earlierMove(workspace: Workspace, moves: ReadonlyMap<string, string>, oldTarget: string): Promise<string | null> {
  const exact = moves.get(oldTarget)
  if (exact !== undefined) return exact
  const folded = oldTarget.toLocaleLowerCase()
  const candidates = [...moves].filter(([from]) => from.toLocaleLowerCase() === folded)
  if (candidates.length !== 1) return null
  const went = candidates[0][1]
  // The same name in another case reaches the same file only on a volume that ignores case: asked of the file
  // where it went, which is there to ask.
  const actual = await lstat(workspace.absolute(went)).catch(() => null)
  const swapped = await lstat(workspace.absolute(swapCase(went))).catch(() => null)
  return actual && swapped && sameFile(actual, swapped) && swapCase(went) !== went ? went : null
}

const swapCase = (text: string): string =>
  [...text].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('')
