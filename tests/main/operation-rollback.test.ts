import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rollBackOperationWrites, rollbackMessage } from '../../src/main/operation-rollback'
import { Workspace, type OperationWrite } from '../../src/main/workspace'

// R7: a rollback after a failed multi-file operation restores only files that operation actually wrote,
// and only while each still holds exactly the text the operation wrote; anything else is left and named.

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-operation-rollback-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (path: string) => readFile(join(root, path), 'utf8')

test('the record holds the operation\'s own writes (rewrite, create, removal), never another call\'s', async () => {
  await writeFile(join(root, 'a.md'), 'A\n')
  await writeFile(join(root, 'gone.md'), 'G\n')
  const log: OperationWrite[] = []
  let release!: () => void
  const other = new Promise<void>((resolve) => { release = resolve }).then(() => ws.saveFile('other.md', 'O\n'))
  await ws.recordingOperationWrites(log, async () => {
    await ws.saveFileOverRead('a.md', 'A2\n', 'A\n')
    await ws.createFile('new.md', 'N\n')
    ws.removeFileOverRead('gone.md', 'G\n')
    release()
    await other
  })
  expect(log).toEqual([
    { path: 'a.md', before: 'A\n', after: 'A2\n' },
    { path: 'new.md', before: null, after: 'N\n' },
    { path: 'gone.md', before: 'G\n', after: null },
  ])
})

test('every file the operation wrote and nobody changed since is put back: rewritten, created, removed', async () => {
  await writeFile(join(root, 'a.md'), 'A\n')
  await writeFile(join(root, 'gone.md'), 'G\n')
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, async () => {
    await ws.saveFileOverRead('a.md', 'A2\n', 'A\n')
    await ws.saveFileOverRead('a.md', 'A3\n', 'A2\n')
    await ws.createFile('new.md', 'N\n')
    ws.removeFileOverRead('gone.md', 'G\n')
  })
  const outcome = await rollBackOperationWrites(ws, log)
  expect(outcome).toEqual({ restored: ['gone.md', 'new.md', 'a.md'], changed: [], failed: [] })
  expect(await read('a.md')).toBe('A\n')
  expect(existsSync(join(root, 'new.md'))).toBe(false)
  expect(await read('gone.md')).toBe('G\n')
  expect(rollbackMessage('It failed.', outcome)).toBe('Nothing was changed: It failed.')
})

test('a file changed since the operation wrote it is left as it is and named; the rest is put back', async () => {
  await writeFile(join(root, 'a.md'), 'A\n')
  await writeFile(join(root, 'b.md'), 'B\n')
  await writeFile(join(root, 'gone.md'), 'G\n')
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, async () => {
    await ws.saveFileOverRead('a.md', 'A2\n', 'A\n')
    await ws.saveFileOverRead('b.md', 'B2\n', 'B\n')
    await ws.createFile('new.md', 'N\n')
    ws.removeFileOverRead('gone.md', 'G\n')
  })
  // Another program, after the operation's writes and before its rollback.
  writeFileSync(join(root, 'b.md'), 'B outside\n')
  writeFileSync(join(root, 'new.md'), 'N outside\n')
  writeFileSync(join(root, 'gone.md'), 'G outside\n')
  const outcome = await rollBackOperationWrites(ws, log)
  expect(outcome).toEqual({ restored: ['a.md'], changed: ['gone.md', 'new.md', 'b.md'], failed: [] })
  expect(await read('a.md')).toBe('A\n')
  expect(await read('b.md')).toBe('B outside\n')
  expect(await read('new.md')).toBe('N outside\n')
  expect(await read('gone.md')).toBe('G outside\n')
  expect(rollbackMessage('b.md could not be written.', outcome)).toBe(
    'The change was not completed: b.md could not be written. gone.md, new.md and b.md changed on disk after WriteFlex wrote them, '
    + 'so they were left as they are. a.md was put back.',
  )
})

test('an operation that wrote nothing restores nothing', async () => {
  await writeFile(join(root, 'a.md'), 'outside\n')
  expect(await rollBackOperationWrites(ws, [])).toEqual({ restored: [], changed: [], failed: [] })
  expect(await read('a.md')).toBe('outside\n')
})

test('the rollback\'s own writes are not receipts or refusals of the call that asked for it', async () => {
  await writeFile(join(root, 'a.md'), 'A\n')
  await writeFile(join(root, 'b.md'), 'B\n')
  const log: OperationWrite[] = []
  const { receipts, refusals } = await ws.withWriteReceipts(async () => {
    await ws.recordingOperationWrites(log, async () => {
      await ws.saveFileOverRead('a.md', 'A2\n', 'A\n')
      await ws.saveFileOverRead('b.md', 'B2\n', 'B\n')
    })
    writeFileSync(join(root, 'b.md'), 'B outside\n')
    await rollBackOperationWrites(ws, log)
  })
  expect(receipts.map((receipt) => [receipt.path, receipt.written])).toEqual([['a.md', 'A2\n'], ['b.md', 'B2\n']])
  expect(refusals).toEqual([])
})
