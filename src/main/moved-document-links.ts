import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { parseMarkdown } from '../shared/markdown/dialect'
import type { Workspace } from './workspace'

/** Plan URL edits only; callers own verification, conditional writes and rollback. HTML and
 * wikilinks keep their existing repair coverage. Lezer supplies source spans, including definitions. */
export async function movedDocumentLinks(
  workspace: Workspace,
  source: string,
  from: string,
  to: string,
  movedTarget: (path: string) => string = (path) => path === from ? to : path,
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
    const target = movedTarget(oldTarget)
    const changesResolution = posix.normalize(posix.join(posix.dirname(to), decoded)) !== target
    const outside = oldTarget === '..' || oldTarget.startsWith('../')
    if (outside) {
      if (changesResolution) unrepairedReferences.unshift(`${to}: ${raw} was left unchanged because its target is outside the vault and the move changes its resolution.`)
      continue
    }
    try {
      const entry = await stat(workspace.absolute(oldTarget))
      if (!entry.isFile()) {
        if (entry.isDirectory() && changesResolution) unrepairedReferences.unshift(`${to}: ${raw} was left unchanged because it links to a folder and the move changes its resolution.`)
        continue
      }
    } catch { continue } // Already-broken links retain their exact bytes.
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
  return { content, references, destinations: [...destinations], unrepairedReferences }
}
