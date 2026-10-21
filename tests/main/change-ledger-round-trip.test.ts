import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeStore } from '../../src/main/changes'
import { Workspace } from '../../src/main/workspace'

// The logic of tests/e2e/change-ipc.spec.ts without Electron. The 'changes:*' handlers in main/ipc.ts are
// one-line calls onto the ChangeStore (add, list, setReviewStatus - the status-only door, setEditClass), so
// this drives the same add -> list -> set-status -> classify -> scoped list round trip on a real workspace
// and reads the journal file back. (The handlers' own argument plumbing is not covered here; there is no
// seam to reach them without Electron's ipcMain.)
let root: string
let store: ChangeStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-change-ledger-'))
  await writeFile(join(root, 'one.md'), '# One\n\nalpha\n', 'utf8')
  store = new ChangeStore(new Workspace(root))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const journal = async (): Promise<string> => {
  const path = join(root, '.writeflex', 'changes.jsonl')
  return existsSync(path) ? readFile(path, 'utf8') : ''
}

test('add, list, set-status, classify and scoped lists round-trip through the guard and the journal file', async () => {
  expect(await journal()).toBe('') // nothing on disk before the first captured change

  const added = await store.add({
    path: 'one.md', provenance: 'writer', editClass: null, summary: 'typed a word',
    oldText: 'alpha', newText: 'alpha beta', isCorrection: false,
  })
  expect(added.id).toMatch(/^c_/)
  expect(added.status).toBe('pending')
  expect(await journal()).toContain('typed a word') // the store created .writeflex/ on the first change

  const listed = await store.list()
  expect(listed).toHaveLength(1)
  expect(listed[0].summary).toBe('typed a word')

  expect((await store.setReviewStatus(added.id, 'accepted')).status).toBe('accepted')
  expect((await store.setEditClass(added.id, 'content')).editClass).toBe('content')

  expect(await store.list({ status: 'pending' })).toHaveLength(0)
  const forDoc = await store.list({ path: 'one.md' })
  expect(forDoc).toHaveLength(1)
  expect(forDoc[0].status).toBe('accepted')
  expect(forDoc[0].editClass).toBe('content')

  // One record, rewritten in place: the journal on disk holds the settled state, not a second line.
  const lines = (await journal()).split('\n').filter(Boolean)
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0])).toMatchObject({ id: added.id, status: 'accepted', editClass: 'content', path: 'one.md' })
})
