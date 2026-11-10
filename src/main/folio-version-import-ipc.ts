/**
 * The doors for importing a co-author's Word revision, steps 1 and 2 (Folio versions ticket 14). Electron-free: the file dialog and the
 * stores are the app's, passed in, so a test drives the same handlers without a window.
 *
 * The renderer NEVER names a file. `folio-versions:import-choose` asks the system dialog (under the e2e fence, the environment) and main
 * keeps the chosen path for that window; every later call reads that file again in main, from the disk, through the bounded reader
 * (`readRevisionFile`). The Folio folder, the name, the base, every decision and the file's hash are checked here (folio-version-import.ts
 * checks them again where they are used). Only `folio-versions:import-commit` writes, and only when the writer pressed "Bring changes
 * into the Folio": the other doors read.
 */
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { readRevisionFile, importBases, prepareImport, commitImport, type ImportDeps } from './folio-version-import'
import { collectionDir } from './plan-ipc'
import type { Workspace } from './workspace'
import type { ImportBases, ImportChooseAnswer, ImportCommitAnswer, ImportPrepareAnswer, ImportRefused, ImportRequest } from '../shared/folio-version-import'

type ImportIpcEvent = { sender: { id: number } }
export type FolioVersionImportIpcRegistrar = { handle: (channel: string, handler: (event: ImportIpcEvent, input: any) => unknown) => void }

export type FolioVersionImportIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  /** Ask which Word file (the system open dialog); null when the writer cancelled. */
  chooseFile: (event: ImportIpcEvent) => Promise<string | null>
  /** The stores the import runs over for this window's Collection, bound to this window (the safety version is saved through them). */
  deps: (event: ImportIpcEvent, workspace: Workspace) => Promise<ImportDeps>
  /** Told the Folio journal changed (an incoming version was written), so the lists read again. */
  versionsChanged: (event: ImportIpcEvent) => void
}

const refused = (message: string): ImportRefused => ({ status: 'refused', code: 'bad-request', message, nothingWritten: true })
const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The request as main accepts it, or the refusal. Nothing the renderer sent is trusted: a folder, a name, an id, a decision. */
export function parseImportRequest(workspace: Pick<Workspace, 'root'>, input: unknown): ImportRequest | ImportRefused {
  const request = (input ?? {}) as Record<string, unknown>
  let folder: string | null = null
  if (typeof request.dir === 'string' && !request.dir.includes('\\') && !request.dir.includes('\u0000')) { try { folder = collectionDir(workspace as Workspace, { dir: request.dir }) } catch { folder = null } }
  if (folder === null) return { status: 'refused', code: 'not-a-folio', message: 'That is not a Folio folder, so nothing was imported.', nothingWritten: true }
  if (typeof request.from !== 'string') return { status: 'refused', code: 'bad-name', message: 'Say who the revision is from. Nothing was imported.', nothingWritten: true }
  if (request.base !== undefined && (typeof request.base !== 'string' || request.base.length > 200)) return refused('That request was not understood, so nothing was imported.')
  if (request.fileSha256 !== undefined && typeof request.fileSha256 !== 'string') return refused('That request was not understood, so nothing was imported.')
  return {
    dir: folder, from: request.from,
    ...(typeof request.fileSha256 === 'string' ? { fileSha256: request.fileSha256 } : {}),
    ...(typeof request.base === 'string' ? { base: request.base } : {}),
    ...(request.resolutions !== undefined ? { resolutions: request.resolutions as ImportRequest['resolutions'] } : {}),
  }
}

export function registerFolioVersionImportIpc<State>(ipc: FolioVersionImportIpcRegistrar, dependencies: FolioVersionImportIpcDependencies<State>): void {
  const workspaceOf = (event: ImportIpcEvent): Workspace => dependencies.requireWorkspace(dependencies.stateForSender(event.sender.id))
  /** The file each window chose, kept in main. The renderer holds only its name and size. */
  const chosen = new Map<number, string>()

  ipc.handle('folio-versions:import-choose', async (event): Promise<ImportChooseAnswer> => {
    workspaceOf(event)
    try {
      const path = await dependencies.chooseFile(event)
      if (path === null) return { status: 'cancelled' }
      const info = await stat(path)
      if (!info.isFile()) return { status: 'error', message: 'That is not an ordinary file, so it cannot be a Word file.' }
      chosen.set(event.sender.id, path)
      return { status: 'chosen', name: basename(path), bytes: info.size }
    } catch (error) {
      return { status: 'error', message: `WriteFlex could not open that file. ${sentence(error)}` }
    }
  })

  ipc.handle('folio-versions:import-forget', (event): boolean => chosen.delete(event.sender.id))

  ipc.handle('folio-versions:import-bases', async (event, input: unknown): Promise<ImportBases | ImportRefused> => {
    const workspace = workspaceOf(event)
    const request = parseImportRequest(workspace, input)
    if ('status' in request) return request
    try {
      return await importBases(await dependencies.deps(event, workspace), request)
    } catch (error) {
      return refused(`WriteFlex could not read this Folio’s versions, so nothing was imported. ${sentence(error)}`)
    }
  })

  ipc.handle('folio-versions:import-prepare', async (event, input: unknown): Promise<ImportPrepareAnswer> => {
    const workspace = workspaceOf(event)
    const request = parseImportRequest(workspace, input)
    if ('status' in request) return request
    const path = chosen.get(event.sender.id)
    if (path === undefined) return refused('Choose the Word file first.')
    try {
      const file = await readRevisionFile(path)
      if ('refused' in file) return file.refused
      return await prepareImport(await dependencies.deps(event, workspace), request, file)
    } catch (error) {
      return refused(`WriteFlex could not read that file, so nothing was imported. ${sentence(error)}`)
    }
  })

  ipc.handle('folio-versions:import-commit', async (event, input: unknown): Promise<ImportCommitAnswer> => {
    const workspace = workspaceOf(event)
    const request = parseImportRequest(workspace, input)
    if ('status' in request) return request
    const path = chosen.get(event.sender.id)
    if (path === undefined) return refused('Choose the Word file first.')
    const fileSha256 = (input as { fileSha256?: unknown } | null)?.fileSha256
    if (typeof fileSha256 !== 'string') return refused('That request was not understood, so nothing was imported.')
    try {
      // The window's binding is captured here, before the file is read: every write the import makes asks whether it still holds.
      const deps = await dependencies.deps(event, workspace)
      const file = await readRevisionFile(path)
      if ('refused' in file) return file.refused
      const answer = await commitImport(deps, { ...request, fileSha256 }, file)
      // An incoming version was written (or the safety version stands after a failure): the lists read again either way.
      if (answer.status === 'done' || !answer.nothingWritten) dependencies.versionsChanged(event)
      if (answer.status === 'done') chosen.delete(event.sender.id)
      return answer
    } catch (error) {
      dependencies.versionsChanged(event)
      return { status: 'refused', code: 'not-recorded', message: `Something went wrong, and WriteFlex cannot say what was written. Check the Versions list. ${sentence(error)}`, nothingWritten: false }
    }
  })
}
