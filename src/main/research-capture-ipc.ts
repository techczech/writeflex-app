import { captureInWorkspace, type WorkspaceCaptureInput } from './research-capture'
import type { Workspace } from './workspace'
import { CAPTURE_KINDS, type CaptureKind, type CaptureResponse } from '../shared/research-capture'

type CaptureIpcEvent = { sender: { id: number } }
export type CaptureIpcRegistrar = { handle: (channel: string, handler: (event: CaptureIpcEvent, input: any) => unknown) => void }

export type CaptureIpcDependencies<State> = {
  requireWorkspace: (state: State) => Workspace
  stateForSender: (id: number) => State
  /** A file was filed under a research folder: tell the window so lists and the tree follow. */
  filed: (state: State, path: string) => void
}

/**
 * `research:capture` — the "Capture to research…" sheet's call. The renderer names a Piece and the text;
 * it never names a binary, an argv or an absolute path. Everything else is main/research-capture.ts.
 */
export function registerResearchCaptureIpc<State>(ipc: CaptureIpcRegistrar, dependencies: CaptureIpcDependencies<State>): void {
  ipc.handle('research:capture', async (event, raw: unknown): Promise<CaptureResponse> => {
    const request = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const kind = CAPTURE_KINDS.find((candidate) => candidate === request.kind) as CaptureKind | undefined
    if (typeof request.project !== 'string' || typeof request.title !== 'string' || typeof request.body !== 'string' || !kind) {
      return { ok: false, code: 'invalid', message: 'The capture was not complete, so nothing was captured.' }
    }
    const state = dependencies.stateForSender(event.sender.id)
    const input: WorkspaceCaptureInput = {
      project: request.project, title: request.title, kind, body: request.body,
      ...(typeof request.prompt === 'string' && request.prompt.trim() !== '' ? { prompt: request.prompt } : {}),
    }
    const result = await captureInWorkspace(dependencies.requireWorkspace(state), input)
    if (!result.ok) return { ok: false, code: result.code, message: result.message }
    dependencies.filed(state, result.file)
    return { ok: true, file: result.file, project: result.project, corpus: result.corpus, indexed: result.indexed }
  })
}
