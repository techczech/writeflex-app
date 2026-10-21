import { posix } from 'node:path'
import { MANIFEST_NAME } from './folio'
import { folioContaining, folioOwning } from './folio-place'
import { canonicalFolioDir } from './folio-dir'
import { addFolioPieces, moveFolioPiece, removeAddedFolioPieces } from './folio-running-order'
import { addPlanParts, removeAddedPlanParts, reorderPlanParts } from './plan-running-order'
import { PartChangedError, setPartHeadingMode } from './folio-part-proposals'
import { adoptPart, insertPart, materialisePart, movePart, readFolioFrontMatter, readFolioPlan, readPlan, removePart, setPartRole, type Plan, type PlanWriteOptions } from './plan'
import { assertRelativeWorkspacePath, DiskChangedUnderBuffer, SaveWithoutBasis, type Workspace } from './workspace'
import { PLAN_ROLES } from '../shared/plan-line'
import { isSaveBasis } from '../shared/save-basis'
import { orderFor } from './folio'
import { fixTitleConflicts, undoTitleFix, type TitleFixRequest } from './title-conflict-fix'
import type { TitleFixDirection } from '../shared/title-conflict'
import { unlistedRowRefusal, type PlanCardKey, type PlanPartKey } from '../shared/folio-running-order'

type PlanIpcEvent = { sender: { id: number } }
export type PlanIpcHandler = (event: PlanIpcEvent, input: any) => unknown | Promise<unknown>
export type PlanIpcRegistrar = { handle: (channel: string, handler: PlanIpcHandler) => void }

export type PlanIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  checkpointFile: (state: State, path: string) => Promise<void>
  notifyCollectionChanged: (state: State, paths: string[]) => void
  notifyChangedOnDisk: (state: State, paths: string[]) => void
  /** Stage the title proposals for the Folio at `dir` (ticket 0.23-09). Run after a part is added; best effort, never throws to the caller. */
  proposePartTitles?: (state: State, dir: string) => Promise<void>
}

/** The running order a Plan request says it saw: every part's title and file (null = not written yet). */
function planPartKeyList(value: unknown): PlanPartKey[] {
  const valid = Array.isArray(value) && value.every((item) => (
    typeof item === 'object' && item !== null && typeof (item as PlanPartKey).title === 'string'
      && ((item as PlanPartKey).path === null || typeof (item as PlanPartKey).path === 'string')
  ))
  if (!valid) throw new Error('Invalid running order.')
  return (value as PlanPartKey[]).map((item) => ({ title: item.title, path: item.path }))
}

/** The card a role request says it saw: its whole line, so two cards with one title are told apart (review round 2). Null when malformed. */
function planCardKey(value: unknown): PlanCardKey | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as PlanCardKey
  const valid = typeof item.title === 'string' && (item.path === null || typeof item.path === 'string')
    && (item.gloss === null || typeof item.gloss === 'string') && typeof item.role === 'string'
    && Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string')
  return valid ? { title: item.title, path: item.path, gloss: item.gloss, role: item.role, tags: [...item.tags] } : null
}

/** The Put back row a request says it saw: its file and title. Null when malformed. */
function unlistedRowKey(value: unknown): PlanPartKey | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as PlanPartKey
  return typeof item.title === 'string' && typeof item.path === 'string' ? { title: item.title, path: item.path } : null
}

function indexList(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) throw new Error('Invalid running order.')
  return value as number[]
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('Invalid running order.')
  return value as string[]
}

/** An Undo's token as sent: a non-empty string (an unknown one is refused as stale by folio-add-undo.ts). */
function undoToken(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 200) throw new Error('Invalid Undo.')
  return value
}

/** The Folio folder a request names, in its one spelling (folio-dir.ts): what the lock, the cache and every path built from it use. */
export function collectionDir(workspace: Pick<Workspace, 'root'>, input: { dir?: string } | undefined): string {
  const dir = input?.dir ?? ''
  if (typeof dir !== 'string') throw new Error('Invalid Folio folder.')
  if (dir !== '') assertRelativeWorkspacePath(dir)
  return canonicalFolioDir(workspace.root, dir)
}

const isDirection = (value: unknown): value is TitleFixDirection => value === 'heading-to-title' || value === 'title-to-heading'

/**
 * One `{ path, fingerprint }` a title-conflict request names: a workspace-relative path and the version seen.
 * The path is normalised (`a/./b.md` is `a/b.md`, `dir/../x.md` is `x.md`); an absolute path, one that leaves
 * the workspace, or one with a backslash is refused. Membership of the Folio is checked by `assertFolioParts`.
 */
function titleFixRequest(value: unknown): TitleFixRequest {
  const item = value as Partial<TitleFixRequest> | null
  if (typeof item !== 'object' || item === null || typeof item.path !== 'string' || typeof item.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(item.fingerprint)) {
    throw new Error('Invalid title change.')
  }
  if (item.path.includes('\\')) throw new Error('Invalid title change.')
  assertRelativeWorkspacePath(item.path)
  return { path: posix.normalize(item.path), fingerprint: item.fingerprint }
}

/**
 * Refuse unless every path is one of the Folio's own parts: its running order (the manifest's, or the
 * folder's fallback) or a part the Plan lists. Compared exactly, after `titleFixRequest` normalised each path:
 * a file merely under the Folio's folder is not a part.
 *
 * First, main finds the Folio that owns each path itself (folio-place.ts, the rule the Folio line and the
 * Outline use, a manifest's `content_root` included) and refuses unless it is the folder the renderer named.
 * Otherwise a renderer could name `book/contents` for a part of `book/_report-structure.json`: the folder's
 * fallback order would list it, and the front-matter check would read a folder with no manifest.
 */
async function assertFolioParts(workspace: Workspace, dir: string, items: readonly TitleFixRequest[]): Promise<void> {
  for (const item of items) {
    const owner = await folioOwning(workspace, item.path)
    if (!owner || owner.dir !== dir) throw new Error('That file is not a part of this Folio.')
  }
  const plan = await readPlan(workspace, dir)
  const parts = new Set<string>([...await orderFor(workspace, dir), ...(plan?.parts ?? []).flatMap((part) => (part.path ? [part.path] : []))])
  if (items.some((item) => !parts.has(item.path))) throw new Error('That file is not a part of this Folio.')
}

/** A front-matter part (a title page) takes its title from its frontmatter only: there is no heading to match. */
export const FRONT_MATTER_TITLE_REFUSED = 'This part is front matter: its title comes from its frontmatter and it has no heading, so there is nothing to match. Nothing was changed.'

/** The refusal when any path is one of the Folio's front-matter parts (shared/folio-front-matter.ts), else null.
 *  `dir` is the owning Folio's folder: `assertFolioParts` checked it first. */
async function frontMatterRefusal(workspace: Workspace, dir: string, items: readonly TitleFixRequest[]): Promise<{ ok: false; message: string } | null> {
  const frontMatter = await readFolioFrontMatter(workspace, dir)
  return items.some((item) => frontMatter.has(item.path)) ? { ok: false, message: FRONT_MATTER_TITLE_REFUSED } : null
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
    /** A part was added: its title is checked, and any proposal waits in the change ledger. A failure here never fails the add. */
    const proposeTitles = async (dir: string) => {
      try { await dependencies.proposePartTitles?.(state, dir) } catch { /* the add already happened */ }
    }
    /**
     * The Folio page's own changes (Put back, Add a part, move, take out, role). A Folio with a manifest and no Index
     * Note file showed the Plan its first Index Note gives (`readFolioPlan`): the write reads the same Plan, checks the
     * change against it before anything touches the disk, and creates the Index Note holding the running order and
     * the change in one guarded write (plan.ts `createsIndexNote`). Its checkpoint records the Index Note as absent.
     */
    const pageOptions: PlanWriteOptions = { ...options, createsIndexNote: true }
    return { state, workspace, options, pageOptions, publish, publishOrder, proposeTitles }
  }

  // The Folio page's read: a Folio always has an outline (a manifest with no Index Note reads as its first Index Note would).
  ipc.handle('plan:read', async (event, input: { dir?: string }) => {
    const { workspace } = context(event)
    return readFolioPlan(workspace, collectionDir(workspace, input))
  })

  // Put back names the row the owner saw, by file and title, not only its place: a list that changed meanwhile
  // (another writer added or removed a file) is refused under the lock before anything is written (review round 2 P1).
  // `asFrontMatter`: "Add as front matter" (ADR-0046), the same guarded Put back with the part's role set to front matter;
  // the writer refuses a file that is not offered as front matter.
  ipc.handle('plan:adopt-part', async (event, input: { dir?: string; unlistedIndex?: number; expected?: unknown; asFrontMatter?: unknown }) => {
    const expected = unlistedRowKey(input?.expected)
    if (!Number.isInteger(input?.unlistedIndex) || !expected) throw new Error('Invalid Folio outline adoption.')
    if (input.asFrontMatter !== undefined && typeof input.asFrontMatter !== 'boolean') throw new Error('Invalid Folio outline adoption.')
    const unlistedIndex = input.unlistedIndex as number
    const { workspace, pageOptions, publish, proposeTitles } = context(event)
    const dir = collectionDir(workspace, input)
    const plan = await adoptPart(workspace, dir, unlistedIndex, {
      ...pageOptions,
      verifyPlan: (seen) => {
        const refusal = unlistedRowRefusal(seen.unlisted, unlistedIndex, expected)
        if (refusal) throw new Error(refusal)
      },
    }, input.asFrontMatter === true)
    publish(plan)
    await proposeTitles(dir)
    return plan
  })

  ipc.handle('plan:insert-part', async (event, input: { dir?: string; at?: number; part?: { title?: string; gloss?: string; role?: string } }) => {
    if (!Number.isInteger(input?.at) || typeof input?.part?.title !== 'string') throw new Error('Invalid Folio outline insertion.')
    if (input.part.gloss !== undefined && typeof input.part.gloss !== 'string') throw new Error('Invalid Folio outline gloss.')
    if (input.part.role !== undefined && typeof input.part.role !== 'string') throw new Error('Invalid Folio outline role.')
    const { workspace, pageOptions, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const part = {
      title: input.part.title,
      ...(input.part.gloss !== undefined ? { gloss: input.part.gloss } : {}),
      ...(input.part.role !== undefined ? { role: input.part.role } : {}),
    }
    const plan = await insertPart(workspace, dir, input.at as number, part, pageOptions)
    publish(plan, [dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return plan
  })

  ipc.handle('plan:move-part', async (event, input: { dir?: string; from?: number; to?: number }) => {
    if (!Number.isInteger(input?.from) || !Number.isInteger(input?.to)) throw new Error('Invalid Folio outline move.')
    const { workspace, pageOptions, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const plan = await movePart(workspace, dir, input.from as number, input.to as number, pageOptions)
    publish(plan, [dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return plan
  })

  ipc.handle('plan:remove-part', async (event, input: { dir?: string; index?: number }) => {
    if (!Number.isInteger(input?.index)) throw new Error('Invalid Folio outline removal.')
    const { workspace, pageOptions, publish } = context(event)
    const dir = collectionDir(workspace, input)
    const plan = await removePart(workspace, dir, input.index as number, pageOptions)
    publish(plan, [dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return plan
  })

  // The card the owner changed is named by its whole line (title, file, gloss, role, tags): a running order that
  // moved meanwhile (another writer, an agent) is refused before anything is written (review P2), and so is a
  // card that reads exactly like another, since the request cannot say which of the two was meant (round 2).
  ipc.handle('plan:set-part-role', async (event, input: { dir?: string; index?: number; role?: string; expected?: unknown }) => {
    if (!Number.isInteger(input?.index) || typeof input?.role !== 'string' || !(PLAN_ROLES as readonly string[]).includes(input.role)) throw new Error('Invalid Folio outline role.')
    const expected = planCardKey(input.expected)
    if (!expected) throw new Error('Invalid Folio outline role.')
    const index = input.index as number
    const { workspace, pageOptions, publish } = context(event)
    const dir = collectionDir(workspace, input)
    // The writer checks the card under the lock (plan.ts `setPartRole`).
    const plan = await setPartRole(workspace, dir, index, input.role as string, expected, pageOptions)
    publish(plan, [dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    return plan
  })

  // The Plan's whole-order changes (plan-running-order.ts): Sort by chapter number, Add all from this folder,
  // and the Undo of each. They name the running order the caller saw, as titles and files, and call the Plan
  // writes above; a refusal is an answer, never an error with a path in it.
  ipc.handle('plan:reorder-parts', async (event, input: { dir?: string; order?: unknown; expected?: unknown }) => {
    const order = indexList(input?.order)
    const expected = planPartKeyList(input?.expected)
    const { workspace, options, publishOrder } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await reorderPlanParts(workspace, dir, { order, expected }, options)
    publishOrder(dir, outcome)
    return outcome.result
  })

  ipc.handle('plan:add-parts', async (event, input: { dir?: string; paths?: unknown; expected?: unknown }) => {
    const paths = stringList(input?.paths)
    const expected = planPartKeyList(input?.expected)
    const { workspace, options, publishOrder, proposeTitles } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await addPlanParts(workspace, dir, { paths, expected }, options)
    publishOrder(dir, outcome)
    if (outcome.result.ok) await proposeTitles(dir)
    return outcome.result
  })

  // The Undo of an Add names that Add's token only: main checks the documents are exactly as that Add left them.
  ipc.handle('plan:remove-added', async (event, input: { dir?: string; token?: unknown }) => {
    const token = undoToken(input?.token)
    const { workspace, options, publishOrder } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await removeAddedPlanParts(workspace, dir, { token }, options)
    publishOrder(dir, outcome)
    return outcome.result
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
    const { workspace, options, publishOrder, proposeTitles } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await addFolioPieces(workspace, dir, { paths, expected }, options)
    publishOrder(dir, outcome)
    await proposeTitles(dir)
    return outcome.result
  })

  ipc.handle('folio:remove-added', async (event, input: { dir?: string; token?: unknown }) => {
    const token = undoToken(input?.token)
    const { workspace, options, publishOrder } = context(event)
    const dir = collectionDir(workspace, input)
    const outcome = await removeAddedFolioPieces(workspace, dir, { token }, options)
    publishOrder(dir, outcome)
    return outcome.result
  })

  ipc.handle('plan:materialise-part', async (event, input: { dir?: string; index?: number }) => {
    if (!Number.isInteger(input?.index)) throw new Error('Invalid Folio outline materialisation.')
    const { state, workspace, options, publish, proposeTitles } = context(event)
    const dir = collectionDir(workspace, input)
    const result = await materialisePart(workspace, dir, input.index as number, options)
    try {
      await dependencies.checkpointFile(state, result.path)
    } catch {
      // The file and manifest already exist. A snapshot failure must not turn a completed write into
      // a reported failure whose retry would then be refused as a duplicate.
    }
    publish(result.plan, [result.path, dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME])
    await proposeTitles(dir)
    return result
  })

  // Title-conflict buttons (2026-10-19): the Plan's and the Outline's "Use heading as title" / "Use title as
  // heading" for one part of the Folio at `dir`, over the version the caller saw. The owner's own click, written
  // directly after a checkpoint, as the heading choice below; the answer carries one Undo step's token.
  // A refusal is an answer, never an error. The renderer refuses first when the part is open with unsaved edits.
  ipc.handle('title:fix-part', async (event, input: { dir?: string; item?: unknown; direction?: unknown }) => {
    if (!isDirection(input?.direction)) throw new Error('Invalid title change.')
    const item = titleFixRequest(input?.item)
    const { state, workspace } = context(event)
    const dir = collectionDir(workspace, input)
    await assertFolioParts(workspace, dir, [item])
    // Defence in depth: the Plan and the Outline offer no fix on front matter.
    const refused = await frontMatterRefusal(workspace, dir, [item])
    if (refused) return refused
    const done = await workspace.withWriteReceipts(() => fixTitleConflicts(workspace, [item], input.direction as TitleFixDirection, {
      part: true,
      beforeWrite: (at) => dependencies.checkpointFile(state, at),
    }))
    const answer = done.value
    if (answer.ok && answer.written.length) {
      dependencies.notifyCollectionChanged(state, answer.written)
      dependencies.notifyChangedOnDisk(state, answer.written)
    }
    return answer
  })

  // The Plan header's "Use headings as titles for all N" / "Use titles as headings for all N": every part the
  // caller counted, each over the version it saw, in one Undo step. Only the Folio's own parts: its running
  // order (the manifest's, or the folder's fallback) and the Plan's parts; any other path refuses the whole call.
  ipc.handle('title:fix-folio', async (event, input: { dir?: string; items?: unknown; direction?: unknown }) => {
    if (!isDirection(input?.direction) || !Array.isArray(input?.items) || input.items.length === 0) throw new Error('Invalid title change.')
    const items = (input.items as unknown[]).map(titleFixRequest)
    const { state, workspace } = context(event)
    const dir = collectionDir(workspace, input)
    await assertFolioParts(workspace, dir, items)
    // Defence in depth, for the whole call: the Plan counts no front matter among its conflicts.
    const refused = await frontMatterRefusal(workspace, dir, items)
    if (refused) return refused
    const unique = [...new Map(items.map((item) => [item.path, item])).values()]
    const done = await workspace.withWriteReceipts(() => fixTitleConflicts(workspace, unique, input.direction as TitleFixDirection, {
      part: true,
      beforeWrite: (at) => dependencies.checkpointFile(state, at),
    }))
    const answer = done.value
    if (answer.ok && answer.written.length) {
      dependencies.notifyCollectionChanged(state, answer.written)
      dependencies.notifyChangedOnDisk(state, answer.written)
    }
    return answer
  })

  // The Undo of either: the step main kept, named by its token; each file goes back only while it holds what the fix wrote.
  ipc.handle('title:undo', async (event, input: { token?: unknown }) => {
    if (typeof input?.token !== 'string' || input.token === '') throw new Error('Invalid title undo.')
    const { state, workspace } = context(event)
    const done = await workspace.withWriteReceipts(() => undoTitleFix(workspace, input.token as string, (at) => dependencies.checkpointFile(state, at)))
    const answer = done.value
    if (answer.ok && answer.restored.length) {
      dependencies.notifyCollectionChanged(state, answer.restored)
      dependencies.notifyChangedOnDisk(state, answer.restored)
    }
    return answer
  })

  // The Plan's choice per part: "Has its own heading" / "No heading in the text" (`heading: none` in the part's
  // frontmatter). The owner's own click, written directly after a checkpoint. Only a part the Plan lists or knows.
  // `locate: true` (the margin card's "No heading in the text") names no folder: the Folio holding the part is found,
  // and the same Plan-membership check below still applies.
  ipc.handle('plan:set-heading-mode', async (event, input: { dir?: string; path?: unknown; mode?: unknown; locate?: unknown; basis?: unknown }) => {
    if (typeof input?.path !== 'string' || (input.mode !== 'own' && input.mode !== 'none')) throw new Error('Invalid heading choice.')
    assertRelativeWorkspacePath(input.path)
    // From the open document's owner route (the margin card on the open part): the version its buffer is
    // based on. The answer then carries this call's receipt, as goal:set's does (save fix, parcel 2a).
    if (input.basis !== undefined && !isSaveBasis(input.basis)) throw new SaveWithoutBasis(input.path)
    const basis = input.basis
    const { state, workspace } = context(event)
    const located = input.locate === true ? await folioContaining(workspace, input.path) : null
    if (input.locate === true && !located) throw new Error('That file is not a part of a Folio.')
    const dir = collectionDir(workspace, located ? { dir: located.dir } : input)
    // A located part is a piece of its Folio by the Folio's own reading (a Folio with no Index Note has no Plan to list it in).
    if (located) {
      if (!located.pieces.includes(input.path)) throw new Error('That file is not a part of this Folio.')
    } else {
      const before = await readPlan(workspace, dir)
      if (!before || ![...before.parts, ...before.unlisted].some((part) => part.path === input.path)) throw new Error('That file is not a part of this Folio outline.')
    }
    const path = input.path
    const mode = input.mode
    let done: Awaited<ReturnType<typeof workspace.withWriteReceipts<string[]>>>
    try {
      done = await workspace.withWriteReceipts(() => setPartHeadingMode(workspace, path, mode, (at) => dependencies.checkpointFile(state, at), basis))
    } catch (error) {
      // The owner route, refused because the part is not the version its buffer is based on: nothing was
      // written, and the answer says what is on disk so the renderer raises its notice for it (as goal:set).
      if (basis === undefined || !(error instanceof PartChangedError)) throw error
      const diskText = error.diskText !== undefined
        ? error.diskText
        : await workspace.readFile(path).then((read) => read.content, () => null)
      return { refused: 'disk-changed' as const, path, diskText, message: new DiskChangedUnderBuffer(path, diskText).message }
    }
    const { value: written, receipts } = done
    dependencies.notifyCollectionChanged(state, written)
    // The owner route reconciles the open buffer from the receipt; the changed-on-disk event is for every other caller.
    if (basis === undefined) dependencies.notifyChangedOnDisk(state, written)
    const plan = await readPlan(workspace, dir)
    if (!plan && !located) throw new Error('The Folio outline could not be read again.')
    if (basis === undefined) return plan
    const receipt = workspace.receiptFor(receipts, path)
    if (!receipt) return { plan }
    const content = await workspace.readFile(path).then((read) => read.content, () => undefined)
    return { plan, written: receipt.written, ...(content !== undefined ? { content } : {}) }
  })
}
