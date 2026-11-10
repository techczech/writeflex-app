/**
 * The guarded repair of one history object (src/main/history-object-repair.ts): what it replaces, what it refuses,
 * and that "repaired" is only said of an object that was read back. Synthetic files only, in a temporary folder.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFile, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdFolder, type HeldFolder } from '../../src/main/cli/request-files'
import { ObjectRepairRefused, repairCorruptObject } from '../../src/main/history-object-repair'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const TEXT = '# Part 2\n\nThe text this object is named for.\n'
const NAME = sha(TEXT)

let root: string
let objectsDir: string
let held: HeldFolder
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf03-repair-')))
  objectsDir = join(root, '.bridle/objects')
  await mkdir(objectsDir, { recursive: true })
  held = (await holdFolder(root, '.bridle/objects', false))!
})
afterEach(async () => {
  await held.close()
  await rm(root, { recursive: true, force: true })
})
const object = (): string => join(objectsDir, NAME)
const staged = async (): Promise<string> => join(objectsDir, (await readdir(objectsDir)).find((name) => name.endsWith('.tmp'))!)
const onlyObjects = async (): Promise<boolean> => (await readdir(objectsDir)).every((name) => /^[0-9a-f]{64}$/.test(name))

test('an absent object is left to the caller, a sound one is left alone, a damaged one is replaced', async () => {
  expect(await repairCorruptObject(held, NAME, Buffer.from(TEXT))).toBe('absent')
  await writeFile(object(), TEXT)
  expect(await repairCorruptObject(held, NAME, Buffer.from(TEXT))).toBe('sound')
  await writeFile(object(), 'something else entirely')
  expect(await repairCorruptObject(held, NAME, Buffer.from(TEXT))).toBe('repaired')
  expect(await readFile(object(), 'utf8')).toBe(TEXT)
  expect(await onlyObjects()).toBe(true)
})

test('bytes that are not the ones the name stands for are never written', async () => {
  await writeFile(object(), 'something else entirely')
  await expect(repairCorruptObject(held, NAME, Buffer.from('other text'))).rejects.toBeInstanceOf(ObjectRepairRefused)
  expect(await readFile(object(), 'utf8')).toBe('something else entirely')
})

test('the temporary file is changed in place after it was checked: nothing is renamed, the damaged object is untouched, and no temporary file is left', async () => {
  await writeFile(object(), 'something else entirely')
  const refused = await repairCorruptObject(held, NAME, Buffer.from(TEXT), {
    // Same file (same inode), same length, other bytes.
    beforeRename: async () => { await writeFile(await staged(), TEXT.replace('The text', 'Thy  text'), { flag: 'r+' }) },
  }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(ObjectRepairRefused)
  expect((refused as Error).message).toContain('changed while')
  expect(await readFile(object(), 'utf8')).toBe('something else entirely')
  expect(await onlyObjects()).toBe(true)
  // The next try, with nobody interfering, repairs it.
  expect(await repairCorruptObject(held, NAME, Buffer.from(TEXT))).toBe('repaired')
  expect(await readFile(object(), 'utf8')).toBe(TEXT)
})

test('the temporary file is given a second name before the rename: refused, nothing is renamed', async () => {
  await writeFile(object(), 'something else entirely')
  const refused = await repairCorruptObject(held, NAME, Buffer.from(TEXT), {
    beforeRename: async () => { await link(await staged(), join(root, 'second-name.txt')) },
  }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(ObjectRepairRefused)
  expect(await readFile(object(), 'utf8')).toBe('something else entirely')
  expect(await onlyObjects()).toBe(true)
})

test('the object is changed in place right after the rename: not reported as repaired, left as it is, and repaired by the next save', async () => {
  await writeFile(object(), 'something else entirely')
  const refused = await repairCorruptObject(held, NAME, Buffer.from(TEXT), {
    afterRename: async () => { await appendFile(object(), 'tampered') },
  }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(ObjectRepairRefused)
  expect((refused as Error).message).toContain('not reported as repaired')
  expect(await readFile(object(), 'utf8')).toBe(`${TEXT}tampered`)
  expect(await onlyObjects()).toBe(true)
  expect(await repairCorruptObject(held, NAME, Buffer.from(TEXT))).toBe('repaired')
  expect(await readFile(object(), 'utf8')).toBe(TEXT)
})
