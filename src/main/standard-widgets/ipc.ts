/**
 * The renderer's way to the standard-widget operations (ticket 04a): create and insert, update a recipe, build,
 * undo; and for the workbench a preview that writes nothing and the list of CSV and JSON files a widget may read. The renderer names workspace paths and recipe settings; main resolves, reads and writes. No channel
 * reads or writes a file the renderer names directly, and none accepts a path outside the window's workspace.
 *
 * Files from outside the Workspace (ticket 04c): `standard-widget:pick-source` opens the native picker in main. An
 * outside file is answered with an opaque token (outside-files.ts `PickDesk`), good only for this window, Workspace
 * and document; create, update and preview take `pick: { token, inclusion }` and main turns the token back into
 * the file it holds. No channel takes a path outside the Workspace, and none writes, edits or removes a sync grant
 * on its own: only the step that brings a picked file in writes one.
 */
import type { WidgetIpcRegistrar } from '../widget-ipc'
import type { Workspace } from '../workspace'
import { buildStandardWidgetNow, createStandardWidget, previewStandardWidgetDraft, StandardWidgetUndoDesk, updateStandardWidgetRecipe, type SourceEdit, type WidgetPosition } from './operations'
import { listStandardWidgetSources } from './source-files'
import { readOwnFolderFacts } from './own-folder'
import { cleanUpLeftoverStep, forgetLeftoverStep, readLeftoverSteps } from './step-journal'
import type { OwnFolderChoice } from '../../shared/own-folder-plan'
import type { RecipeMap, RecipeValue } from './recipe'
import { PickDesk, pickStandardWidgetSource, type Inclusion, type OutsidePick, type PickDialog } from './outside-files'

type IpcEvent = { sender: { id: number } }
export type StandardWidgetIpcDeps = {
  workspaceFor: (event: IpcEvent) => Workspace
  /** Tell the window which files changed on disk (to reload buffers and listings). */
  notifyChanged: (event: IpcEvent, paths: string[]) => void
  /** Files a step moved (from → to), or an undo moved back: the window's records that follow a rename follow them. */
  followMoves?: (event: IpcEvent, moves: Array<{ from: string; to: string }>) => Promise<void>
  /** The native file picker (Electron's dialog in the app). Without it Choose file… answers that it cannot pick. */
  pickDialog?: (event: IpcEvent) => PickDialog
}

const PATH_MAX = 4096
const TEXT_MAX = 1024 * 1024

function text(input: unknown, key: string, max = PATH_MAX): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error(`Invalid widget request: ${key} is missing.`)
  return value
}
function optionalText(input: unknown, key: string, max = PATH_MAX): string | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  return value === undefined ? undefined : text(input, key, max)
}

/** A recipe value as plain data only: strings, whole numbers, lists of them, maps three deep. */
function recipeValue(value: unknown, depth: number): RecipeValue {
  if (typeof value === 'string' && value.length <= PATH_MAX && !value.includes('\0')) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (Array.isArray(value) && value.length <= 500) return value.map((item) => recipeValue(item, depth + 1))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype && depth < 4) {
    const entries = Object.entries(value)
    if (entries.length > 200) throw new Error('Invalid widget request: too many settings.')
    return Object.fromEntries(entries.map(([key, inner]) => [key, recipeValue(inner, depth + 1)]))
  }
  throw new Error('Invalid widget request: a setting is not plain data.')
}
function recipeMap(input: unknown, key: string): RecipeMap {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  const map = recipeValue(value, 0)
  if (typeof map !== 'object' || Array.isArray(map)) throw new Error(`Invalid widget request: ${key} is missing.`)
  return map
}
function patchOf(input: unknown): Record<string, RecipeValue | null> {
  const value = (input as Record<string, unknown> | null | undefined)?.patch
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid widget request: patch is missing.')
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, inner === null ? null : recipeValue(inner, 1)]))
}
function positionOf(input: unknown): WidgetPosition | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.position
  if (value === undefined || value === 'start' || value === 'end') return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 1) {
    const line = (value as { line?: unknown }).line
    if (typeof line === 'number' && Number.isSafeInteger(line) && line >= 1) return { line }
  }
  throw new Error('Invalid widget request: position is not start, end, a widget number or a line.')
}
function sourceEditOf(input: unknown): SourceEdit | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.sourceEdit
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid widget request: sourceEdit is not text and its basis.')
  const edit = value as Record<string, unknown>
  if (typeof edit.text !== 'string' || typeof edit.basis !== 'string' || edit.text.length > TEXT_MAX * 8 || edit.basis.length > TEXT_MAX * 8) throw new Error('Invalid widget request: sourceEdit is not text and its basis.')
  return { text: edit.text, basis: edit.basis }
}

/** The own-folder sheet's answer: names only (each a file name, no separators), plain data. */
function placementOf(input: unknown): OwnFolderChoice | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.placement
  if (value === undefined) return undefined
  const bad = (): never => { throw new Error('Invalid widget request: placement is not the folder sheet\'s answer.') }
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return bad()
  const choice = value as Record<string, unknown>
  const names = (list: unknown): string[] => {
    if (!Array.isArray(list) || list.length > 1000) return bad()
    return list.map((name) => (typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\0]/.test(name) && name !== '.' && name !== '..' ? name : bad()))
  }
  if (choice.mode !== 'one' && choice.mode !== 'several') return bad()
  if (choice.dataFile !== 'copy' && choice.dataFile !== 'move') return bad()
  if (typeof choice.name !== 'string' || choice.name.length > 255) return bad()
  if (choice.fingerprint !== undefined && (typeof choice.fingerprint !== 'string' || !/^[0-9a-f-]{1,64}$/.test(choice.fingerprint))) return bad()
  return { mode: choice.mode, checked: names(choice.checked), order: names(choice.order), name: choice.name as string, dataFile: choice.dataFile, ...(typeof choice.fingerprint === 'string' ? { fingerprint: choice.fingerprint } : {}) }
}

/** `pick: { token, inclusion? }` as plain data, or undefined. Only the token's shape is checked here. */
function pickOf(input: unknown, needInclusion: boolean): { token: string; inclusion: Inclusion } | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.pick
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid widget request: pick is not a token and a choice.')
  const pick = value as Record<string, unknown>
  if (typeof pick.token !== 'string' || !/^[0-9a-f]{32}$/.test(pick.token)) throw new Error('Invalid widget request: pick is not a token and a choice.')
  if (needInclusion && pick.inclusion !== 'copy' && pick.inclusion !== 'sync') throw new Error('Invalid widget request: choose Copy or Keep in sync.')
  return { token: pick.token, inclusion: pick.inclusion === 'sync' ? 'sync' : 'copy' }
}

/** A fresh answer each time (never one shared object a caller could change). */
const pickGone = () => ({ ok: false as const, errors: [], message: 'The chosen file is no longer held. Choose it again; nothing was written.' })

export function registerStandardWidgetHandlers(ipc: WidgetIpcRegistrar, deps: StandardWidgetIpcDeps, desk = new StandardWidgetUndoDesk(), picks = new PickDesk()): void {
  /** The file behind a pick token, for this window, Workspace and document only (a preview: left held). */
  const heldPick = (event: IpcEvent, token: string, documentPath: string): OutsidePick | null => picks.get(token, event.sender.id, deps.workspaceFor(event).root, documentPath)
  /** The same, taken out of the desk in this tick, before any await: one token makes at most one step. Handed back
   *  only when the step refused with nothing left written. */
  const takePick = (event: IpcEvent, token: string, documentPath: string) => picks.take(token, event.sender.id, deps.workspaceFor(event).root, documentPath)
  const settle = (taken: { handBack: () => void } | null, result: { ok: boolean; nothingLeft?: boolean }): void => {
    if (taken && !result.ok && result.nothingLeft !== false) taken.handBack()
  }
  // The native picker, in main. An outside file comes back as a token, never as a path.
  ipc.handle('standard-widget:pick-source', async (event, input) => {
    if (!deps.pickDialog) return { ok: false, message: 'Choosing a file is not available here.' }
    return pickStandardWidgetSource(deps.workspaceFor(event), picks, event.sender.id, text(input, 'documentPath'), deps.pickDialog(event))
  })
  ipc.handle('standard-widget:create', async (event, input) => {
    // The whole request is checked first: a malformed one throws here, before the pick is taken.
    const documentPath = text(input, 'documentPath')
    const pick = pickOf(input, true)
    const request = {
      documentPath,
      name: text(input, 'name', 200),
      recipe: recipeMap(input, 'recipe'),
      sourceFile: optionalText(input, 'sourceFile'),
      position: positionOf(input),
      documentBasis: optionalText(input, 'documentBasis', TEXT_MAX),
      sourceEdit: sourceEditOf(input),
      placement: placementOf(input),
    }
    const ws = deps.workspaceFor(event)
    // Then the pick, taken in this tick before any await.
    const taken = pick ? takePick(event, pick.token, documentPath) : null
    const held = taken?.pick ?? null
    if (pick && !held) return pickGone()
    const result = await createStandardWidget(ws, desk, { ...request, ...(pick && held ? { outside: { pick: held, inclusion: pick.inclusion } } : {}) })
    settle(taken, result)
    if (result.ok && result.moved.length > 0) await deps.followMoves?.(event, result.moved)
    if (result.ok) deps.notifyChanged(event, result.written)
    return result
  })
  // Read-only: what is in the document's folder, for the own-folder sheet.
  ipc.handle('standard-widget:own-folder-facts', async (event, input) => readOwnFolderFacts(deps.workspaceFor(event), {
    documentPath: text(input, 'documentPath'),
    sourceFile: optionalText(input, 'sourceFile'),
    name: text(input, 'name', 200),
    title: optionalText(input, 'title', 200),
  }))
  // A widget step that moved documents and was stopped by a crash or a quit: read only, for the launch notice.
  ipc.handle('standard-widget:leftover-steps', async (event) => readLeftoverSteps(deps.workspaceFor(event)))
  // The notice's Clean up: the step's own guarded put-back; never anything the step did not make.
  ipc.handle('standard-widget:clean-up-step', async (event, input) => {
    const result = await cleanUpLeftoverStep(deps.workspaceFor(event), text(input, 'id', 100))
    if (result.restored.length) deps.notifyChanged(event, result.restored)
    return result
  })
  // The notice of a step past its commit point, read: its journal is put away; nothing on disk changes.
  ipc.handle('standard-widget:forget-step', async (event, input) => forgetLeftoverStep(deps.workspaceFor(event), text(input, 'id', 100)))
  ipc.handle('standard-widget:update-recipe', async (event, input) => {
    // The whole request is checked first: a malformed one throws here, before the pick is taken.
    const pick = pickOf(input, true)
    const documentPath = pick ? text(input, 'documentPath') : ''
    const request = { recipePath: text(input, 'recipePath'), patch: patchOf(input), basis: optionalText(input, 'basis', TEXT_MAX), sourceEdit: sourceEditOf(input) }
    const ws = deps.workspaceFor(event)
    // Then the pick, taken in this tick before any await.
    const taken = pick ? takePick(event, pick.token, documentPath) : null
    const held = taken?.pick ?? null
    if (pick && !held) return pickGone()
    const result = await updateStandardWidgetRecipe(ws, desk, { ...request, ...(pick && held ? { outside: { pick: held, inclusion: pick.inclusion } } : {}) })
    settle(taken, result)
    if (result.ok) deps.notifyChanged(event, result.written)
    return result
  })
  ipc.handle('standard-widget:build', async (event, input) => {
    const outcome = await buildStandardWidgetNow(deps.workspaceFor(event), text(input, 'recipePath'))
    if (outcome.written.length) deps.notifyChanged(event, outcome.written)
    return outcome
  })
  // Read-only: nothing is written, so nothing is announced.
  ipc.handle('standard-widget:preview', async (event, input) => {
    const sourceText = (input as Record<string, unknown> | null | undefined)?.sourceText
    if (sourceText !== undefined && (typeof sourceText !== 'string' || sourceText.length > TEXT_MAX * 8)) throw new Error('Invalid widget request: sourceText is not text.')
    const documentPath = text(input, 'documentPath')
    const pick = pickOf(input, false)
    const held = pick ? heldPick(event, pick.token, documentPath) : null
    if (pick && !held) return pickGone()
    return previewStandardWidgetDraft(deps.workspaceFor(event), {
      documentPath,
      recipe: recipeMap(input, 'recipe'),
      ...(held ? { outside: held } : { sourceFile: text(input, 'sourceFile'), sourceText: sourceText as string | undefined }),
      recipePath: optionalText(input, 'recipePath'),
      name: optionalText(input, 'name', 200),
    })
  })
  ipc.handle('standard-widget:list-sources', async (event, input) => listStandardWidgetSources(deps.workspaceFor(event), text(input, 'documentPath')))
  ipc.handle('standard-widget:undo', async (event, input) => {
    const result = await desk.undo(deps.workspaceFor(event), text(input, 'undoId', 100))
    if (result.ok && result.movedBack.length > 0) await deps.followMoves?.(event, result.movedBack)
    if (result.ok) deps.notifyChanged(event, result.restored)
    return result
  })
}
