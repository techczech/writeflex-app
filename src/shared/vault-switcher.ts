/**
 * The vault switcher's list (vaults ticket 06, locked frame `locked-vault-sidebar-vault-switcher-menu`):
 * the known roots of the start screen (pins, then recents) sorted into `Vaults` (roots that hold
 * `.writeflex/vault.json`) and `Folders` (plain roots), with the window's own root ticked.
 *
 * Pure: main reads the settings and asks each root whether it is a vault (`vault-presence.ts`), then
 * hands the answers here. No filesystem, no Electron.
 */

/** What a known root is, as main found it just now. `missing`: the folder is not there (not listed). */
export type RootPresence =
  | { kind: 'vault'; name: string; works: number | null }
  | { kind: 'folder' }
  | { kind: 'missing' }

export type SwitcherVaultRow = { root: string; name: string; works: number | null; current: boolean }
export type SwitcherFolderRow = { root: string; name: string; parent: string; current: boolean }

export type SwitcherList = {
  vaults: SwitcherVaultRow[]
  folders: SwitcherFolderRow[]
  /** The window's own root is a vault (the Make item is greyed with "already a vault"). */
  currentIsVault: boolean
}

export type SwitcherListInput = {
  /** The person's pins, in their order (start-screen order). */
  pinned: readonly string[]
  /** Recent roots, most recent first. */
  recents: readonly string[]
  /** The window's root (canonical), or null on the start screen. Always listed, ticked. */
  current: string | null
  presence: (root: string) => RootPresence
  /** The home folder, so a parent path reads `~/Documents/WriteFlex`. */
  home: string
}

/** A root's folder name: its last path segment. */
export function rootName(root: string): string {
  const trimmed = root.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** The parent folder of a root, with the home folder written `~`. */
export function parentPath(root: string, home: string): string {
  const trimmed = root.replace(/\/+$/, '')
  const parent = trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'
  const base = home.replace(/\/+$/, '')
  if (base && (parent === base || parent.startsWith(`${base}/`))) return `~${parent.slice(base.length)}`
  return parent
}

/** The switcher's two sections. Each root once, pins first, then recents; folders that are gone are left out. */
export function switcherList(input: SwitcherListInput): SwitcherList {
  const seen = new Set<string>()
  const order: string[] = []
  for (const root of [...input.pinned, ...input.recents, ...(input.current ? [input.current] : [])]) {
    if (seen.has(root)) continue
    seen.add(root)
    order.push(root)
  }
  const vaults: SwitcherVaultRow[] = []
  const folders: SwitcherFolderRow[] = []
  let currentIsVault = false
  for (const root of order) {
    const current = root === input.current
    const found = input.presence(root)
    if (found.kind === 'vault') {
      vaults.push({ root, name: found.name, works: found.works, current })
      if (current) currentIsVault = true
    } else if (found.kind === 'folder' || current) {
      folders.push({ root, name: rootName(root), parent: parentPath(root, input.home), current })
    }
  }
  return { vaults, folders, currentIsVault }
}

/** The small text on a vault row: `14 works`, `1,882 works`, or `—` when no count is cached. */
export function worksText(works: number | null): string {
  if (works === null) return '—'
  return `${works.toLocaleString('en-GB')} ${works === 1 ? 'work' : 'works'}`
}

/** What the renderer asks main to switch to: a listed root, or the open dialog. */
export type RootSwitchTarget = { root: string } | { dialog: true }

/** How a switch ended (review 2026-10-16: the switch replaces the window). Only `switched` changed anything. */
export type RootSwitchResult =
  /** A window on `root` has taken this window's place, and this window has closed (its page rarely sees this). */
  | { status: 'switched'; root: string }
  /** The chosen root is this window's own: nothing to do. */
  | { status: 'unchanged' }
  /** Another window shows the chosen root: that window was brought forward, this one left as it was. */
  | { status: 'focused'; root: string }
  /** Another program holds the folder and the person chose not to wait (main told them). */
  | { status: 'busy' }
  /** The open dialog was cancelled, or the picked item cannot be opened (main said why). */
  | { status: 'cancelled' }
  /** A switch is already under way from this window or into that folder: nothing was done. */
  | { status: 'switching' }
  /** This window's close was refused (a document could not be written) or (`close-timed-out`) had not
   *  finished after the switch's bound and was called off: it stays. */
  | { status: 'stayed'; reason?: 'close-timed-out' }

/** Why this window's close was kept open, as its close handler found it: the documents it could not
 *  write (each with its write's reason, when one was given), or typing that outran the writes. */
export type CloseKept = { kind: 'refused'; failed: ReadonlyArray<{ path: string; reason?: string }> } | { kind: 'still-typing' }

/** The status-bar line when the window's close was still saving after the switch's bound and was called off. */
export const SWITCH_CLOSE_TIMED_OUT_MESSAGE = 'Still saving after a minute — staying in this folder'

/** The status-bar line when a switch stays in this folder because the window could not close. */
export function switchStayedMessage(kept: CloseKept | null): string {
  if (kept?.kind === 'still-typing') return 'Still saving what you typed — staying in this folder'
  const failed = kept?.failed ?? []
  const reasons = failed.flatMap((entry) => (entry.reason ? [entry.reason] : []))
  if (failed.length === 1 && reasons.length === 0) return `Could not save ${rootName(failed[0]!.path)} — staying in this folder`
  if (failed.length > 0 && reasons.length === failed.length) return `${reasons.join(' ')} Staying in this folder.`
  if (failed.length > 1 && reasons.length === 0) return `Could not save ${failed.length} documents — staying in this folder`
  if (failed.length > 0) return `${reasons.join(' ')} Could not save ${failed.length - reasons.length} more — staying in this folder`
  return 'Could not save your documents — staying in this folder'
}
