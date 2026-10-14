import { archivePassage, searchArchive } from './scout'
import { classifyOpenPath, parseWriteflexUrl } from './writeflex-url'

type ScoutIpcEvent = { sender: { id: number } }
export type ScoutIpcRegistrar = { handle: (channel: string, handler: (event: ScoutIpcEvent, input: any) => unknown) => void }

export type ScoutIpcDependencies<State> = {
  stateForSender: (id: number) => State
  openFile: (state: State, filePath: string, line?: number) => Promise<void>
}

export type OpenLinkResult = { ok: true } | { ok: false; reason: string }

/**
 * The archive search's IPC (WF-4B). `archive:search` and `archive:passage` hand the renderer typed
 * results from the scout adapter; the renderer never names a binary, a path or an argv.
 * `links:open-writeflex` opens a `writeflex://open?path=…&line=N` link clicked in a draft through the
 * same parser and open funnel as a browser link, so the archive link in a citation lands on its line.
 */
export function registerScoutIpcHandlers<State>(ipc: ScoutIpcRegistrar, dependencies: ScoutIpcDependencies<State>): void {
  ipc.handle('archive:search', (_event, input: unknown) => {
    const request = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    return searchArchive({
      query: typeof request.query === 'string' ? request.query : '',
      scope: typeof request.scope === 'string' ? request.scope as never : undefined,
      limit: typeof request.limit === 'number' ? request.limit : undefined,
    })
  })
  ipc.handle('archive:passage', (_event, passageId: unknown) => archivePassage(typeof passageId === 'string' ? passageId : ''))
  ipc.handle('links:open-writeflex', async (event, rawUrl: unknown): Promise<OpenLinkResult> => {
    if (typeof rawUrl !== 'string') return { ok: false, reason: 'The link is not a valid URL.' }
    const parsed = parseWriteflexUrl(rawUrl)
    if ('error' in parsed) return { ok: false, reason: parsed.error }
    if (classifyOpenPath(parsed.path) !== 'file') return { ok: false, reason: 'The linked piece is not an existing file.' }
    await dependencies.openFile(dependencies.stateForSender(event.sender.id), parsed.path, parsed.line)
    return { ok: true }
  })
}
