import { collectionDir } from './plan-ipc'
import { readCursorFacts, readFolioCues, type CueSources } from './folio-version-cues'
import { readBytes } from './cli/guarded-fs'
import { FolioVersionStore } from './folio-versions'
import { readVersionContents, readVersionsListing, type VersionsTabSources } from './folio-versions-tab'
import { readMovedVersions } from './version-moves'
import { snapshotHashesOf, versionTextReader } from './cli/history-store'
import { defaultCompareSources, defaultReaderSources } from './folio-version-sources'
import { compareFolioPart, compareFolioVersions, FolioCompareRefused, type FolioCompareSources } from './folio-version-compare'
import { isFolioVersionId } from '../shared/folio-version-records'
import { COMPARE_WORKING } from '../shared/folio-version-compare'
import { readMemberAtVersion, readVersionForReading, type VersionReaderSources } from './folio-version-reader'
import { takeInputOf, takePartFromVersion, undoTake } from './folio-version-take'
import { readRevisionStatuses } from './folio-version-stage'
import { indexNotePath } from './folio'
import type { RevisionStatus } from '../shared/folio-version-stage'
import { sendVersionText } from './folio-version-scratchpad'
import type { ScratchpadStore } from './scratchpad-store'
import { VERSION_SEND_UNAVAILABLE, VERSION_TEXT_SIDES, type VersionSendReply, type VersionTextSide } from '../shared/folio-version-scratchpad'
import type { ChangeStore } from './changes'
import type { FolioTakeResult, FolioUndoTakeResult } from '../shared/folio-version-take'
import type { Workspace } from './workspace'
import type { FolioVersionContents, FolioVersionReading, FolioVersionsListing } from '../shared/folio-versions-view'
import type { FolioComparePart, FolioCompareResult } from '../shared/folio-version-compare'
import type { FolioCues, FolioCursorFacts } from '../shared/folio-version-changes'

/**
 * The Versions tab's IPC seam (Folio versions ticket 05). Two read-only channels, each naming a Folio by its folder:
 * `folio-versions:list` (the timeline and the backup's left-out list) and `folio-versions:contents` (one version's parts,
 * files not in the outline and inserted files). Neither writes: opening the tab on a Collection with no Folio journal
 * leaves none behind. Ticket 07 adds `folio-versions:read` (a version opened for reading) and `folio-versions:member-text`
 * (one member's exact saved text), both read only and both through the shared reader (`folio-version-reader.ts`). The Save,
 * Compare, Restore and Export doors belong to other tickets.
 */
type VersionsIpcEvent = { sender: { id: number } }
export type FolioVersionsIpcRegistrar = { handle: (channel: string, handler: (event: VersionsIpcEvent, input: any) => unknown) => void }

export type FolioVersionsIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  /** Test seam: the stores the reads use. Default: this Collection's own. */
  sources?: (workspace: Workspace) => VersionsTabSources
  /** Test seam: the stores the change cues use. Default: this Collection's own. */
  cueSources?: (workspace: Workspace) => CueSources
  /** Test seam: the reader's sources (ticket 07). Default: this Collection's own. */
  readerSources?: (workspace: Workspace) => VersionReaderSources
  /** Test seam: Compare's sources (ticket 08). Default: this Collection's own. */
  compareSources?: (workspace: Workspace) => FolioCompareSources
  /** Ticket 09: the Collection's change ledger a take files its proposal in. Absent: a take is refused with a sentence. */
  requireChanges?: (state: State) => ChangeStore
  /** Ticket 09: told after a take filed its proposal, so the margin and the review dock list the ledger again. */
  afterTake?: (state: State) => void
  /** Ticket 10: the Scratchpad's own store for this window's Collection, for "send a copy" and "keep mine". Absent: those are refused with a sentence. */
  requireScratchpad?: (state: State) => ScratchpadStore | null
  /** Ticket 10: told after a copy reached the Scratchpad, so every window on the Collection lists it again. */
  afterSend?: (state: State) => void
}

/** The reads over this Collection's own stores. */
export function defaultVersionsSources(workspace: Workspace): VersionsTabSources {
  return {
    workspace,
    folioVersions: new FolioVersionStore(workspace),
    fileVersions: () => readMovedVersions(workspace.root),
    readSnapshot: (snapshotId) => versionTextReader(workspace.root).readSnapshotContent(snapshotId),
  }
}

/** The cues' reads over this Collection's own stores (Folio versions ticket 06). */
export function defaultCueSources(workspace: Workspace): CueSources {
  const tab = defaultVersionsSources(workspace)
  return {
    workspace,
    folioVersions: tab.folioVersions,
    fileVersions: tab.fileVersions,
    readSnapshot: tab.readSnapshot,
    snapshotHashes: (ids) => snapshotHashesOf(workspace.root, ids),
    readBytes: (path) => readBytes(workspace, path),
  }
}

export { defaultReaderSources }

function folderOf(workspace: Workspace, input: unknown): string | null {
  const dir = (input as { dir?: unknown } | null)?.dir
  if (typeof dir !== 'string' || dir.includes('\\') || dir.includes('\u0000')) return null
  try { return collectionDir(workspace, { dir }) } catch { return null }
}

export function registerFolioVersionsIpc<State>(ipc: FolioVersionsIpcRegistrar, dependencies: FolioVersionsIpcDependencies<State>): void {
  const workspaceOf = (event: VersionsIpcEvent): Workspace => dependencies.requireWorkspace(dependencies.stateForSender(event.sender.id))
  const sourcesFor = dependencies.sources ?? defaultVersionsSources
  const cueSourcesFor = dependencies.cueSources ?? defaultCueSources
  const readerFor = dependencies.readerSources ?? defaultReaderSources
  const compareFor = dependencies.compareSources ?? defaultCompareSources

  ipc.handle('folio-versions:list', async (event, input: unknown): Promise<FolioVersionsListing | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    return dir === null ? null : readVersionsListing(sourcesFor(workspace), dir)
  })

  ipc.handle('folio-versions:contents', async (event, input: unknown): Promise<FolioVersionContents | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const id = (input as { id?: unknown } | null)?.id
    return dir === null || typeof id !== 'string' ? null : readVersionContents(sourcesFor(workspace), dir, id)
  })

  // Ticket 15: the incoming revisions of the Folio and how many of their staged suggestions are decided (the Versions tab's banner and timeline row). Read only.
  ipc.handle('folio-versions:revisions', async (event, input: unknown): Promise<RevisionStatus[]> => {
    const state = dependencies.stateForSender(event.sender.id)
    const workspace = dependencies.requireWorkspace(state)
    const dir = folderOf(workspace, input)
    const changes = dependencies.requireChanges?.(state)
    if (dir === null || !changes) return []
    try { return await readRevisionStatuses({ changes, folioVersions: new FolioVersionStore(workspace) }, indexNotePath(workspace, dir)) } catch { return [] }
  })

  // Ticket 06: the change cues (Binder dots, status-bar chip, margin heading) and the panel that follows the cursor. Both read only.
  ipc.handle('folio-versions:cues', async (event, input: unknown): Promise<FolioCues> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    return dir === null ? { state: 'none' } : readFolioCues(cueSourcesFor(workspace), dir)
  })

  ipc.handle('folio-versions:cursor', async (event, input: unknown): Promise<FolioCursorFacts | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const { path, embed } = (input ?? {}) as { path?: unknown; embed?: unknown }
    const own = typeof path === 'string' && !path.includes('\\') && !path.includes('\u0000') ? path : null
    const target = typeof embed === 'string' && embed.length < 2000 ? embed : null
    return dir === null ? null : readCursorFacts(cueSourcesFor(workspace), dir, own, target)
  })

  // Ticket 07: a version opened for reading, and one member's exact saved text. Both read only; the Folio folder, the version id and the
  // member path are checked in main (a path is only ever looked up among that version's own members, never joined to the Collection).
  ipc.handle('folio-versions:read', async (event, input: unknown): Promise<FolioVersionReading | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const id = (input as { id?: unknown } | null)?.id
    return dir === null || typeof id !== 'string' ? null : readVersionForReading(readerFor(workspace), dir, id)
  })

  ipc.handle('folio-versions:member-text', async (event, input: unknown): Promise<{ path: string; text: string } | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const id = (input as { id?: unknown } | null)?.id
    const path = (input as { path?: unknown } | null)?.path
    if (dir === null || typeof id !== 'string' || typeof path !== 'string') return null
    const member = await readMemberAtVersion(readerFor(workspace), dir, id, path)
    return member === null ? null : { path: member.path, text: member.text }
  })

  // Ticket 08: two versions (or a version and the working draft) compared, and one line of that comparison opened. Both read only. The
  // Folio folder and both ids are checked here (an id is a Folio version id or `working`; nothing else is let through); the line is
  // found by its key among the two sides' own files, never joined to a path. A refusal is answered as `{ refused }`, a sentence.
  const endsOf = (input: unknown): { from: string; to: string } | null => {
    const from = (input as { from?: unknown } | null)?.from
    const to = (input as { to?: unknown } | null)?.to
    const ok = (value: unknown): value is string => typeof value === 'string' && (value === COMPARE_WORKING || isFolioVersionId(value))
    return ok(from) && ok(to) ? { from, to } : null
  }
  ipc.handle('folio-versions:compare', async (event, input: unknown): Promise<FolioCompareResult | { refused: string } | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const ends = endsOf(input)
    if (dir === null || ends === null) return null
    try { return await compareFolioVersions(compareFor(workspace), dir, ends.from, ends.to) } catch (error) {
      if (error instanceof FolioCompareRefused) return { refused: error.message }
      throw error
    }
  })

  ipc.handle('folio-versions:compare-part', async (event, input: unknown): Promise<FolioComparePart | null> => {
    const workspace = workspaceOf(event)
    const dir = folderOf(workspace, input)
    const ends = endsOf(input)
    const key = (input as { key?: unknown } | null)?.key
    if (dir === null || ends === null || typeof key !== 'string' || key.length > 1000) return null
    try { return await compareFolioPart(compareFor(workspace), dir, ends.from, ends.to, key) } catch (error) {
      if (error instanceof FolioCompareRefused) return null
      throw error
    }
  })

  // Ticket 09: take one part's text from the version compared with the working draft. It files a proposal in the part's margin and writes
  // no part file; the window checks first that the part has no unsaved typing, and the fingerprint the comparison carried is checked here.
  ipc.handle('folio-versions:take-part', async (event, input: unknown): Promise<FolioTakeResult> => {
    const state = dependencies.stateForSender(event.sender.id)
    const workspace = dependencies.requireWorkspace(state)
    const dir = folderOf(workspace, input)
    const taken = takeInputOf(input)
    if (dir === null || taken === null) return { ok: false, reason: 'not-a-take', message: 'That is not a part that can be taken. Nothing was taken.' }
    const changes = dependencies.requireChanges?.(state)
    if (!changes) return { ok: false, reason: 'unreadable', message: 'The changes for this Collection are not ready yet. Nothing was taken.' }
    try {
      const scratchpad = taken.keepMine ? dependencies.requireScratchpad?.(state) ?? undefined : undefined
      const result = await takePartFromVersion({ workspace, sources: compareFor(workspace), changes, ...(scratchpad ? { scratchpad } : {}) }, { ...taken, dir })
      if (result.ok) { dependencies.afterTake?.(state); if (result.keptItemId) dependencies.afterSend?.(state) }
      else if (result.keptItemId) dependencies.afterSend?.(state) // a copy was left in the Scratchpad: every window lists it
      return result
    } catch (error) {
      if (error instanceof FolioCompareRefused) return { ok: false, reason: 'not-a-take', message: error.message }
      throw error
    }
  })

  // Undo of a staged take (ticket 10 review). One main-side operation under the Collection's write turn: the take is declined only if it is
  // still undecided (an Accept elsewhere wins and Undo says so), and the Scratchpad card "keep mine" made is withdrawn only after that.
  ipc.handle('folio-versions:undo-take', async (event, input: unknown): Promise<FolioUndoTakeResult> => {
    const state = dependencies.stateForSender(event.sender.id)
    const workspace = dependencies.requireWorkspace(state)
    const dir = folderOf(workspace, input)
    const { changeId, keptItemId } = (input ?? {}) as Record<string, unknown>
    const changes = dependencies.requireChanges?.(state)
    if (dir === null || typeof changeId !== 'string' || changeId === '' || changeId.length > 200 || (keptItemId !== undefined && (typeof keptItemId !== 'string' || keptItemId.length > 200))) {
      return { ok: false, reason: 'not-a-take', message: 'That is not a take that can be taken back. Nothing was changed.' }
    }
    if (!changes) return { ok: false, reason: 'failed', message: 'The changes for this Collection are not ready yet. Nothing was changed.' }
    try {
      const scratchpad = keptItemId !== undefined ? dependencies.requireScratchpad?.(state) ?? undefined : undefined
      const result = await undoTake({ workspace, changes, ...(scratchpad ? { scratchpad } : {}) }, { dir, changeId, ...(keptItemId !== undefined ? { keptItemId } : {}) })
      if (result.ok) { dependencies.afterTake?.(state); if (result.cardWithdrawn) dependencies.afterSend?.(state) }
      return result
    } catch {
      return { ok: false, reason: 'failed', message: 'That take could not be taken back from here. Decline it in the part’s margin.' }
    }
  })

  // Ticket 10: send a copy of paragraphs of a saved version's part to the Scratchpad. The window names the Folio, the version, the part and a
  // range of paragraph numbers, plus the folder it believes it is in; main re-reads the saved text and counts the paragraphs itself, fills in
  // where the text came from, and writes one Scratchpad item through the Scratchpad store's checked writer. Nothing else is written.
  ipc.handle('folio-versions:send-text', async (event, input: unknown): Promise<VersionSendReply> => {
    const state = dependencies.stateForSender(event.sender.id)
    const workspace = dependencies.requireWorkspace(state)
    const dir = folderOf(workspace, input)
    const { root, id, path, side, from, to } = (input ?? {}) as Record<string, unknown>
    if (root !== workspace.root) return { ok: false, error: 'This window now shows another folder, so nothing was sent. Try again.' }
    if (dir === null || typeof id !== 'string' || !isFolioVersionId(id) || typeof path !== 'string' || path === '' || path.length > 1000
      || typeof side !== 'string' || !(VERSION_TEXT_SIDES as readonly string[]).includes(side) || typeof from !== 'number' || typeof to !== 'number') {
      return { ok: false, error: 'That is not text of a saved version that can be sent. Nothing was sent.' }
    }
    const store = dependencies.requireScratchpad?.(state)
    if (!store) return { ok: false, error: VERSION_SEND_UNAVAILABLE }
    try {
      const sent = await sendVersionText({ sources: readerFor(workspace), store }, { dir, id, path, side: side as VersionTextSide, from, to }, 'writer')
      dependencies.afterSend?.(state)
      return { ok: true, item: sent.item, part: sent.part.title, versionName: sent.part.version.name, from, to, words: sent.markdown.trim().split(/\s+/).filter(Boolean).length }
    } catch (error) {
      return { ok: false, error: `Nothing was sent: ${error instanceof Error && error.message ? error.message : 'the Scratchpad could not do that.'}` }
    }
  })
}
