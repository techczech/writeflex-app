/**
 * The found counts behind the Make-this-folder-a-vault sheet (vaults ticket 03). Pure: a detection result
 * and the folder's listing in, the `VaultPreview` out.
 */
import { HIDE_GROUPS, PREVIEW_HIDDEN, type VaultPreview } from '../shared/vault-preview'
import type { VaultIndex } from '../shared/vault-index'
import { boundedHiddenList, DEFAULT_SUPPORT_FOLDERS, HIDE_RULE_LIMITS, hideEntryMatches, type VaultWorkSettings } from './vault-works'

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const INDEX_NOTE = /^_.+_INDEX\.md$/i

/**
 * The detection settings a `vault:preview` request stands for. The renderer's input is untrusted: only the
 * `hidden` and `supportFolders` keys are read (nothing in it names a root; main previews the window's own),
 * non-strings are dropped, and both lists are held to HIDE_RULE_LIMITS (`hidden` also to its wildcard and
 * budget bounds). A missing list reads as the sheet's opening one.
 */
export function previewSettingsFrom(input: unknown): VaultWorkSettings {
  const fields = input && typeof input === 'object' ? (input as { hidden?: unknown; supportFolders?: unknown }) : {}
  const hidden = Array.isArray(fields.hidden) ? boundedHiddenList(fields.hidden) : [...PREVIEW_HIDDEN]
  const supportFolders = Array.isArray(fields.supportFolders)
    ? fields.supportFolders.slice(0, HIDE_RULE_LIMITS.entries)
      .filter((name): name is string => typeof name === 'string' && name.length <= HIDE_RULE_LIMITS.length)
    : [...DEFAULT_SUPPORT_FOLDERS]
  return { hidden, supportFolders }
}

export function buildVaultPreview(input: {
  rootName: string
  index: VaultIndex
  files: string[]
  folders: string[]
  supportFolders: readonly string[]
}): VaultPreview {
  const { index, files, folders } = input
  const hideCounts: Record<string, number> = Object.fromEntries(HIDE_GROUPS.map((group) => [group.id, 0]))
  const folderSet = new Set(folders)
  for (const path of index.hidden.paths) {
    const isFolder = folderSet.has(path)
    // The group whose entries hid it; reserved rules (conflict copies, empty folders) take what is left.
    const group = HIDE_GROUPS.find((candidate) => candidate.kind === (isFolder ? 'folder' : 'file')
      && candidate.patterns.some((entry) => hideEntryMatches(entry, path, isFolder)))
    if (group) hideCounts[group.id] += 1
    else if (isFolder) hideCounts.empty += 1
    else hideCounts.conflicts += 1
  }
  hideCounts['index-notes'] = files.filter((path) => INDEX_NOTE.test(nameOf(path))).length

  const supportCounts: Record<string, number> = {}
  for (const name of input.supportFolders) {
    const wanted = name.toLocaleLowerCase()
    supportCounts[name] = files.filter((path) => path.split('/').slice(0, -1).some((segment) => segment.toLocaleLowerCase() === wanted)).length
  }

  const byStatus = new Map<string, number>()
  let noStatusWorks = 0
  for (const work of index.works) {
    if (work.status === null) noStatusWorks += 1
    else byStatus.set(work.status, (byStatus.get(work.status) ?? 0) + 1)
  }
  const statuses = [...byStatus].map(([raw, works]) => ({ raw, works })).sort((a, b) => b.works - a.works || a.raw.localeCompare(b.raw))
  return {
    folderName: input.rootName,
    works: index.works.length,
    withStatus: index.works.length - noStatusWorks,
    files: files.length,
    hideCounts,
    supportCounts,
    statuses,
    noStatusWorks,
  }
}
