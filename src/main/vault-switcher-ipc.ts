/**
 * The vault switcher's channels (vaults ticket 06).
 *
 * - `workspace:switcher-list`: the menu's `Vaults` and `Folders`, from the start screen's pins and
 *   recents and a read-only look at each root (vault-presence.ts). Takes no argument.
 * - `workspace:switch`: replace the sender window by one on another root at the same place (review
 *   2026-10-16; window-switch.ts). The renderer names a root only from the list it was given, and main
 *   checks it again (a persisted recent or pin: the same rule as `workspace:open-recent`), or asks for
 *   the open dialog, which main shows itself. The sender's documents are written by its ordinary close,
 *   which main asks for; the renderer does nothing first.
 */
import type { RootPresence, RootSwitchResult, SwitcherList } from '../shared/vault-switcher'
import { switcherList } from '../shared/vault-switcher'
import type { WindowSwitchOutcome } from './window-switch'

type IpcEvent = { sender: { id: number } }
export type SwitcherIpcRegistrar = { handle: (channel: string, handler: (event: IpcEvent, input: any) => unknown) => void }

export type SwitcherIpcDependencies<State> = {
  stateForSender: (id: number) => State
  /** The window's bound root (canonical), or null on the start screen. */
  rootOf: (state: State) => string | null
  /** The start screen's lists: pins in order, recents (not pins) most recent first. */
  lists: () => { pinned: string[]; recents: string[] }
  presence: (roots: string[]) => Promise<Map<string, RootPresence>>
  home: string
  /** A persisted recent or pin (or the shown Example collection at its fixed path). */
  isKnownRoot: (root: string) => Promise<boolean>
  /** Show the open dialog for this window. null: cancelled or nothing that can be opened (main said why). */
  pickRoot: (state: State) => Promise<{ root: string; focusFile: string | null } | null>
  /** Replace `state` by a window on `root` (opened at `focusFile` when the dialog picked a file). */
  switchWindow: (state: State, root: string, focusFile: string | null) => Promise<WindowSwitchOutcome<State>>
}

export function registerSwitcherIpcHandlers<State>(ipc: SwitcherIpcRegistrar, deps: SwitcherIpcDependencies<State>): void {
  ipc.handle('workspace:switcher-list', async (event): Promise<SwitcherList> => {
    const state = deps.stateForSender(event.sender.id)
    const current = deps.rootOf(state)
    const { pinned, recents } = deps.lists()
    const roots = [...new Set([...pinned, ...recents, ...(current ? [current] : [])])]
    const found = await deps.presence(roots)
    return switcherList({ pinned, recents, current, home: deps.home, presence: (root) => found.get(root) ?? { kind: 'missing' } })
  })

  ipc.handle('workspace:switch', async (event, input: unknown): Promise<RootSwitchResult> => {
    const state = deps.stateForSender(event.sender.id)
    const request = input && typeof input === 'object' ? (input as { root?: unknown; dialog?: unknown }) : {}
    let root: string
    let focusFile: string | null = null
    if (request.dialog === true) {
      const picked = await deps.pickRoot(state)
      if (!picked) return { status: 'cancelled' }
      root = picked.root
      focusFile = picked.focusFile
    } else if (typeof request.root === 'string' && request.root !== '') {
      // As open-recent: a bare renderer-supplied root becomes this window's root only if it is one the
      // person has already opened or pinned, so a compromised renderer cannot name an arbitrary folder.
      if (!(await deps.isKnownRoot(request.root))) throw new Error('Refusing to open a folder that is not in Recents or Pinned.')
      root = request.root
    } else {
      throw new Error('Name a folder to switch to.')
    }
    const outcome = await deps.switchWindow(state, root, focusFile)
    // The window itself never crosses the channel.
    if (outcome.status === 'switched') return { status: 'switched', root: outcome.root }
    return outcome
  })
}
