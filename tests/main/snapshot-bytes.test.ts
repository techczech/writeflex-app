/**
 * `snapshotBytes` (src/main/snapshot-bytes.ts): a snapshot of bytes already in hand, in Bridle's own store, with the journal line `snapshotFile` writes;
 * and the bounded read of a saved copy (cli/history-store.ts `readSnapshotBytesBounded`). Synthetic files on a temporary Collection.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '@bridle/core'
import { readSnapshotBytesBounded, snapshotHashesOf } from '../../src/main/cli/history-store'
import { snapshotBytes } from '../../src/main/snapshot-bytes'

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const META = { sessionId: 'test-session', capability: 'change.save-version' }

let root: string
beforeEach(async () => { root = realpathSync(await mkdtemp(join(tmpdir(), 'wf19-sb-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const journal = async (): Promise<Array<Record<string, unknown>>> => (await readFile(join(root, '.bridle/journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)

test('snapshotBytes writes the object and a journal line of the same shape as snapshotFile, so the backup projection reads it as it reads any snapshot', async () => {
  const store = await SnapshotStore.open({ dir: join(root, '.bridle') })
  await mkdir(join(root, 'data'), { recursive: true })
  const bytes = Buffer.from('Judge,Pairs\nJudge 1,120\n')
  const file = join(root, 'data', 'scores.csv')
  await writeFile(file, bytes)
  await store.beginRestorePoint('version: data/scores.csv', META.sessionId)
  const byFile = await store.snapshotFile(file, META)
  const byBytes = await snapshotBytes(store, file, bytes, META)

  const [fromFile, fromBytes] = (await journal()).filter((line) => line.kind === 'snapshot')
  // The same keys, in the same order, with the same values except the id and the time.
  expect(Object.keys(fromBytes!)).toEqual(Object.keys(fromFile!))
  const { id: fileId, ts: fileTs, ...fileRest } = fromFile!
  const { id: bytesId, ts: bytesTs, ...bytesRest } = fromBytes!
  expect(bytesRest).toEqual(fileRest)
  expect(bytesRest).toMatchObject({ kind: 'snapshot', sessionId: 'test-session', file, hash: sha(bytes), capability: 'change.save-version', origin: 'host' })
  expect(typeof bytesId).toBe('string')
  expect(bytesId).not.toBe(fileId)
  expect(typeof bytesTs).toBe('number')
  expect(typeof fileTs).toBe('number')
  expect(byBytes.id).toBe(bytesId as string)
  expect(byFile.id).toBe(fileId as string)
  // One object, read back by the store's own reader; the CLI's journal reader finds both ids at the one hash.
  expect(await store.readSnapshotContent(byBytes.id)).toBe(bytes.toString('utf8'))
  expect([...(await snapshotHashesOf(root, [byFile.id, byBytes.id])).values()]).toEqual([sha(bytes), sha(bytes)])
})

test('snapshotBytes stores the bytes it is given even when the file now holds others, and never touches the file', async () => {
  const store = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const file = join(root, 'a.csv')
  await writeFile(file, 'now: something else entirely\n')
  const judged = Buffer.from('a,b\n1,2\n')
  const entry = await snapshotBytes(store, file, judged, META)
  expect(await store.readSnapshotContent(entry.id)).toBe('a,b\n1,2\n')
  expect(await readFile(file, 'utf8')).toBe('now: something else entirely\n')
})

test('snapshotBytes never overwrites or removes an object: an object standing with other bytes is refused and left as it is', async () => {
  const store = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const bytes = Buffer.from('x,y\n1,2\n')
  const standing = join(root, '.bridle/objects', sha(bytes))
  await writeFile(standing, 'damaged')
  await expect(snapshotBytes(store, join(root, 'a.csv'), bytes, META)).rejects.toThrow()
  expect(await readFile(standing, 'utf8')).toBe('damaged')
  expect((await journal().catch(() => [])).filter((line) => line.kind === 'snapshot')).toEqual([])
})

test('a saved copy is read with a bound: an object that grows after it was looked at is refused as too large, not read whole', async () => {
  const store = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const bytes = Buffer.from('x,y\n1,2\n')
  const entry = await snapshotBytes(store, join(root, 'a.csv'), bytes, META)
  expect(await readSnapshotBytesBounded(root, entry.id, 1024)).toEqual(bytes)
  expect(await readSnapshotBytesBounded(root, entry.id, bytes.length - 1)).toBe('too-large')
  expect(await readSnapshotBytesBounded(root, 'no-such-id', 1024)).toBeNull()
  // The object is small when its size is looked at and large when it is opened: the read stops at the bound.
  const object = join(root, '.bridle/objects', sha(bytes))
  const grown = await readSnapshotBytesBounded(root, entry.id, 1024, { afterCheck: async (rel) => { if (rel.endsWith(sha(bytes))) await writeFile(object, Buffer.alloc(8 * 1024 * 1024, 1)) } })
  expect(grown).toBe('too-large')
})

test('snapshotBytes holds Bridle\'s store order from the object to the journal line: a snapshotFile started meanwhile appends after it, so a restore point leads to its own snapshot', async () => {
  const store = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const file = join(root, 'b.csv')
  await writeFile(file, 'competing,bytes\n')
  const internals = store as unknown as { storeObject(hash: string, content: Buffer): Promise<void> }
  const real = internals.storeObject.bind(store)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let paused!: () => void
  const reached = new Promise<void>((resolve) => { paused = resolve })
  const judged = Buffer.from('judged,bytes\n')
  internals.storeObject = async (hash: string, content: Buffer): Promise<void> => {
    if (content.equals(judged)) { paused(); await gate }
    return real(hash, content)
  }
  const point = await store.beginRestorePoint('version: b.csv', META.sessionId)
  const mine = snapshotBytes(store, file, judged, META)
  await reached
  const competing = store.snapshotFile(file, { sessionId: META.sessionId })
  let competingDone = false
  void competing.then(() => { competingDone = true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(competingDone).toBe(false)
  release()
  const [entry, other] = await Promise.all([mine, competing])
  const lines = await journal()
  const at = (id: string): number => lines.findIndex((line) => line.id === id)
  expect(at(point)).toBeLessThan(at(entry.id))
  expect(at(entry.id)).toBeLessThan(at(other.id))
  expect(lines[at(point) + 1]!.id).toBe(entry.id)
})
