/**
 * The rename doors: renaming a document, moving it to another folder, and renaming a folder, each with its links
 * repaired (ADR-0017). One place holds the choreography the three IPC channels share: the Collection-move check,
 * the repair plan, one exclusive turn for the rename and everything that follows the document to its new name
 * (the outside-change ledger, the Scratchpad, sharing), a checkpoint on the agent before each repair write, and the
 * window's notices. It takes what it needs as dependencies, so it is tested against a real folder on disk without
 * booting the IPC layer.
 */
import { posix } from 'node:path'
import { fileNameProblem } from '../shared/file-name-rules'
import { markdownNameProblem, newPathNameProblem } from './file-name-rules'
import { assertCollectionMove, collectionMoveFolderPieces } from './collection'
import { applyFolderRenameRepair, planFolderRenameRepair, type FolderRenameRepairResult } from './folder-rename-repair'
import type { PathIdentity } from './guarded-document-move'
import { applyRenameRepair, failedRenameRepairResult, planRenameRepair, type RenameRepairResult } from './rename-repair'
import { RenameRepairMarkdownCache } from './rename-repair-markdown'
import { sanitiseFileName, type FileReadResult, type Workspace } from './workspace'

/** Whatever follows a document to its new name. Each never fails the rename (it records its own diagnostic). */
export type RenameFollow = {
  /** The outside-change ledger and a synced Collection's pending save version. */
  ledger: (from: string, to: string) => Promise<void>
  scratchpad: (from: string, to: string) => Promise<void>
  /** Sharing (ticket 04): told in the same turn, before any save signal names either path. */
  sharing: (from: string, to: string) => void
}

export type RenameCheckpointAgent = { checkpointFile: (path: string) => Promise<unknown> }

/** The window's agent, which keeps a checkpoint of each file before a repair writes over it. */
export type RenameCheckpointer = {
  /** The agent when it has started, 'starting' while it starts, null when this window has none. */
  current: () => RenameCheckpointAgent | 'starting' | null
  /** The agent once started (throws when its start-up failed), or null when this window has none. */
  ready: () => Promise<RenameCheckpointAgent | null>
}

export type RenameNotifier = {
  collectionChanged: (paths: string[]) => void
  /** Files the repair rewrote, for open editors to reload. Sent only when there are some. */
  changedOnDisk: (paths: string[]) => void
}

export type RenameDoorDeps = {
  workspace: Workspace
  follow: RenameFollow
  checkpointer: RenameCheckpointer
  notify: RenameNotifier
  /** A document renamed by a file door: what the window kept about it under its old name is dropped. */
  forget?: (path: string) => void
}

/** Where a move puts the document. Root intent is explicit: a bare name never means "the workspace root" by accident. */
export type MoveDestination = { to: 'root'; name: string } | { to: 'folder'; path: string }

/** The Collection multi-select move: one batch of `moveFile` calls between `collection:begin-batch` and `end-batch`. */
export class RenameBatch {
  /** Folder pieces found once per Collection for the whole batch. */
  readonly folderPieces = new Map<string, Promise<ReadonlySet<string>>>()
  readonly #moves = new Map<string, string>()

  /** Moves made so far in this batch, from → to (a document moved twice keeps its first name as the key). */
  get moves(): ReadonlyMap<string, string> { return this.#moves }

  record(from: string, to: string): void {
    for (const [first, now] of this.#moves) if (now === from) { this.#moves.set(first, to); return }
    this.#moves.set(from, to)
  }
}

export type FileRenameResult = FileReadResult & { repair: RenameRepairResult }
export type FolderRenameResult = {
  path: string
  repair: FolderRenameRepairResult
  /** Index Note paths before and after the whole folder rename. */
  indexNote?: { from: string; to: string }
}

// One tentative rename per workspace. Another preview replaces it, and the matching commit consumes it.
const previewMarkdown = new WeakMap<Workspace, { from: string; to: string; cache: RenameRepairMarkdownCache }>()

/** The repair a rename would make, for the rename dialog: the path it lands at and the files it would rewrite. */
export async function previewRename(
  workspace: Workspace,
  input: { path: string; newName: string; directory?: string | null },
): Promise<{ newPath: string; repairPaths: string[] }> {
  const keepsName = input.directory !== undefined && input.newName === posix.basename(input.path)
  const nameProblem = keepsName ? null : markdownNameProblem(input.newName)
  if (nameProblem) throw new Error(nameProblem)
  const name = sanitiseFileName(input.newName)
  const requestedPath = input.directory === null ? `./${name}` : input.directory ? `${input.directory}/${name}` : name
  const newPath = workspace.relative(workspace.renameTarget(input.path, requestedPath))
  const previous = previewMarkdown.get(workspace)
  const cache = previous?.from === input.path && previous.to === newPath ? previous.cache : new RenameRepairMarkdownCache()
  previewMarkdown.set(workspace, { from: input.path, to: newPath, cache })
  const plan = await planRenameRepair(workspace, input.path, newPath, { markdownCache: cache })
  return { newPath, repairPaths: plan.writes.map((write) => write.path) }
}

/**
 * Rename a document (a bare new name stays in its folder; `./name` is the workspace root) and repair the links to it.
 * `guardedSource`, asked inside the turn, answers the identity the source must still have (automatic naming and
 * its undo): the rename then moves only that document and needs its folder to exist.
 */
export async function renameFile(
  deps: RenameDoorDeps,
  path: string,
  newPath: string,
  guardedSource?: () => Promise<PathIdentity>,
): Promise<FileRenameResult> {
  return renameWithRepair(deps, path, newPath, { guardedSource })
}

/** Move a document to another folder, from the Files sidebar or a Collection (`collection`), and repair its links. */
export async function moveFile(
  deps: RenameDoorDeps,
  path: string,
  destination: MoveDestination,
  collection?: { dir: string; batch?: RenameBatch },
): Promise<FileRenameResult> {
  const newPath = destination.to === 'root' ? `./${destination.name}` : destination.path
  return renameWithRepair(deps, path, newPath, { collection, keepNameOf: path })
}

async function renameWithRepair(
  deps: RenameDoorDeps,
  path: string,
  newPath: string,
  options: { collection?: { dir: string; batch?: RenameBatch }; guardedSource?: () => Promise<PathIdentity>; keepNameOf?: string },
): Promise<FileRenameResult> {
  const { workspace, follow, checkpointer, notify } = deps
  const { collection, guardedSource, keepNameOf } = options
  const requestedPath = newPath.includes('/') ? newPath : `${posix.dirname(path)}/${newPath}`
  const nameProblem = newPathNameProblem(workspace, requestedPath, { markdown: true, keepNameOf })
  if (nameProblem) throw new Error(nameProblem)
  let discovered: Promise<ReadonlySet<string>> | undefined
  const folderPieces = (dir: string) => () => {
    discovered ??= collection?.batch?.folderPieces.get(dir) ?? collectionMoveFolderPieces(workspace, dir)
    collection?.batch?.folderPieces.set(dir, discovered)
    return discovered
  }
  const checkCollectionMove = async () => {
    if (collection) await assertCollectionMove(workspace, collection.dir, path, newPath, folderPieces(collection.dir))
  }
  await checkCollectionMove()
  const targetPath = workspace.relative(workspace.renameTarget(path, newPath))
  // Documents moved earlier in the same batch keep their links to this one, and its links to them (ticket 02's
  // own-folder fix, for the Collection's multi-select move).
  const batchMoves = collection?.batch?.moves
  const preview = previewMarkdown.get(workspace)
  const markdownCache = preview?.from === path && preview.to === targetPath ? preview.cache : undefined
  if (markdownCache) previewMarkdown.delete(workspace)
  const plan = await planRenameRepair(workspace, path, targetPath, {
    ...(batchMoves?.size ? { batchMoves } : {}),
    ...(markdownCache ? { markdownCache } : {}),
  })
  // One turn for the rename and the ledger's follow: an undecided Change from outside filed for this
  // document follows it to its new name before any decision on it can run.
  const renamed = await workspace.exclusiveAll(async () => {
    await checkCollectionMove()
    const expectedSource = await guardedSource?.()
    const moved = await workspace.renameFile(path, newPath, expectedSource
      ? { documentOnly: true, requireExistingDirectory: true, expectedSource }
      : { requireExistingDirectory: collection !== undefined })
    deps.forget?.(path)
    await follow.ledger(path, moved.file.path)
    await follow.scratchpad(path, moved.file.path)
    follow.sharing(path, moved.file.path)
    return moved
  })
  collection?.batch?.record(path, renamed.file.path)
  let repair: RenameRepairResult
  try {
    const checkpoint = async (repairPath: string) => {
      const agent = await checkpointer.ready()
      if (agent) await agent.checkpointFile(repairPath)
    }
    repair = await applyRenameRepair(plan, workspace, {
      beforeMarkdownWrite: checkpoint,
      beforeManifestWrite: checkpoint,
    })
  } catch (error) {
    repair = await failedRenameRepairResult(plan, workspace, error)
  }
  notify.collectionChanged([path, renamed.file.path, ...repair.writtenPaths])
  if (repair.writtenPaths.length) notify.changedOnDisk(repair.writtenPaths)
  return { ...renamed, repair }
}

/**
 * Rename a folder and repair the `./` path links into it: read before it moves and written after
 * (folder-rename-repair.ts, Sol round 4), in one turn with no other rename between (Sol round 5).
 * Each repair write is checkpointed on the agent. The agent is never awaited inside the turn (its start-up may wait
 * on the model service, holding every save), and a rename with nothing to repair never waits on it at all (Sol
 * round 6). So when the plan has writes and the agent is still starting, the turn ends before anything moves, the
 * agent is awaited outside it, and the whole turn runs again with the agent in hand. A failed start-up refuses each
 * repair write.
 */
export async function renameFolder(deps: RenameDoorDeps, path: string, newName: string): Promise<FolderRenameResult> {
  const nameProblem = fileNameProblem(newName)
  if (nameProblem) throw new Error(nameProblem)
  const { workspace, follow, checkpointer, notify } = deps
  type Held = { agent: RenameCheckpointAgent } | { error: unknown } | null
  const attempt = (given: Held | undefined) => workspace.exclusiveAll(async () => {
    const from = workspace.relative(workspace.absolute(path))
    const parent = posix.dirname(from)
    const predicted = parent === '.' ? sanitiseFileName(newName) : `${parent}/${sanitiseFileName(newName)}`
    const planned = await planFolderRenameRepair(workspace, from, predicted)
    let held: Held = given ?? null
    if (given === undefined && planned.writes.length) {
      const agent = checkpointer.current()
      if (agent === 'starting') return null // await it outside the turn, then again
      if (agent) held = { agent }
    }
    const checkpoint = async (repairPath: string): Promise<void> => {
      if (!held) return
      if ('error' in held) throw held.error
      await held.agent.checkpointFile(repairPath)
    }
    // The folder's Index Note is named after the folder: it takes the new name with it (as the command line's folder
    // move does), so the Folio keeps its declaration and its title (folio.ts `indexNotePath`).
    const moved = await workspace.renameFolder(path, newName, { renameIndexNote: true })
    await follow.ledger(path, moved.path)
    await follow.scratchpad(from, moved.path)
    follow.sharing(path, moved.path)
    if (moved.indexNote) {
      await follow.ledger(moved.indexNote.from, moved.indexNote.to)
      await follow.scratchpad(moved.indexNote.from, moved.indexNote.to)
      follow.sharing(moved.indexNote.from, moved.indexNote.to)
    }
    const repair = moved.path === predicted
      ? await applyFolderRenameRepair(planned, workspace, checkpoint)
      : { writtenPaths: [], unrepairedReferences: [] }
    if (moved.indexNote) {
      // Links that named the Index Note by its old file name (or by the path the folder repair just gave it) follow it.
      try {
        const indexRepair = await applyRenameRepair(await planRenameRepair(workspace, moved.indexNote.from, moved.indexNote.to), workspace, {
          beforeMarkdownWrite: checkpoint,
          beforeManifestWrite: checkpoint,
        })
        repair.writtenPaths.push(...indexRepair.writtenPaths.filter((written) => !repair.writtenPaths.includes(written)))
      } catch { /* the rename stands; a link left unrepaired is no loss */ }
    }
    const indexNote = moved.indexNote && {
      from: from + moved.indexNote.from.slice(moved.path.length),
      to: moved.indexNote.to,
    }
    return { path: moved.path, repair, ...(indexNote && { indexNote }) }
  })
  let outcome = await attempt(undefined)
  if (!outcome) {
    let held: Held = null
    try {
      const agent = await checkpointer.ready()
      if (agent) held = { agent }
    } catch (error) { held = { error } }
    outcome = (await attempt(held))!
  }
  notify.collectionChanged([path, outcome.path, ...outcome.repair.writtenPaths])
  if (outcome.repair.writtenPaths.length) notify.changedOnDisk(outcome.repair.writtenPaths)
  return outcome
}

/** The agent's own rename (verbs `housekeeping.rename_file`) repairs and checkpoints itself; it tells sharing and
 *  moves the Scratchpad's items, as the app's rename does, before any save signal. */
export async function followAgentRename(follow: Pick<RenameFollow, 'scratchpad' | 'sharing'>, from: string, to: string): Promise<void> {
  follow.sharing(from, to)
  await follow.scratchpad(from, to)
}
