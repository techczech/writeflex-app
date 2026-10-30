/**
 * The guarded write and the guarded move on a disk without hard links (`link` fails with ENOTSUP, as
 * on some network and FAT volumes). `beforeCommit` is the check made in the tick of the commit: on this
 * path as on the others, nothing may be awaited between it and the system call that commits. Seam:
 * `link`, `lstat` and `rename` of `node:fs/promises`, spied on and recorded in call order.
 */
import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDocumentGuarded } from '../../src/main/guarded-document-write'
import { moveDocumentGuarded } from '../../src/main/guarded-document-move'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
let calls: string[]
let restore: Array<() => void>

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-no-hard-links-')))
  ws = new Workspace(root)
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes/draft.md'), 'draft\n')
  calls = []
  const name = (path: unknown): string => String(path).slice(root.length + 1)
  const realLstat = fsp.lstat
  const realRename = fsp.rename
  const spies = [
    spyOn(fsp, 'link').mockImplementation(async (_from, to) => { calls.push(`link ${name(to)}`); throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }) }),
    spyOn(fsp, 'lstat').mockImplementation(((path: Parameters<typeof realLstat>[0], ...rest: unknown[]) => { calls.push(`lstat ${name(path)}`); return (realLstat as (...args: unknown[]) => unknown)(path, ...rest) }) as typeof realLstat),
    spyOn(fsp, 'rename').mockImplementation(async (from, to) => { calls.push(`rename ${name(to)}`); return realRename(from, to) }),
  ]
  restore = spies.map((spy) => () => spy.mockRestore())
})
afterEach(async () => {
  for (const undo of restore) undo()
  await rm(root, { recursive: true, force: true })
})

/** The calls from the last `beforeCommit` on: it must be followed at once by the commit. */
const fromLastCheck = (): string[] => calls.slice(calls.lastIndexOf('beforeCommit'))

test('a new document on a disk without hard links: the name is checked free before beforeCommit, which is followed at once by the rename', async () => {
  await writeDocumentGuarded(ws, 'notes/new.md', 'new\n', 'create', { beforeCommit: () => { calls.push('beforeCommit') } })
  expect(await readFile(join(root, 'notes/new.md'), 'utf8')).toBe('new\n')
  expect(calls).toContain('link notes/new.md')
  expect(fromLastCheck()).toEqual(['beforeCommit', 'rename notes/new.md'])
  // The name was checked free after the link failed and before the check that precedes the commit.
  const lastCheck = calls.lastIndexOf('beforeCommit')
  expect(calls.lastIndexOf('lstat notes/new.md')).toBeGreaterThan(calls.indexOf('link notes/new.md'))
  expect(calls.lastIndexOf('lstat notes/new.md')).toBeLessThan(lastCheck)
})

test('a check that refuses at the commit on a disk without hard links writes nothing', async () => {
  let checks = 0
  const refused = await writeDocumentGuarded(ws, 'notes/new.md', 'new\n', 'create', {
    // The first check passes (before the link that fails); the one before the rename refuses.
    beforeCommit: () => { checks += 1; if (checks === 2) throw new Error('changed meanwhile') },
  }).then(() => null, (error: Error) => error.message)
  expect(refused).toBe('changed meanwhile')
  expect(existsSync(join(root, 'notes/new.md'))).toBe(false)
  expect(calls.filter((call) => call.startsWith('rename'))).toEqual([])
})

test('a move on a disk without hard links: the name is checked free before beforeCommit, which is followed at once by the rename', async () => {
  await moveDocumentGuarded(ws, 'notes/draft.md', 'notes/moved.md', 'file', { beforeCommit: () => { calls.push('beforeCommit') } })
  expect(await readFile(join(root, 'notes/moved.md'), 'utf8')).toBe('draft\n')
  expect(existsSync(join(root, 'notes/draft.md'))).toBe(false)
  expect(calls).toContain('link notes/moved.md')
  expect(fromLastCheck()).toEqual(['beforeCommit', 'rename notes/moved.md'])
  expect(calls.lastIndexOf('lstat notes/moved.md')).toBeLessThan(calls.lastIndexOf('beforeCommit'))
})

test('a move whose check refuses at the commit on a disk without hard links moves nothing', async () => {
  let checks = 0
  const refused = await moveDocumentGuarded(ws, 'notes/draft.md', 'notes/moved.md', 'file', {
    beforeCommit: () => { checks += 1; if (checks === 2) throw new Error('changed meanwhile') },
  }).then(() => null, (error: Error) => error.message)
  expect(refused).toBe('changed meanwhile')
  expect(existsSync(join(root, 'notes/draft.md'))).toBe(true)
  expect(existsSync(join(root, 'notes/moved.md'))).toBe(false)
})

test('a file put at the name after it was checked free on a disk without hard links is not replaced by the rename: refused, the file stays, no temporary file is left', async () => {
  // This test's own spies, over the real functions (the recording ones of beforeEach are removed first).
  for (const undo of restore) undo()
  const realLstat = fsp.lstat
  let linked = false
  const linkSpy = spyOn(fsp, 'link').mockImplementation(async () => { linked = true; throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }) })
  // The free-check after the failed link finds no file; another program then puts one at the name.
  const lstatSpy = spyOn(fsp, 'lstat').mockImplementation((async (path: string, ...rest: unknown[]) => {
    try {
      return await (realLstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    } catch (error) {
      if (linked && path.endsWith('notes/new.md')) writeFileSync(path, 'THEIRS\n')
      throw error
    }
  }) as unknown as typeof realLstat)
  restore = [() => linkSpy.mockRestore(), () => lstatSpy.mockRestore()]
  const refused = await writeDocumentGuarded(ws, 'notes/new.md', 'mine\n', 'create').then(() => null, (error: unknown) => error)
  expect((refused as { code?: string } | null)?.code).toBe('exists')
  expect(await readFile(join(root, 'notes/new.md'), 'utf8')).toBe('THEIRS\n')
  expect(readdirSync(join(root, 'notes')).sort()).toEqual(['draft.md', 'new.md'])
})
