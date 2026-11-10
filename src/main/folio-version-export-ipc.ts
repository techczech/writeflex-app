/**
 * The doors for exporting a saved Folio version and marking it as sent (Folio versions ticket 11). Electron-free: the save dialog and
 * the window are the app's, passed in, so a test drives the same handlers without a window.
 *
 * `folio-versions:export` is the whole export in main: it reads the version through the shared reader, asks the app for the target
 * (the system save dialog; the renderer never names a file), writes the one file, and only then marks the version as sent if the
 * writer asked. A refused or failed export writes no mark. The Folio folder, the version id, the format, the HTML options and the
 * name are all checked here; a renderer-supplied id is only ever looked up among this Folio's own versions.
 * `folio-versions:mark-sent` is the standalone Mark as sent… (nothing is exported).
 */
import { isExportFormat, type ExportFormat } from './export'
import { htmlOptions } from './export-ipc'
import { FolioVersionExportRefused, openVersionForExport } from './folio-version-export'
import { FolioMarkRefused, markFolioVersionSent } from './folio-version-mark-sent'
import { FolioVersionStore } from './folio-versions'
import { defaultReaderSources } from './folio-version-sources'
import type { VersionReaderSources } from './folio-version-reader'
import { collectionDir } from './plan-ipc'
import type { Workspace } from './workspace'
import { isFolioVersionId } from '../shared/folio-version-records'
import { sentToProblem, normaliseSentTo, type FolioVersionExportAnswer, type FolioVersionExportRequest, type FolioVersionMarkAnswer } from '../shared/folio-version-export'

type ExportIpcEvent = { sender: { id: number } }
export type FolioVersionExportIpcRegistrar = { handle: (channel: string, handler: (event: ExportIpcEvent, input: any) => unknown) => void }

export type FolioVersionExportIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  /** Ask where the file goes (the system save dialog); null when the writer cancelled. `name` is the suggested file name. */
  chooseTarget: (event: ExportIpcEvent, name: string, format: ExportFormat) => Promise<string | null>
  /** Told the file that was written, so "Show in Finder" can reveal it. */
  exported: (event: ExportIpcEvent, target: string) => void
  /** Told the Folio journal changed (a mark was written), so the lists read again. */
  versionsChanged: (event: ExportIpcEvent) => void
  /** Test seam: the reader's sources. Default: this Collection's own. */
  readerSources?: (workspace: Workspace) => VersionReaderSources
}

/** The request as main accepts it, or the sentence why not. Nothing the renderer sent is trusted: a folder, an id, a format, options, a name. */
export function parseFolioVersionExportRequest(workspace: Pick<Workspace, 'root'>, input: unknown): FolioVersionExportRequest | { refused: string } {
  const request = (input ?? {}) as Record<string, unknown>
  const dir = typeof request.dir === 'string' && !request.dir.includes('\\') && !request.dir.includes('\u0000') ? request.dir : null
  let folder: string | null = null
  if (dir !== null) { try { folder = collectionDir(workspace as Workspace, { dir }) } catch { folder = null } }
  if (folder === null) return { refused: 'That is not a Folio folder, so nothing was exported.' }
  if (!isFolioVersionId(request.id)) return { refused: 'That is not a Folio version, so nothing was exported.' }
  const format = isExportFormat(request.format) ? request.format : null
  if (format === null) return { refused: `“${String(request.format)}” is not an export format. Choose HTML or Word.` }
  let html: ReturnType<typeof htmlOptions>
  try { html = htmlOptions(request.html) } catch (error) { return { refused: error instanceof Error ? error.message : 'Invalid HTML export options.' } }
  let markSentTo: string | undefined
  if (request.markSentTo !== undefined) {
    const problem = sentToProblem(request.markSentTo)
    if (problem !== null) return { refused: `${problem} Nothing was exported.` }
    markSentTo = normaliseSentTo(request.markSentTo)
  }
  return { dir: folder, id: request.id, format, ...(html ? { html } : {}), ...(markSentTo !== undefined ? { markSentTo } : {}) }
}

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function registerFolioVersionExportIpc<State>(ipc: FolioVersionExportIpcRegistrar, dependencies: FolioVersionExportIpcDependencies<State>): void {
  const workspaceOf = (event: ExportIpcEvent): Workspace => dependencies.requireWorkspace(dependencies.stateForSender(event.sender.id))
  const readerFor = dependencies.readerSources ?? defaultReaderSources

  ipc.handle('folio-versions:export', async (event, input: unknown): Promise<FolioVersionExportAnswer> => {
    const workspace = workspaceOf(event)
    const request = parseFolioVersionExportRequest(workspace, input)
    if ('refused' in request) return { status: 'error', message: request.refused }
    const sources = readerFor(workspace)
    let opened
    try { opened = await openVersionForExport(sources, request.dir, request.id) } catch (error) {
      return { status: 'error', message: error instanceof FolioVersionExportRefused ? error.message : `WriteFlex could not read that Folio version, so nothing was exported. ${sentence(error)}` }
    }
    try {
      const target = await dependencies.chooseTarget(event, await opened.suggestedName(request.format), request.format)
      if (target === null) return { status: 'cancelled' }
      const outcome = await opened.export(request.format, target, request.html)
      dependencies.exported(event, target)
      // The mark comes after the file: a failed export writes none. A mark that cannot be written never undoes the file.
      let sentTo: string | undefined
      let markRefused: string | undefined
      if (request.markSentTo !== undefined) {
        try {
          sentTo = (await markFolioVersionSent(sources, new FolioVersionStore(workspace), request.dir, request.id, request.markSentTo)).sentTo
          dependencies.versionsChanged(event)
        } catch (error) { markRefused = sentence(error) }
      }
      return {
        status: 'done', target: outcome.target, format: outcome.format, pieces: outcome.pieces, listed: outcome.listed,
        missingImages: outcome.missingImages, unreadableImages: outcome.unreadableImages,
        ...(sentTo !== undefined ? { sentTo } : {}), ...(markRefused !== undefined ? { markRefused } : {}),
      }
    } catch (error) {
      return { status: 'error', message: sentence(error) }
    } finally {
      await opened.close()
    }
  })

  ipc.handle('folio-versions:mark-sent', async (event, input: unknown): Promise<FolioVersionMarkAnswer> => {
    const workspace = workspaceOf(event)
    const request = (input ?? {}) as Record<string, unknown>
    let folder: string | null = null
    if (typeof request.dir === 'string' && !request.dir.includes('\\') && !request.dir.includes('\u0000')) { try { folder = collectionDir(workspace, { dir: request.dir }) } catch { folder = null } }
    if (folder === null) return { status: 'error', message: 'That is not a Folio folder, so nothing was marked.' }
    if (!isFolioVersionId(request.id)) return { status: 'error', message: 'That is not a Folio version, so nothing was marked.' }
    try {
      const marked = await markFolioVersionSent(readerFor(workspace), new FolioVersionStore(workspace), folder, request.id, request.to as string)
      dependencies.versionsChanged(event)
      return { status: 'done', sentTo: marked.sentTo ?? '' }
    } catch (error) {
      return { status: 'error', message: error instanceof FolioMarkRefused ? error.message : `WriteFlex could not mark that version. ${sentence(error)}` }
    }
  })
}
