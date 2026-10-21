/**
 * The Make-this-folder-a-vault sheet (vaults ticket 03): what main reports about a plain folder
 * (`VaultPreview`), the hide groups the sheet offers, and the sheet's draft model. Pure and node-free:
 * proposals in, `vault.json` content (a `VaultCreateInput`) out. Main builds the preview
 * (src/main/vault-preview.ts); the renderer holds the draft.
 */
import {
  CONFLICT_COPIES_RULE, DEFAULT_SUPPORT_FOLDERS, DEFAULT_VAULT_HIDDEN, EMPTY_FOLDERS_RULE, INDEX_NOTE_RULE, VAULT_STEPS,
  type VaultCreateInput, type VaultStep,
} from './vault'

/** One distinct raw `status` value found on works. */
export type VaultPreviewStatus = { raw: string; works: number }

export type VaultPreview = {
  /** The root folder's name. */
  folderName: string
  works: number
  withStatus: number
  /** Markdown files in the folder (what WriteFlex lists). */
  files: number
  /** Found count per hide group id (top-most hidden entries; the index notes group counts the notes). */
  hideCounts: Record<string, number>
  /** Files under each named support folder (any level, any case). */
  supportCounts: Record<string, number>
  /** Distinct raw statuses, most works first, then A to Z. */
  statuses: VaultPreviewStatus[]
  /** Works with no status. */
  noStatusWorks: number
}

export type HideGroup = {
  id: string
  /** Shown in the sheet, as drawn. */
  label: string
  description: string
  /** The `hidden` entries this group stands for. `vault.json.hidden` is the vault's complete rule list:
   *  switching the group off leaves these entries out of the list the sheet creates. */
  patterns: string[]
  kind: 'folder' | 'file'
}

/**
 * The sheet's hide groups. Every entry of the built-in list (DEFAULT_VAULT_HIDDEN) belongs to exactly one
 * group; the index-notes group's `_*_INDEX.md` is the one entry beyond the built-in list (covers are not
 * hidden in a vault without a `hidden` key).
 */
export const HIDE_GROUPS: readonly HideGroup[] = [
  { id: 'template', label: '_TEMPLATE/', description: 'Templates for new works', patterns: ['_TEMPLATE/'], kind: 'folder' },
  { id: 'readme', label: 'README.md', description: 'Project notes (their status is still read)', patterns: ['README.md'], kind: 'file' },
  { id: 'agents', label: 'AGENTS.md, CLAUDE.md', description: 'Instructions for agents', patterns: ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md'], kind: 'file' },
  { id: 'records', label: '_TASK-LOG/, _ADR/', description: 'Agent task and decision records', patterns: ['_TASK-LOG/', '_ADR/', '_AGENT-INSTRUCTIONS/'], kind: 'folder' },
  { id: 'cache', label: 'cache/, _sources/', description: 'Downloaded and generated material', patterns: ['cache/', '_sources/', 'tools/', '__pycache__/'], kind: 'folder' },
  { id: 'index-notes', label: '_<folder>_INDEX.md', description: 'Index Notes: the cover of a folder', patterns: [INDEX_NOTE_RULE], kind: 'file' },
  { id: 'conflicts', label: 'Conflict copies', description: 'Sync copies such as "essay (1).md"', patterns: [CONFLICT_COPIES_RULE], kind: 'file' },
  { id: 'empty', label: 'Empty folders', description: 'Folders with no pieces and no Folio', patterns: [EMPTY_FOLDERS_RULE], kind: 'folder' },
]

/**
 * The complete `hidden` list for the switched-on groups: the built-in list in its order without the
 * entries of switched-off groups, then any switched-on group entry the built-in list lacks.
 */
export function hiddenForGroups(hideOn: readonly string[]): string[] {
  const off = new Set(HIDE_GROUPS.filter((group) => !hideOn.includes(group.id)).flatMap((group) => group.patterns))
  const hidden = DEFAULT_VAULT_HIDDEN.filter((entry) => !off.has(entry))
  for (const group of HIDE_GROUPS) {
    if (!hideOn.includes(group.id)) continue
    for (const pattern of group.patterns) if (!hidden.includes(pattern)) hidden.push(pattern)
  }
  return hidden
}

/** What the sheet's preview detects with: every group on. */
export const PREVIEW_HIDDEN: readonly string[] = hiddenForGroups(HIDE_GROUPS.map((group) => group.id))

/** The step choices of a picker, in ladder order, then no step. */
export const STEP_CHOICES: readonly (VaultStep | '')[] = [...VAULT_STEPS, '']

/** The folder name as a vault name: separators become spaces, first letter capital. */
export function humaniseFolderName(folderName: string): string {
  const spaced = folderName.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (spaced === '') return folderName
  return spaced.charAt(0).toLocaleUpperCase() + spaced.slice(1)
}

export type VaultDraft = {
  name: string
  /** Hide group ids that are switched on. */
  hideOn: string[]
  supportFolders: string[]
  /** Raw status -> chosen step; '' (or missing) is No step. */
  steps: Record<string, VaultStep | ''>
}

/** The sheet's opening state: humanised name, every group on, default support folders, every picker at No step. */
export function initialDraft(preview: Pick<VaultPreview, 'folderName' | 'statuses'>): VaultDraft {
  return {
    name: humaniseFolderName(preview.folderName),
    hideOn: HIDE_GROUPS.map((group) => group.id),
    supportFolders: [...DEFAULT_SUPPORT_FOLDERS],
    steps: Object.fromEntries(preview.statuses.map((status) => [status.raw, ''])),
  }
}

/**
 * The draft's step choices after a fresh preview (a hide switch changed what counts as a work): a raw value
 * that is still found keeps its step, one that is gone is dropped, a newly found one starts at No step.
 */
export function reconcileSteps(
  steps: Readonly<Record<string, VaultStep | ''>>,
  statuses: readonly Pick<VaultPreviewStatus, 'raw'>[],
): Record<string, VaultStep | ''> {
  return Object.fromEntries(statuses.map((status) => [status.raw, Object.hasOwn(steps, status.raw) ? steps[status.raw] : '']))
}

/**
 * The preview the sheet shows after a hide switch: everything from the fresh read, except that a switched-off
 * group keeps the count it had (its row tells what switching it back on would hide; the fresh read hides
 * nothing by it).
 */
export function refreshedPreview(previous: VaultPreview, next: VaultPreview, hideOn: readonly string[]): VaultPreview {
  const hideCounts = { ...next.hideCounts }
  for (const group of HIDE_GROUPS) if (!hideOn.includes(group.id) && group.id in previous.hideCounts) hideCounts[group.id] = previous.hideCounts[group.id]
  return { ...next, hideCounts }
}

/** A support folder name as typed: trimmed, no slashes at the ends; null when there is nothing usable or it is already listed. */
export function normaliseSupportName(input: string, existing: readonly string[]): string | null {
  const name = input.trim().replace(/^\/+|\/+$/g, '')
  if (name === '' || name.includes('/')) return null
  if (existing.some((other) => other.toLocaleLowerCase() === name.toLocaleLowerCase())) return null
  return name
}

/**
 * Whether Make vault may run: not while a create call is in flight, not while the preview behind the draft is
 * being re-read (the sheet would write steps it never showed), not after a failed re-read, and only with a name.
 */
export function canMakeVault(state: { busy: boolean; previewPending: boolean; previewFailed: boolean; name: string }): boolean {
  return !state.busy && !state.previewPending && !state.previewFailed && state.name.trim() !== ''
}

/** The `vault.json` content the draft stands for: the complete hide list without switched-off groups' entries; No step is left out of the map. */
export function draftToCreateInput(draft: VaultDraft): VaultCreateInput {
  const hidden = hiddenForGroups(draft.hideOn)
  const statusMap: Record<string, VaultStep> = {}
  for (const [raw, step] of Object.entries(draft.steps)) if (step !== '') statusMap[raw] = step
  return { name: draft.name.trim() || undefined, hidden, supportFolders: [...draft.supportFolders], statusMap }
}
