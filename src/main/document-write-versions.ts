/**
 * Versions kept by a DIRECT document write in a OneDrive Collection: the command line's WriteSession and
 * the app-carried request executor (contract rule 3). The same order as an editor save
 * (replica-save-cycles.ts):
 *
 *  1. LOCAL RECOVERY first, synchronously: the text a write replaces (`before-command`) is written and
 *     fsynced in this variant's application-data folder before the document is replaced; the text it
 *     wrote (`command`) right after the commit. Local disk only: no cloud placeholder is read, no OneDrive
 *     service is asked, nothing waits for sync. A failure throws: before the write it refuses the write
 *     (nothing changed); after it the caller says the write stands but its text is not kept.
 *  2. THE REPLICA STORE in the Collection, asynchronously: each entry becomes an immutable version there
 *     and only then is its recovery file removed. Never awaited by the write itself.
 *
 * Entries are content-addressed (`LocalRecovery.nameFor`): a short-lived command line, a second one
 * running at the same time, and the app (which writes every leftover entry to the store on its next pass,
 * and lists it in Versions until then) never share a name, so no process erases another's unwritten text.
 * A command line also writes the leftovers of earlier commands for the same Collection when it first
 * keeps something, and waits for its own writes to the store for a bounded time before it exits
 * (`settled`); what is left then stays in local recovery.
 */
import { isSyncedLocation } from './sync-location'
import { MAX_REPLICA_BYTES, isVersionedDocumentPath, replicaVersionsFor, sha256Hex, type CaptureInput } from './replica-versions'
import { LocalRecovery, withinGrace, type CommandCause } from './replica-save-cycles'

/** What a direct document write (the command line's WriteSession, an app-carried request) keeps. */
export type DocumentWriteVersions = {
  /** Before an existing document is rewritten: its bytes, durable locally before this resolves.
   *  A failure refuses the write (nothing written). Never waits for the synced store. */
  before: (path: string, bytes: Uint8Array) => Promise<void>
  /** After a document was written: its bytes, durable locally before this resolves. A failure is
   *  reported by the caller as a committed write whose text is not kept. Never waits for the synced store. */
  after: (path: string, written: string | Uint8Array, before: Uint8Array | null) => Promise<void>
  /** Whether every write to the synced store started so far finished within `graceMs`. */
  settled: (graceMs: number) => Promise<boolean>
}

/** How long a command line waits for its writes to the synced store before it exits (they stay in local
 *  recovery otherwise, and the app or the next command writes them). */
export const COMMAND_STORE_GRACE_MS = 2_000

const bytesOf = (value: string | Uint8Array): Buffer => (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value))

/**
 * Replica versions for direct document writes in a synced Collection; null outside one. `recoveryDir`:
 * this variant's local recovery folder (`replicaRecoveryDir(appData)`); every caller names it.
 */
export function documentWriteVersionsFor(root: string, opts: { recoveryDir: string }): DocumentWriteVersions | null {
  if (!isSyncedLocation(root)) return null
  const store = replicaVersionsFor(root)
  const recovery = new LocalRecovery(opts.recoveryDir, store.root)
  const projections = new Set<Promise<void>>()
  const eligible = (path: string, bytes: Uint8Array): boolean => isVersionedDocumentPath(path) && bytes.length <= MAX_REPLICA_BYTES

  const project = (name: string, input: CaptureInput): void => {
    const work = (async () => {
      try {
        await store.capture(input)
        recovery.remove(name)
      } catch { /* Stays in local recovery: the app's next pass, or the next command, writes it. */ }
    })()
    projections.add(work)
    void work.finally(() => projections.delete(work))
  }

  let swept = false
  /** Earlier commands' entries for this Collection (a command line exited before its store write). Only
   *  content-addressed entries: the editor's `.save` file belongs to the app's window. */
  const sweep = (): void => {
    if (swept) return
    swept = true
    for (const entry of recovery.list()) {
      if (entry.kind !== 'before') continue
      project(entry.name, { path: entry.path, bytes: entry.bytes, cause: entry.cause, parents: entry.parents ?? [], dedupe: 'path-hash' })
    }
  }

  const keep = (path: string, bytes: Buffer, cause: CommandCause, parents: string[], dedupe: CaptureInput['dedupe']): void => {
    // Synchronous and fsynced; throws when it cannot be written.
    const name = recovery.write({ kind: 'before', path, cause, ...(parents.length ? { parents } : {}) }, bytes)
    sweep()
    project(name, { path, bytes, cause, parents, dedupe })
  }

  return {
    before: async (path, raw) => {
      const bytes = bytesOf(raw)
      if (eligible(path, bytes)) keep(path, bytes, 'before-command', [], 'path-hash')
    },
    after: async (path, written, before) => {
      const bytes = bytesOf(written)
      if (eligible(path, bytes)) keep(path, bytes, 'command', before ? [sha256Hex(before)] : [], 'latest')
    },
    settled: (graceMs) => withinGrace((async () => { while (projections.size) await Promise.all([...projections]) })(), graceMs),
  }
}

/** For a synced Collection whose caller named no local recovery folder: every keep refuses, so no
 *  document is replaced without its text kept first (a programming error, never a silent skip). */
export function refusingDocumentWriteVersions(root: string): DocumentWriteVersions | null {
  if (!isSyncedLocation(root)) return null
  const refuse = async (): Promise<void> => { throw new Error('no local recovery folder was given for this Collection in OneDrive') }
  return { before: refuse, after: refuse, settled: async () => true }
}
