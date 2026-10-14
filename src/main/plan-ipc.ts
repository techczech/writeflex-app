import { MANIFEST_NAME } from './folio'
import { canonicalFolioDir } from './folio-dir'
import { addFolioPieces, moveFolioPiece, removeAddedFolioPieces } from './folio-running-order'
import { adoptPart, insertPart, materialisePart, movePart, readPlan, removePart, type Plan, type PlanWriteOptions } from './plan'
import { assertRelativeWorkspacePath, type Workspace } from './workspace'

type PlanIpcEvent = { sender: { id: number } }
export type PlanIpcHandler = (event: PlanIpcEvent, input: any) => unknown | Promise<unknown>
export type PlanIpcRegistrar = { handle: (channel: string, handler: PlanIpcHandler) => void }

export type PlanIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  checkpointFile: (state: State, path: string) => Promise<void>
  notifyCollectionChanged: (state: State, paths: string[]) => void
  notifyChangedOnDisk: (state: State, paths: string[]) => void
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('Invalid running order.')
  return value as string[]
}

/** The Folio folder a request names, in its one spelling (folio-dir.ts): what the lock, the cache and every path built from it use. */
export function collectionDir(workspace: Pick<Workspace, 'root'>, input: { dir?: string } | undefined): string {
  const dir = input?.dir ?? ''
  if (typeof dir !== 'string') throw new Error('Invalid Folio folder.')
  if (dir !== '') assertRelativeWorkspacePath(dir)
  return canonicalFolioDir(workspace.root, dir)
}

export function registerPlanIpcHandlers<State>(
  ipc: PlanIpcRegistrar,
  dependencies: PlanIpcDependencies<State>,
): void {
  const context = (event: PlanIpcEvent) => {
    const state = dependencies.stateForSender(event.sender.id)
    const workspace = dependencies.requireWorkspace(state)
    const options: PlanWriteOptions = {
      beforeIndexWrite: (path) => dependencies.checkpointFile(state, path),
      beforeManifestWrite: (path) => dependencies.checkpointFile(state, path),
    }
    const publish = (plan: Plan, paths: string[] = []) => {
      dependencies.notifyCollectionChanged(state, [plan.indexPath, ...paths])
      dependencies.notifyChangedOnDisk(state, [plan.indexPath])
    }
    /** A running-order change from the Outline: a Plan write, or the manifest alone for a Folio with no Index Note. */
    const publishOrder = (dir: string, outcome: { plan: Plan | null; manifestOnly?: true; writtenIndex?: string }) => {
      const manifest = dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME
      if (outcome.plan) publish(outcome.plan, [manifest])
      // Both documents were written and the Plan could not be read again (or an Undo stopped after a write): the buffers are told all the same.
      else if (outcome.writtenIndex) {
        dependencies.notifyCollectionChanged(state, [outcome.writtenIndex, manifest])
        dependencies.notifyChangedOnDisk(state, [outcome.writtenIndex])
      }
      // No Index Note was written, so there is no open buffer to tell; the collection push refreshes the Plan line and the Outline.
      else if (outcome.manifestOnly) dependencies.notifyCollectionChanged(state, [manifest])
    }
    return { state, workspace, options, publish, publishOrder }
  }

  ipc.handle('plan:read', async (event, input: { dir?: string }) => {
    const { workspace } = context(event)
    return readPlan(workspace, collectionDir(workspace, input))
  })

  ipc.handle('plan:adopt-part', async (event, input: { dir?: string; unlistedIndex?: number }) => {
    if (!Number.isInteger(input?.unlistedIndex)) throw new Error('Invalid Plan adoption.')
    const { workspace, options, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const plan = await adoptPart(workspace, dir, input.unlistedIndex as number, options)
    publish(plan)
    return plan
  })

  ipc.handle('plan:insert-part', async (event, input: { dir?: string; at?: number; part?: { title?: string; gloss?: string; role?: string } }) => {
    if (!Number.isInteger(input?.at) || typeof input?.part?.title !== 'string') throw new Error('Invalid Plan insertion.')
    if (input.part.gloss !== undefined && typeof input.part.gloss !== 'string') throw new Error('Invalid Plan gloss.')
    if (input.part.role !== undefined && typeof input.part.role !== 'string') throw new Error('Invalid Plan role.')
    const { workspace, options, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const plan = await insertPart(workspace, dir, input.at as number, {
      title: input.part.title,
      ...(input.part.gloss !== undefined ? { gloss: input.part.gloss } : {}),
      ...(input.part.role !== undefined ? { role: input.part.role } : {}),
    }, options)
    publish(plan, [dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return plan
  })

  ipc.handle('plan:move-part', async (event, input: { dir?: string; from?: number; to?: number }) => {
    if (!Number.isInteger(input?.from) || !Number.isInteger(input?.to)) throw new Error('Invalid Plan move.')
    const { workspace, options, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const plan = await movePart(workspace, dir, input.from as number, input.to as number, options)
    publish(plan, [dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return plan
  })

  ipc.handle('plan:remove-part', async (event, input: { dir?: string; index?: number }) => {
    if (!Number.isInteger(input?.index)) throw new Error('Invalid Plan removal.')
    const { workspace, options, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const plan = await removePart(workspace, dir, input.index as number, options)
    publish(plan, [dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return plan
  })

  // Every write handler here runs under the Folio's lock: the Plan writes take it themselves (plan.ts), and the
  // three Outline routes below hold it across their whole read, check and write (folio-running-order.ts).
  // The Outline's running-order changes name pieces by path and the running order the caller saw, and call the
  // same Plan writes as the neighbours above. They answer a refusal as a result, never with a path in an error.
  ipc.handle('folio:move-piece', async (event, input: { dir?: string; path?: unknown; beforePath?: unknown; expected?: unknown }) => {
    if (typeof input?.path !== 'string' || !(input.beforePath === null || typeof input.beforePath === 'string')) throw new Error('Invalid piece move.')
    const expected = stringList(input.expected)
    const { workspace, options, publishOrder } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await moveFolioPiece(workspace, dir, { path: input.path, beforePath: input.beforePath, expected }, options)
    publishOrder(dir, outcome)
    return outcome.result
  })

  ipc.handle('folio:add-pieces', async (event, input: { dir?: string; paths?: unknown; expected?: unknown }) => {
    const paths = stringList(input?.paths)
    const expected = stringList(input?.expected)
    const { workspace, options, publishOrder } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await addFolioPieces(workspace, dir, { paths, expected }, options)
    publishOrder(dir, outcome)
    return outcome.result
  })

  ipc.handle('folio:remove-added', async (event, input: { dir?: string; paths?: unknown; expected?: unknown }) => {
    const paths = stringList(input?.paths)
    const expected = stringList(input?.expected)
    const { workspace, options, publishOrder } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await removeAddedFolioPieces(workspace, dir, { paths, expected }, options)
    publishOrder(dir, outcome)
    return outcome.result
  })

  ipc.handle('plan:materialise-part', async (event, input: { dir?: string; index?: number }) => {
    if (!Number.isInteger(input?.index)) throw new Error('Invalid Plan materialisation.')
    const { state, workspace, options, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const result = await materialisePart(workspace, dir, input.index as number, options)
    try {
      await dependencies.checkpointFile(state, result.path)
    } catch {
      // The file and manifest already exist. A snapshot failure must not turn a completed write into
      // a reported failure whose retry would then be refused as a duplicate.
    }
    publish(result.plan, [result.path, dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return result
  })
}
