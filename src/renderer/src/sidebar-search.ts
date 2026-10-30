import type { MarkdownFile } from '../../preload'
import { isPathInSearchScope } from '../../shared/search-scope'
import { datePartsMatch, foldText, parseDateQuery, tokenizeFileQuery } from './file-query'
import type { TreeNode } from './sidebar-tree'
import type { FileFolderCount } from './file-prefix-assist'

type SearchMetadata = { works: readonly { path: string; title: string; status: string | null }[] }

/** Build once per loaded listing/view. Queries never read disk or rebuild the hierarchy.
 * Like TalkWeaver, all terms must match and the worst matching field determines the tier.
 * Direct folder hits precede inherited folder-path hits; exact names precede partial names. */
export function createSidebarSearch(nodes: TreeNode[], files: MarkdownFile[], metadata?: SearchMetadata | null): {
  folders: FileFolderCount[]
  search: (query: string) => TreeNode[]
} {
  const fileByPath = new Map(files.map((f) => [f.path, f]))
  const workByPath = new Map(metadata?.works.map((w) => [w.path, w]) ?? [])
  const docs: { node: TreeNode; title: string; file: string; stem: string; folder: string; details: string; date: Date | null }[] = []
  const folders: FileFolderCount[] = []
  const walk = (level: TreeNode[]): number => {
    let count = 0
    for (const node of level) {
      if (!isPathInSearchScope(node.path)) continue
      const work = workByPath.get(node.path)
      const listed = fileByPath.get(node.path)
      docs.push({ node, title: foldText(node.label ?? node.name), file: node.kind === 'file' ? foldText(node.name) : '', stem: foldText(node.name.replace(/\.md$/i, '')), folder: foldText(node.kind === 'folder' ? node.path : listed?.directory ?? node.path.slice(0, Math.max(0, node.path.lastIndexOf('/')))), details: foldText([work?.title, work?.status].filter(Boolean).join(' ')), date: listed ? new Date(listed.modifiedAt) : null })
      if (node.kind === 'folder') {
        const children = walk(node.children)
        folders.push({ path: node.path, files: node.children.filter((child) => child.kind === 'file' && isPathInSearchScope(child.path)).length })
        count += children
      } else count += 1
    }
    return count
  }
  walk(nodes)
  return {
    folders,
    search(query) {
      const terms = tokenizeFileQuery(query).filter((t) => t.value.trim()).map((t) => ({ ...t, value: foldText(t.value.trim()), date: t.prefix === 'da' ? parseDateQuery(t.value) : null }))
      if (!terms.length) return []
      const hits: { node: TreeNode; tier: number; sum: number; exact: number }[] = []
      for (const doc of docs) {
        let tier = 0, sum = 0, exact = 0, matches = true
        for (const term of terms) {
          let field = -1
          if (term.prefix === 'da') {
            if (doc.date && term.date && datePartsMatch(term.date, { year: doc.date.getFullYear(), month: doc.date.getMonth() + 1, day: doc.date.getDate() })) field = 3
          } else if (term.prefix === 'fi') {
            if (doc.file.includes(term.value)) field = 1
          } else if (term.prefix === 'fo') {
            if (doc.folder.includes(term.value)) field = doc.node.kind === 'folder' && foldText(doc.node.name).includes(term.value) ? 0 : 2
          } else if (term.prefix === 'met') {
            if (doc.details.includes(term.value)) field = 3
          } else {
            field = [doc.title, doc.file, doc.folder, doc.details].findIndex((s) => s.includes(term.value))
          }
          if (field < 0) { matches = false; break }
          tier = Math.max(tier, field)
          sum += field
          if (doc.stem === term.value || doc.title === term.value || doc.file === term.value) exact += 1
        }
        if (matches) hits.push({ node: doc.node, tier, sum, exact })
      }
      hits.sort((a, b) => a.tier - b.tier || a.sum - b.sum || b.exact - a.exact || a.node.path.split('/').length - b.node.path.split('/').length || a.node.path.localeCompare(b.node.path))
      return hits.map((hit) => hit.node)
    },
  }
}

/** Search has its own temporary collapse state. Clearing search restores the saved tree untouched. */
export function searchResultRows(hits: TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  if (!collapsed.size) return hits
  return hits.filter((node) => {
    let parent = node.path
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'))
      if (collapsed.has(parent)) return false
    }
    return true
  })
}
