import type { MarkdownFile } from '../../preload'
import { isPathInSearchScope } from '../../shared/search-scope'
import type { VaultIndex, VaultWorkKind } from '../../shared/vault-index'
import { fuzzyScore } from './fuzzy'

/** `label` and `work` are set only by the vault Titles pass (`vaultSidebarTree`): the work's title, and its kind. */
export type TreeFile = { kind: 'file'; path: string; name: string; isIndex: boolean; isScrap: boolean; label?: string; work?: VaultWorkKind }
export type TreeFolder = { kind: 'folder'; path: string; name: string; children: TreeNode[]; label?: string; work?: VaultWorkKind }
export type TreeNode = TreeFile | TreeFolder

/** An Index Note: `_<workspace-or-folder>_INDEX.md` — the mockup's BookOpenText rows. */
export function isIndexNote(name: string): boolean {
  return /^_.+_INDEX\.md$/.test(name)
}

/** Order within a level: Index Notes first, then folders, then ordinary files — matching the mockup. */
function rankOf(node: TreeNode): number {
  if (node.kind === 'folder') return 1
  return node.isIndex ? 0 : 2
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name))
  for (const node of nodes) if (node.kind === 'folder') sortNodes(node.children)
}

/** Derive the folder hierarchy from the flat `files[].path`/`.directory` list (relative POSIX paths). */
export function buildTree(files: MarkdownFile[], folders: string[] = []): TreeNode[] {
  const root: TreeFolder = { kind: 'folder', path: '', name: '', children: [] }
  const byDir = new Map<string, TreeFolder>([['', root]])
  const ensureFolder = (dir: string): TreeFolder => {
    const existing = byDir.get(dir)
    if (existing) return existing
    const slash = dir.lastIndexOf('/')
    const parent = ensureFolder(slash === -1 ? '' : dir.slice(0, slash))
    const node: TreeFolder = { kind: 'folder', path: dir, name: slash === -1 ? dir : dir.slice(slash + 1), children: [] }
    byDir.set(dir, node)
    parent.children.push(node)
    return node
  }
  for (const dir of folders) ensureFolder(dir) // empty folders are real rows (ADR-0017)
  for (const file of files) {
    ensureFolder(file.directory).children.push({
      kind: 'file',
      path: file.path,
      name: file.name,
      isIndex: isIndexNote(file.name),
      isScrap: /-SCRAPS\.md$/i.test(file.name),
    })
  }
  sortNodes(root.children)
  return root.children
}

/** Name filter for the Files sidebar: folder matches keep their children; other hits keep ancestors. */
export function filterTreeByName(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim()
  if (!needle) return nodes

  const filtered: TreeNode[] = []
  for (const node of nodes) {
    if (!isPathInSearchScope(node.path)) continue
    const matches = fuzzyScore(needle, node.name) !== null || (node.label !== undefined && fuzzyScore(needle, node.label) !== null)
    if (node.kind === 'file') {
      if (matches) filtered.push(node)
      continue
    }

    if (matches) {
      filtered.push(node)
      continue
    }
    const children = filterTreeByName(node.children, needle)
    if (children.length > 0) filtered.push({ ...node, children })
  }
  return filtered
}

/**
 * The tree narrowed to a focused folder (ticket 03): the folder itself as the one top row, holding
 * its whole subtree. No focus returns the tree unchanged; a focus the tree does not hold (the folder
 * went away) narrows to nothing rather than silently showing the whole archive.
 */
export function focusTree(nodes: TreeNode[], focus: string | null): TreeNode[] {
  if (!focus) return nodes
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    if (node.path === focus) return [node]
    if (focus.startsWith(`${node.path}/`)) return focusTree(node.children, focus)
  }
  return []
}

/** Whether a workspace-relative path lies inside the focused folder (the folder itself included). */
export function isInFocus(path: string, focus: string | null): boolean {
  return !focus || path === focus || path.startsWith(`${focus}/`)
}

/**
 * Where ⌘N / ⌃⌘N (and the Files footer's New file / New folder) plant the ghost row. The Files tree's
 * keyboard-focused row wins (a folder is itself the target, a file gives its folder), else the open
 * file's folder, else the workspace root. While a folder is focused the target never leaves it: a
 * candidate outside the focus (a root-level file, a file from elsewhere, a stale row) becomes the
 * focused folder itself, so the new item always lands where the narrowed tree can show it.
 */
export function createTargetDirectory(input: {
  focusedRow: { key: string; kind: 'file' | 'folder' } | null
  activePath: string | null
  focus: string | null
}): string {
  const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
  const { focusedRow, activePath, focus } = input
  const candidate = focusedRow
    ? focusedRow.kind === 'folder' ? focusedRow.key : parentOf(focusedRow.key)
    : activePath && !activePath.includes('://') ? parentOf(activePath) : ''
  if (!focus) return candidate
  return candidate !== '' && isInFocus(candidate, focus) ? candidate : focus
}

/** The path bar's segments for a focus: each ancestor from the top level down, the focus last. */
export function focusSegments(focus: string): Array<{ path: string; name: string }> {
  const parts = focus.split('/').filter(Boolean)
  return parts.map((name, index) => ({ path: parts.slice(0, index + 1).join('/'), name }))
}

/** Next/previous Markdown file beside the active file in the Files sidebar's sorted folder level. */
export function folderBrowsePath(files: MarkdownFile[], activePath: string, direction: 1 | -1): string | null {
  const active = files.find((file) => file.path === activePath)
  if (!active) return null
  const tree = buildTree(files)
  const childrenFor = (nodes: TreeNode[], directory: string): TreeNode[] | null => {
    if (directory === '') return nodes
    for (const node of nodes) {
      if (node.kind !== 'folder') continue
      if (node.path === directory) return node.children
      const nested = childrenFor(node.children, directory)
      if (nested) return nested
    }
    return null
  }
  const siblings = (childrenFor(tree, active.directory) ?? [])
    .filter((node): node is TreeFile => node.kind === 'file')
    .map((node) => node.path)
  const index = siblings.indexOf(activePath)
  if (index === -1 || siblings.length === 0) return null
  return siblings[(index + direction + siblings.length) % siblings.length]
}

/** What the vault sidebar shows of the tree: the Writing only hide pass and the Titles relabel pass. */
export type VaultSidebarView = {
  writingOnly: boolean
  titles: boolean
  index: Pick<VaultIndex, 'works' | 'hidden' | 'labels' | 'workFolders'> | null
}

/** Writing only: drop the vault's hidden set (top-most hidden paths; a hidden folder takes its children). */
export function hideWritingOnlyHidden(nodes: TreeNode[], hiddenPaths: readonly string[]): TreeNode[] {
  if (hiddenPaths.length === 0) return nodes
  const hidden = new Set(hiddenPaths)
  const walk = (level: TreeNode[]): TreeNode[] => level
    .filter((node) => !hidden.has(node.path))
    .map((node) => (node.kind === 'folder' ? { ...node, children: walk(node.children) } : node))
  return walk(nodes)
}

const labelOf = (node: TreeNode): string => node.label ?? node.name

/**
 * Titles: each work is one row carrying its title. A Folio or folder-piece work folder becomes a leaf
 * (no children, so no expanding); a single-file work keeps its row; folders that are not works keep their
 * names and recurse. Sorted by displayed label, case-insensitive: Index Notes first (as today), then folders
 * that are not works, then works and other files.
 */
/** The icon a Titles-view work row wears: a Folio its Folio mark, any other folder work a folder, a single-file work a file. */
export function workRowIcon(isFolder: boolean, work: VaultWorkKind | undefined): 'folio' | 'folder' | 'file' {
  if (work === 'folio') return 'folio'
  return isFolder ? 'folder' : 'file'
}

export function relabelAsTitles(nodes: TreeNode[], index: Pick<VaultIndex, 'works' | 'labels' | 'workFolders'>): TreeNode[] {
  const kinds = new Map(index.works.map((work) => [work.path, work.kind]))
  const workFolders = new Set(index.workFolders)
  const rank = (node: TreeNode): number => (node.kind === 'file' ? (node.isIndex ? 0 : 2) : node.work ? 2 : 1)
  const walk = (level: TreeNode[]): TreeNode[] => level
    .map((node): TreeNode => {
      if (node.kind === 'folder') {
        if (workFolders.has(node.path)) {
          return { ...node, children: [], label: index.labels[node.path] ?? node.name, work: kinds.get(node.path) ?? 'folder-piece' }
        }
        return { ...node, children: walk(node.children) }
      }
      const title = index.labels[node.path]
      return title === undefined ? node : { ...node, label: title, work: kinds.get(node.path) ?? 'file' }
    })
    .sort((a, b) => rank(a) - rank(b) || labelOf(a).toLowerCase().localeCompare(labelOf(b).toLowerCase()))
  return walk(nodes)
}

/**
 * The tree for a vault window: Writing only hides, Titles relabels. With Writing only off and File names on,
 * (or no index yet) the very same tree comes back, so All files is today's tree.
 */
export function vaultSidebarTree(nodes: TreeNode[], view: VaultSidebarView): TreeNode[] {
  if (!view.index) return nodes
  let out = nodes
  if (view.writingOnly) out = hideWritingOnlyHidden(out, view.index.hidden.paths)
  if (view.titles) out = relabelAsTitles(out, view.index)
  return out
}
