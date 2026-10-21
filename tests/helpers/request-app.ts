import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { INBOX_DIR, OUTBOX_DIR, newRequestId, type Reply } from '../../src/main/cli/request-format'
import { acquireOwnerLock, releaseOwnerLock, type OwnerLock } from '../../src/main/owner-lock'
import { createReplyKey, readReplyKey, removeReplyKey } from '../../src/main/reply-key'
import { RequestExecutor, type RequestExecutorOptions } from '../../src/main/request-executor'
import { ChangeStore } from '../../src/main/changes'
import { gatedSnapshots } from '../../src/main/gated-snapshots'
import { requestedVersionSave } from '../../src/main/requested-version-save'
import { snapshotVersionOfSavedText } from '../../src/main/saved-text-version'
import type { VersionSnapshotResult } from '../../src/main/agent'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import type { WriteFixture } from './cli-write-fixture'

/**
 * The app's side of a fixture Collection, without a window: the app's owner lock, its one Workspace
 * and a RequestExecutor. The Trash mover is a rename into the fixture's own temporary Trash folder.
 */
export type AppSide = {
  workspace: Workspace
  executor: RequestExecutor
  /** Every `onChanged` call, in order. */
  changed: string[][]
  /** Whether the app holds the Collection; set false to play a lost lock. */
  owns: { value: boolean }
  /** A second executor on the same Collection, as after the app is started again. */
  restarted: (options?: Partial<RequestExecutorOptions>) => RequestExecutor
  /** Answer requests every few milliseconds until the returned function is called. */
  answering: () => () => Promise<void>
  close: () => Promise<void>
}

/**
 * A requested version save as the app wires it (ipc.ts): the window's own version and review stores,
 * and a snapshot taken through the app's snapshot store. `snapshot` is the agent's
 * `snapshotReviewVersion` when a test has a real agent; by default it is the same function over a
 * Bridle SnapshotStore opened on the Collection, behind the write gate, as the agent's is.
 */
export function appVersionSaver(workspace: Workspace, snapshot?: (path: string) => Promise<VersionSnapshotResult>): NonNullable<RequestExecutorOptions['saveVersion']> {
  return requestedVersionSave({
    workspace, versions: new VersionStore(workspace), changes: new ChangeStore(workspace), live: () => true,
    author: async () => ({ name: 'App Writer' }),
    agent: async () => ({
      workspace,
      snapshotReviewVersion: snapshot ?? (async (path) => {
        const { SnapshotStore } = await import('@bridle/core')
        const snapshots = gatedSnapshots(workspace.root, await SnapshotStore.open({ dir: join(workspace.root, '.bridle') }))
        return snapshotVersionOfSavedText({ workspace, snapshots, sessionId: 'app-session', path })
      }),
    }),
  })
}

export async function openAsApp(fx: WriteFixture, options: Partial<RequestExecutorOptions> = {}): Promise<AppSide> {
  const lock: OwnerLock = await acquireOwnerLock(fx.root, { kind: 'app' })
  // As CollectionOwnership does when the app takes a Collection: a fresh reply key, outside the Collection.
  await createReplyKey(fx.keys, fx.root)
  const workspace = new Workspace(fx.root)
  const changed: string[][] = []
  const owns = { value: true }
  const make = (extra: Partial<RequestExecutorOptions> = {}): RequestExecutor => new RequestExecutor({
    workspace, ownsCollection: () => owns.value, appData: fx.appData,
    replyKey: () => readReplyKey(fx.keys, fx.root),
    trash: async (absolute) => { await rename(absolute, join(fx.trashed, basename(absolute))) },
    onChanged: (paths) => { changed.push(paths) },
    saveVersion: appVersionSaver(workspace),
    // As the app wires it (ipc.ts), without a scrap store: each request is one turn of the Collection's write turn.
    exclusive: (work) => workspace.exclusiveAll(work),
    ...options, ...extra,
  })
  const executor = make()
  return {
    workspace, executor, changed, owns, restarted: make,
    answering: () => {
      let stopped = false
      const loop = (async () => {
        while (!stopped) {
          await executor.drain()
          await new Promise((done) => { setTimeout(done, 5) })
        }
      })()
      return async () => { stopped = true; await loop }
    },
    close: async () => {
      await removeReplyKey(fx.keys, fx.root)
      await releaseOwnerLock(lock)
    },
  }
}

/** Put a request file in the inbox as a program other than the command line might: any text, any name. */
export async function plantRequest(fx: WriteFixture, operation: string, args: Record<string, unknown>, extra: { id?: string; body?: unknown; text?: string | Uint8Array; name?: string } = {}): Promise<string> {
  const id = extra.id ?? newRequestId()
  await mkdir(join(fx.root, INBOX_DIR), { recursive: true })
  const text = extra.text ?? `${JSON.stringify(extra.body ?? { version: 1, id, operation, args })}\n`
  await writeFile(join(fx.root, INBOX_DIR, extra.name ?? `${id}.json`), text)
  return id
}

export const inboxNames = async (fx: WriteFixture): Promise<string[]> => (existsSync(join(fx.root, INBOX_DIR)) ? (await readdir(join(fx.root, INBOX_DIR))).sort() : [])
export const outboxNames = async (fx: WriteFixture): Promise<string[]> => (existsSync(join(fx.root, OUTBOX_DIR)) ? (await readdir(join(fx.root, OUTBOX_DIR))).sort() : [])
export const replyTo = async (fx: WriteFixture, id: string): Promise<Reply> => JSON.parse(await readFile(join(fx.root, OUTBOX_DIR, `${id}.json`), 'utf8')) as Reply

/** The documents and the app's stores, without the request folders and the lock. (The journal and the app's records are not in the Collection.) */
export async function content(fx: WriteFixture): Promise<Record<string, string>> {
  const all = await fx.snapshot()
  return Object.fromEntries(Object.entries(all).filter(([path]) => !/^\.writeflex\/(inbox|outbox)\//.test(path)))
}
