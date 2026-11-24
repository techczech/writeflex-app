import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RenameCheckpointAgent, RenameDoorDeps } from '../../src/main/rename-doors'
import { Workspace, type SavedFileResult, type SaveFileOptions } from '../../src/main/workspace'
import { trackScratch } from './scratch-dirs'

type SaveHook = (path: string, content: string, save: (path: string, content: string) => Promise<SavedFileResult>) => Promise<void>

/** A Workspace whose saves can be interrupted by a test, as a failing disk or a concurrent editor would. */
class HookedWorkspace extends Workspace {
  beforeSave: SaveHook | null = null
  override async saveFile(path: string, content: string, options?: SaveFileOptions): Promise<SavedFileResult> {
    const hook = this.beforeSave
    if (hook) await hook(path, content, (other, text) => super.saveFile(other, text))
    return super.saveFile(path, content, options)
  }
}

/**
 * A real temporary vault on disk with a real Workspace, and recording fakes only for the window: the agent's
 * checkpointer, what follows a rename (ledger, Scratchpad, sharing) and the notices sent to the renderer.
 * The agent starts as one that has finished starting, as in a window with a Workspace open.
 */
export async function renameDoorWorld() {
  const root = trackScratch(await mkdtemp(join(tmpdir(), 'wf-rename-doors-')))
  const workspace = new HookedWorkspace(root)
  const checkpoints: string[] = []
  const collectionChanged: string[][] = []
  const changedOnDisk: string[][] = []
  const follows: Array<[kind: 'ledger' | 'scratchpad' | 'sharing', from: string, to: string]> = []
  const forgotten: string[] = []
  let failCheckpoint: ((path: string) => Promise<void>) | null = null
  const recordingAgent: RenameCheckpointAgent = {
    checkpointFile: async (path) => {
      checkpoints.push(path)
      if (failCheckpoint) await failCheckpoint(path)
    },
  }
  let agent: RenameCheckpointAgent | null = recordingAgent
  let agentReady: Promise<RenameCheckpointAgent> | null = Promise.resolve(recordingAgent)
  const deps: RenameDoorDeps = {
    workspace,
    follow: {
      ledger: async (from, to) => { follows.push(['ledger', from, to]) },
      scratchpad: async (from, to) => { follows.push(['scratchpad', from, to]) },
      sharing: (from, to) => { follows.push(['sharing', from, to]) },
    },
    checkpointer: {
      current: () => agent ?? (agentReady ? 'starting' : null),
      ready: async () => agentReady ? agent ?? agentReady : null,
    },
    notify: {
      collectionChanged: (paths) => { collectionChanged.push(paths) },
      changedOnDisk: (paths) => { changedOnDisk.push(paths) },
    },
    forget: (path) => { forgotten.push(path) },
  }
  return {
    root, workspace, deps, checkpoints, collectionChanged, changedOnDisk, follows, forgotten, recordingAgent,
    write: async (rel: string, content: string) => {
      await mkdir(join(root, rel, '..'), { recursive: true })
      await writeFile(join(root, rel), content)
    },
    read: (rel: string) => readFile(join(root, rel), 'utf8'),
    exists: (rel: string) => Bun.file(join(root, rel)).exists(),
    /** Each checkpoint runs this first; throwing from it fails the checkpoint. */
    failCheckpointWith: (hook: ((path: string) => Promise<void>) | null) => { failCheckpoint = hook },
    beforeSave: (hook: SaveHook | null) => { workspace.beforeSave = hook },
    /** The window's agent: started, still starting (a promise), or none. */
    setAgent: (next: RenameCheckpointAgent | Promise<RenameCheckpointAgent> | null) => {
      if (next === null) { agent = null; agentReady = null } else if (next instanceof Promise) { agent = null; agentReady = next } else { agent = next; agentReady = Promise.resolve(next) }
    },
  }
}

export type RenameDoorWorld = Awaited<ReturnType<typeof renameDoorWorld>>
