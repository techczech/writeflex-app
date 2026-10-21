/**
 * The checked whole-file write into `.writeflex` (checked-store-write.ts): temp file and rename, the
 * create that never replaces, the "must still hold" check, and the link guards shared with the append.
 * The dangerous interleavings (a sync writer or a second window acting mid-write) are scheduled
 * exactly through `storeWriteSeams`.
 *
 * Seam: `readStoreFile` / `writeStoreFile` over a real temporary Collection, plus `storeWriteSeams`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readStoreFile,
  StoreFileChanged,
  StoreFileExists,
  storeWriteSeams,
  StoreWriteRefused,
  writeStoreFile,
  type StoreFileVersion,
} from '../../src/main/checked-store-write'

const REL = '.writeflex/vault.json'
let root: string
let outside: string
const target = (): string => join(root, '.writeflex', 'vault.json')
/** The version a caller holds after reading the file: what `expect` must name. */
const version = async (): Promise<StoreFileVersion> => {
  const read = await readStoreFile(root, REL)
  if (read.state !== 'present') throw new Error(`expected a file, got ${read.state}`)
  return { bytes: read.bytes, stamp: read.stamp }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-store-write-'))
  outside = await mkdtemp(join(tmpdir(), 'wf-store-write-outside-'))
})
afterEach(async () => {
  for (const key of Object.keys(storeWriteSeams)) delete storeWriteSeams[key as keyof typeof storeWriteSeams]
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('reading a Collection without .writeflex is absent and creates nothing', async () => {
  expect(await readStoreFile(root, REL)).toEqual({ state: 'absent' })
  expect(existsSync(join(root, '.writeflex'))).toBe(false)
})

test('create makes .writeflex and the file, leaves no temporary file, and refuses the second time', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  expect(await readFile(target(), 'utf8')).toBe('one')
  expect(await readdir(join(root, '.writeflex'))).toEqual(['vault.json'])
  await expect(writeStoreFile(root, REL, 'two', { mode: 'create' })).rejects.toBeInstanceOf(StoreFileExists)
  expect(await readFile(target(), 'utf8')).toBe('one')
  expect(await readdir(join(root, '.writeflex'))).toEqual(['vault.json'])
})

test('replace writes the whole file when it still holds what the caller read', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  await writeStoreFile(root, REL, 'two', { mode: 'replace', expect: await version() })
  expect(await readFile(target(), 'utf8')).toBe('two')
})

test('replace refuses when the file no longer holds what the caller read', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  const read = await version()
  await writeFile(target(), 'changed elsewhere')
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: read })).rejects.toBeInstanceOf(StoreFileChanged)
  expect(await readFile(target(), 'utf8')).toBe('changed elsewhere')
  expect(await readdir(join(root, '.writeflex'))).toEqual(['vault.json'])
})

test('a .writeflex that is a link refuses reads and writes; nothing lands in its target', async () => {
  await symlink(outside, join(root, '.writeflex'))
  expect(await readStoreFile(root, REL)).toMatchObject({ state: 'refused', where: 'folder' })
  await expect(writeStoreFile(root, REL, 'x', { mode: 'create' })).rejects.toBeInstanceOf(StoreWriteRefused)
  await expect(writeStoreFile(root, REL, 'x', { mode: 'replace' })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readdir(outside)).toEqual([])
})

test('a vault.json that is a link is refused for reading and writing, and its target is untouched', async () => {
  await mkdir(join(root, '.writeflex'))
  await writeFile(join(outside, 'real.json'), 'theirs')
  await symlink(join(outside, 'real.json'), target())
  expect(await readStoreFile(root, REL)).toMatchObject({ state: 'refused', where: 'file' })
  await expect(writeStoreFile(root, REL, 'x', { mode: 'replace' })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readFile(join(outside, 'real.json'), 'utf8')).toBe('theirs')
})

test('a vault.json with a second name is refused', async () => {
  await mkdir(join(root, '.writeflex'))
  await writeFile(target(), 'one')
  await link(target(), join(outside, 'other-name.json'))
  await expect(writeStoreFile(root, REL, 'x', { mode: 'replace' })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readFile(target(), 'utf8')).toBe('one')
})

test('a name outside .writeflex is a programming error', async () => {
  await expect(writeStoreFile(root, 'notes.md', 'x', { mode: 'replace' })).rejects.toThrow('not a file directly inside')
  await expect(writeStoreFile(root, '.writeflex/../x.json', 'x', { mode: 'replace' })).rejects.toThrow('not a file directly inside')
})

// The interleavings below each schedule another writer at one exact point inside the write.

test('a change landing after the bytes were compared, before the rename, is not overwritten', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  const read = await version()
  storeWriteSeams.afterContentCheck = async () => {
    await writeFile(target(), 'late remote edit')
  }
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: read })).rejects.toBeInstanceOf(StoreFileChanged)
  expect(await readFile(target(), 'utf8')).toBe('late remote edit')
  expect(await readdir(join(root, '.writeflex'))).toEqual(['vault.json'])
})

test('a sync replacing the file by rename with the same bytes, mid-write, is caught by its identity', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  const read = await version()
  storeWriteSeams.afterContentCheck = async () => {
    await writeFile(join(root, '.writeflex', 'incoming'), 'one')
    await rename(join(root, '.writeflex', 'incoming'), target())
  }
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: read })).rejects.toBeInstanceOf(StoreFileChanged)
  expect(await readFile(target(), 'utf8')).toBe('one')
})

test('a change landing while the temporary file was written is caught before promotion', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  const read = await version()
  storeWriteSeams.beforePromote = async () => {
    await writeFile(target(), '{"version":2}')
  }
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: read })).rejects.toBeInstanceOf(StoreFileChanged)
  expect(await readFile(target(), 'utf8')).toBe('{"version":2}')
  expect(await readdir(join(root, '.writeflex'))).toEqual(['vault.json'])
})

test('a temporary file replaced by a link before promotion is never promoted, and the link is left alone', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  await writeFile(join(outside, 'real.json'), 'theirs')
  let temp = ''
  storeWriteSeams.beforePromote = async (path) => {
    temp = path
    await unlink(path)
    await symlink(join(outside, 'real.json'), path)
  }
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: await version() })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readFile(target(), 'utf8')).toBe('one')
  expect(await readFile(join(outside, 'real.json'), 'utf8')).toBe('theirs')
  // Not ours, so not removed: the substitute stays where it was put.
  expect(existsSync(temp)).toBe(true)
})

test('a temporary file replaced by a second name of another file is never promoted (replace and create)', async () => {
  await writeFile(join(outside, 'real.json'), 'theirs')
  storeWriteSeams.beforePromote = async (path) => {
    await unlink(path)
    await link(join(outside, 'real.json'), path)
  }
  await mkdir(join(root, '.writeflex'))
  await expect(writeStoreFile(root, REL, 'new', { mode: 'create' })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(existsSync(target())).toBe(false)
  await writeFile(target(), 'one')
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: await version() })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readFile(target(), 'utf8')).toBe('one')
  expect(await readFile(join(outside, 'real.json'), 'utf8')).toBe('theirs')
})

test('a temporary file swapped for a different ordinary file after its bytes were written is never promoted', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  storeWriteSeams.afterTempWrite = async (path) => {
    await unlink(path)
    await writeFile(path, 'substitute')
  }
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: await version() })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readFile(target(), 'utf8')).toBe('one')
})

test('a .writeflex swapped for a link to an outside folder before the temporary file opens: no byte lands outside', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  const read = await version()
  const seenOutside: string[] = []
  storeWriteSeams.beforeTempOpen = async () => {
    await rename(join(root, '.writeflex'), join(root, 'moved-away'))
    await symlink(outside, join(root, '.writeflex'))
  }
  storeWriteSeams.afterTempWrite = async () => {
    for (const name of await readdir(outside)) seenOutside.push(`${name}=${await readFile(join(outside, name), 'utf8')}`)
  }
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: read })).rejects.toBeInstanceOf(StoreWriteRefused)
  // Refused right after the open, before a byte was written: the bytes never reached the outside folder,
  // and the empty file the open made there was ours and was removed.
  expect(seenOutside).toEqual([])
  expect(await readdir(outside)).toEqual([])
  expect(await readFile(join(root, 'moved-away', 'vault.json'), 'utf8')).toBe('one')
})

test('a .writeflex swapped for a link after the temporary file was written is refused before promotion', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  const read = await version()
  storeWriteSeams.beforePromote = async () => {
    await rename(join(root, '.writeflex'), join(root, 'moved-away'))
    await mkdir(join(outside, 'x'))
    await symlink(join(outside, 'x'), join(root, '.writeflex'))
  }
  await expect(writeStoreFile(root, REL, 'two', { mode: 'replace', expect: read })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readdir(join(outside, 'x'))).toEqual([])
  expect(await readFile(join(root, 'moved-away', 'vault.json'), 'utf8')).toBe('one')
})

test('a create whose name is taken by another writer mid-write refuses and keeps the other file', async () => {
  await mkdir(join(root, '.writeflex'))
  storeWriteSeams.beforePromote = async () => {
    await writeFile(target(), 'other window')
  }
  await expect(writeStoreFile(root, REL, 'mine', { mode: 'create' })).rejects.toBeInstanceOf(StoreFileExists)
  expect(await readFile(target(), 'utf8')).toBe('other window')
  expect(await readdir(join(root, '.writeflex'))).toEqual(['vault.json'])
})

test('a temporary file rewritten in place (same inode) after its checks is refused by its bytes, and removed as ours', async () => {
  await writeStoreFile(root, REL, 'one', { mode: 'create' })
  let tempPath = ''
  storeWriteSeams.beforePromote = (path) => { tempPath = path }
  // Sync software rewrites the very same file: identity, type and link count all still match.
  storeWriteSeams.afterContentCheck = async () => {
    await writeFile(tempPath, 'SYNC CONTENT', { flag: 'r+' })
  }
  await expect(writeStoreFile(root, REL, 'INTENDED CONTENT', { mode: 'replace', expect: await version() })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readFile(target(), 'utf8')).toBe('one')
  expect(await readdir(join(root, '.writeflex'))).toEqual(['vault.json'])
})

test('a create whose temporary file is rewritten in place before promotion is refused; no file takes the name', async () => {
  await mkdir(join(root, '.writeflex'))
  storeWriteSeams.beforePromote = async (path) => {
    await writeFile(path, 'SYNC CONTENT', { flag: 'r+' })
  }
  await expect(writeStoreFile(root, REL, 'INTENDED CONTENT', { mode: 'create' })).rejects.toBeInstanceOf(StoreWriteRefused)
  expect(await readdir(join(root, '.writeflex'))).toEqual([])
})
