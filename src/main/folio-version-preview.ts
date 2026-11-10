/**
 * What a Folio version would hold, read once and read the same way by the Save Folio version sheet
 * (folio-version-sheet.ts) and by the save itself (folio-version-save.ts), so the sheet cannot promise a
 * version the save would not make (Folio versions ticket 04, review items 2 and 4).
 *
 * Three things live here because both sides must agree on them:
 *  - the size cap for an inserted file and the rule for what the cap does (`insertedFileHandling`): the
 *    save keeps a frozen copy of a file at or under the cap and only notes one over it (a `reference`
 *    member, why `too-large`); the sheet says the same;
 *  - the read of every file's facts (`previewFolio`): words, the writer's own waiting changes, an agent's,
 *    each inserted file's size, bytes and the per-file version that already holds them;
 *  - a fingerprint of that read. The sheet hands it out with its facts and the go-ahead returns it; the
 *    save computes it again under the Folio's lock, and if it differs it writes nothing and says so.
 *
 * READ ONLY: it writes nothing and takes no lock. Electron-free.
 */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { documentWordCount } from './collection'
import type { Change, ChangeStore } from './changes'
import { changesAVersionWouldSettle } from './saved-text-version'
import type { FolioFileRef, GatheredFolio } from './folio-version-members'
import type { Version, VersionStore } from './versions'
import type { Workspace } from './workspace'

/** An inserted file above this is a `reference` member (ADR-0052 § How members reference per-file versions). A tunable constant, not an owner question. */
export const FOLIO_INSERTED_FILE_CAP_BYTES = 25 * 1024 * 1024

/** What the save does with an inserted file of this size: `kept` (a per-file version, a frozen copy) or `too-large` (noted by its sha256, not kept). */
export type InsertedHandling = 'kept' | 'too-large'
export const insertedFileHandling = (bytes: number, cap: number = FOLIO_INSERTED_FILE_CAP_BYTES): InsertedHandling => (bytes > cap ? 'too-large' : 'kept')

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** An agent's pending proposal or held pair: left pending, and left out of the saved text. The same rule the save lists them by. */
export const agentWaitingKind = (change: Change): 'pending' | 'held' | null => {
  if (change.snapshotId) return null
  if (change.status === 'held') return 'held'
  if (change.status === 'pending' && change.provenance !== 'writer' && change.editClass !== 'copy') return 'pending'
  return null
}

export type PreviewStores = {
  workspace: Workspace
  versions: Pick<VersionStore, 'list'>
  changes: Pick<ChangeStore, 'list'>
  snapshotHash: (snapshotId: string) => Promise<string | null>
  readBytes: (path: string) => Promise<Buffer>
}

export type PreviewText = {
  kind: 'text'
  role: 'index' | 'part' | 'unlisted'
  path: string
  title?: string
  order?: number
  /** Words by the Digest's rule (front matter excluded); null when the file could not be read. */
  words: number | null
  /** Ids of the writer's own waiting changes: a go-ahead settles these. */
  ownIds: string[]
  /** Ids of an agent's pending proposals and held pairs: left out. */
  agentIds: string[]
}
export type PreviewInserted = {
  kind: 'inserted'
  path: string
  /** Absent: nothing ordinary stands at that name (the save lists it as not saved). */
  present: boolean
  bytes: number
  handling: InsertedHandling
  /** The sha256 of the bytes as they stand; null for a file over the cap (not read in full here) or one that is not there. */
  hash: string | null
  /** The per-file version that already holds these bytes, if there is one. */
  version: { id: string; number: number; name: string } | null
}
export type PreviewLinked = { kind: 'linked'; path: string }
export type PreviewEntry = PreviewText | PreviewInserted | PreviewLinked

export type FolioPreview = {
  entries: PreviewEntry[]
  /** Parts of the running order with no file yet. */
  planned: string[]
  /** One value for everything above: the sheet hands it out, the go-ahead returns it, the save compares it under the lock. */
  fingerprint: string
}

/** Read the files `gathered` names and say what a save would do with each. `cap` is the inserted-file cap (default 25 MiB). */
export async function previewFolio(stores: PreviewStores, gathered: GatheredFolio, cap: number = FOLIO_INSERTED_FILE_CAP_BYTES): Promise<FolioPreview> {
  const { workspace } = stores
  const entries: PreviewEntry[] = []
  for (const file of gathered.files as FolioFileRef[]) {
    if (file.role === 'linked') { entries.push({ kind: 'linked', path: file.path }); continue }
    if (file.role === 'inserted') {
      const info = await lstat(workspace.absolute(file.path)).catch(() => null)
      if (!info || !info.isFile()) { entries.push({ kind: 'inserted', path: file.path, present: false, bytes: 0, handling: 'kept', hash: null, version: null }); continue }
      const handling = insertedFileHandling(info.size, cap)
      let hash: string | null = null
      let version: PreviewInserted['version'] = null
      if (handling === 'kept') {
        hash = sha256(await stores.readBytes(file.path).catch(() => Buffer.alloc(0)))
        const versions = (await stores.versions.list({ path: file.path })).filter((entry: Version) => entry.snapshotId !== undefined)
        const latest = versions[0]
        if (latest && (await stores.snapshotHash(latest.snapshotId!)) === hash) version = { id: latest.id, number: versions.length, name: latest.name }
      }
      entries.push({ kind: 'inserted', path: file.path, present: true, bytes: info.size, handling, hash, version })
      continue
    }
    let words: number | null = null
    try { words = documentWordCount((await workspace.readFile(file.path)).content) } catch { /* a file that cannot be read is refused by the save, not here */ }
    const all = await stores.changes.list({ path: file.path })
    entries.push({
      kind: 'text', role: file.role, path: file.path,
      ...(file.title !== undefined ? { title: file.title } : {}),
      ...(file.order !== undefined ? { order: file.order } : {}),
      words,
      ownIds: changesAVersionWouldSettle(all).map((change) => change.id).sort(),
      agentIds: all.filter((change) => agentWaitingKind(change) !== null).map((change) => change.id).sort(),
    })
  }
  const planned = gathered.notWritten.map((part) => part.title)
  const fingerprint = createHash('sha256').update(JSON.stringify({ entries, planned })).digest('hex')
  return { entries, planned, fingerprint }
}
