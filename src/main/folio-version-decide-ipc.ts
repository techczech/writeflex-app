/**
 * The doors for the decide step of Import (Folio versions ticket 16). Electron-free: the stores and the window's binding are the app's,
 * passed in, so a test drives the same handlers without a window.
 *
 * `folio-versions:decide-list` reads and writes nothing. `folio-versions:decide` makes one structure decision and runs only on the writer's
 * own click in the decide step; there is no request, command or verb that reaches it (ADR-0052 § Agent verbs: accepting and deciding have no
 * verb). The Folio folder, the revision, the row, the choice and the running order the writer saw are checked in main
 * (folio-version-decide.ts checks them again where they are used).
 */
import { collectionDir } from './plan-ipc'
import { checkedDecideRequest, decideStructure, readDecideList, type DecideDeps } from './folio-version-decide'
import { checkedTextRequest, decideText, readThreeText } from './folio-version-text'
import type { Workspace } from './workspace'
import type { DecideAnswer, DecideList } from '../shared/folio-version-decide'
import type { TextAnswer, ThreeTextRead } from '../shared/folio-version-text'

type DecideIpcEvent = { sender: { id: number } }
export type FolioVersionDecideIpcRegistrar = { handle: (channel: string, handler: (event: DecideIpcEvent, input: any) => unknown) => void }

export type FolioVersionDecideIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  /** The stores the decision runs over for this window's Collection, bound to this window at the start of the request. */
  deps: (event: DecideIpcEvent, workspace: Workspace) => Promise<DecideDeps>
  /** Told a decision was recorded or the running order changed, so every list reads again. */
  changed: (event: DecideIpcEvent) => void
}

const bad = (): DecideAnswer => ({ status: 'refused', code: 'bad-request', message: 'That request was not understood, so nothing was changed.', nothingWritten: true })

export function registerFolioVersionDecideIpc<State>(ipc: FolioVersionDecideIpcRegistrar, dependencies: FolioVersionDecideIpcDependencies<State>): void {
  const workspaceOf = (event: DecideIpcEvent): Workspace => dependencies.requireWorkspace(dependencies.stateForSender(event.sender.id))
  const folderOf = (workspace: Workspace, input: unknown): string | null => {
    const dir = (input as { dir?: unknown } | null)?.dir
    if (typeof dir !== 'string' || dir.includes('\\') || dir.includes('\u0000')) return null
    try { return collectionDir(workspace, { dir }) } catch { return null }
  }

  ipc.handle('folio-versions:decide-list', async (event, input: unknown): Promise<DecideList | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const revision = (input as { revision?: unknown } | null)?.revision
    if (dir === null || typeof revision !== 'string') return null
    try { return await readDecideList(await dependencies.deps(event, workspace), dir, revision) } catch { return null }
  })

  ipc.handle('folio-versions:decide', async (event, input: unknown): Promise<DecideAnswer> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    if (dir === null) return bad()
    const checked = checkedDecideRequest(input)
    if ('status' in checked) return checked
    try {
      // The window's binding is captured here, before anything is read: every write the decision makes asks whether it still holds.
      const answer = await decideStructure(await dependencies.deps(event, workspace), dir, input)
      if (answer.status === 'done' || !answer.nothingWritten) dependencies.changed(event)
      return answer
    } catch {
      dependencies.changed(event)
      return { status: 'refused', code: 'not-recorded', message: 'Something went wrong, and WriteFlex cannot say what was written. Check the running order.', nothingWritten: false }
    }
  })

  // Ticket 17: the three texts of a part both of you changed. Reading writes nothing; deciding runs only on the writer's own click in that view.
  ipc.handle('folio-versions:text-read', async (event, input: unknown): Promise<ThreeTextRead | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const { revision, part } = (input ?? {}) as { revision?: unknown; part?: unknown }
    if (dir === null || typeof revision !== 'string' || typeof part !== 'string') return null
    try { return await readThreeText(await dependencies.deps(event, workspace), dir, revision, part) } catch { return { unavailable: 'The three texts could not be read. Nothing was changed.' } }
  })

  ipc.handle('folio-versions:text-decide', async (event, input: unknown): Promise<TextAnswer> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const refusedBad: TextAnswer = { status: 'refused', code: 'bad-request', message: 'That request was not understood, so nothing was changed.', nothingWritten: true }
    if (dir === null) return refusedBad
    const checked = checkedTextRequest(input)
    if ('status' in checked) return checked
    try {
      // The window's binding is captured here, before anything is read: every write asks whether it still holds.
      const answer = await decideText(await dependencies.deps(event, workspace), dir, input)
      if (answer.status !== 'refused' || !answer.nothingWritten) dependencies.changed(event)
      return answer
    } catch {
      dependencies.changed(event)
      return { status: 'refused', code: 'not-recorded', message: 'Something went wrong, and WriteFlex cannot say what was written. Check the part’s margin.', nothingWritten: false }
    }
  })
}
