import { test, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderNotUsableError, holdFolder, readCapped } from '../../src/main/cli/request-files'
import { capped, escapeForJson, inLine, quoted, showText, unshow } from '../../src/main/cli/terminal-text'

// Ticket 05 follow-up: the capped read's two checks each on their own, the held folder, and output cleaning.
let root: string
let outside: string
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-request-files-')))
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-request-files-out-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('the size cap alone: a regular file over the cap is not read', async () => {
  await writeFile(join(root, 'big.json'), 'x'.repeat(101))
  await writeFile(join(root, 'fits.json'), 'x'.repeat(100))
  expect(await readCapped(join(root, 'big.json'), 100)).toEqual({ kind: 'too-large', size: 101 })
  expect(await readCapped(join(root, 'fits.json'), 100)).toEqual({ kind: 'text', text: 'x'.repeat(100) })
  expect(await readCapped(join(root, 'none.json'), 100)).toEqual({ kind: 'missing' })
})

test('the no-follow open alone: a link to a small regular file is not read', async () => {
  // Small and regular at its far end, so nothing but the refusal to follow the link stops it.
  await writeFile(join(outside, 'request.json'), '{"secret":true}')
  await symlink(join(outside, 'request.json'), join(root, 'linked.json'))
  expect(await readCapped(join(root, 'linked.json'), 100)).toEqual({ kind: 'not-a-file' })
  await symlink(join(outside, 'nowhere.json'), join(root, 'dangling.json'))
  expect(await readCapped(join(root, 'dangling.json'), 100)).toEqual({ kind: 'not-a-file' })
})

test('a folder or a pipe standing at the name is not a file, and a pipe does not stall the read', async () => {
  await mkdir(join(root, 'folder.json'))
  expect(await readCapped(join(root, 'folder.json'), 100)).toEqual({ kind: 'not-a-file' })
  execFileSync('/usr/bin/mkfifo', [join(root, 'pipe.json')])
  expect(await readCapped(join(root, 'pipe.json'), 100)).toEqual({ kind: 'not-a-file' })
}, 3000)

test('a held folder is verified before each use: swapped for a link, it is neither read, listed, written nor emptied', async () => {
  const held = (await holdFolder(root, '.writeflex/outbox', true))!
  try {
    await held.write('a.json', 'one')
    expect(await held.read('a.json', 100)).toEqual({ kind: 'text', text: 'one' })
    expect(await held.namesUpTo(10)).toEqual({ names: ['a.json'], more: false })

    await rename(join(root, '.writeflex/outbox'), join(outside, 'real'))
    await mkdir(join(outside, 'decoy'))
    await writeFile(join(outside, 'decoy', 'a.json'), 'decoy')
    await symlink(join(outside, 'decoy'), join(root, '.writeflex/outbox'))
    for (const use of [() => held.read('a.json', 100), () => held.namesUpTo(10), () => held.write('b.json', 'two'), () => held.remove('a.json'), () => held.rename('a.json', 'c.json'), () => held.look('a.json')]) {
      await expect(use()).rejects.toBeInstanceOf(FolderNotUsableError)
    }
    expect(await readdir(join(outside, 'decoy'))).toEqual(['a.json'])
    expect(await readFile(join(outside, 'decoy', 'a.json'), 'utf8')).toBe('decoy')

    // Another real folder put at the name is not the folder that was opened either.
    await rm(join(root, '.writeflex/outbox'))
    await mkdir(join(root, '.writeflex/outbox'))
    await expect(held.write('b.json', 'two')).rejects.toBeInstanceOf(FolderNotUsableError)
    expect(await readdir(join(root, '.writeflex/outbox'))).toEqual([])
  } finally {
    await held.close()
  }
})

test('a file is renamed into a held folder only after the folder is verified again', async () => {
  const held = (await holdFolder(root, '.writeflex/outbox', true))!
  try {
    await mkdir(join(outside, 'decoy'))
    await expect(held.write('reply.json', 'text', { beforeRename: async () => {
      await rename(join(root, '.writeflex/outbox'), join(outside, 'real'))
      await symlink(join(outside, 'decoy'), join(root, '.writeflex/outbox'))
    } })).rejects.toBeInstanceOf(FolderNotUsableError)
    expect(await readdir(join(outside, 'decoy'))).toEqual([])
    expect((await readdir(join(outside, 'real'))).filter((name) => name === 'reply.json')).toEqual([])
  } finally {
    await held.close()
  }
})

test('a folder that is a link, or whose parent is, is not held at all', async () => {
  await mkdir(join(root, '.writeflex'))
  await symlink(outside, join(root, '.writeflex/inbox'))
  await expect(holdFolder(root, '.writeflex/inbox', true)).rejects.toBeInstanceOf(FolderNotUsableError)
  await rm(join(root, '.writeflex'), { recursive: true })
  await mkdir(join(outside, 'inbox'))
  await symlink(outside, join(root, '.writeflex'))
  await expect(holdFolder(root, '.writeflex/inbox', true)).rejects.toBeInstanceOf(FolderNotUsableError)
  expect(await holdFolder(root, '.writeflex/absent', false).catch(() => 'threw')).toBe('threw')
})

test('a hidden character is shown, never removed: the printed form is unambiguous and gives back the string', () => {
  const samples = [
    'plain', 'a\u001b[2Jb', 'a\u009b31mb', 'bell\u0007', 'cr\rlf', 'del\u007f', 'bidi\u202eevil', 'sep\u2028x', 'bom\ufeffx', 'nul\u0000',
    'text \\u{1b} spelt out', '\\u{5c}u{1b}', 'back\\slash', 'c:\\users', '\\u{', 'mark\ufdd0in\ufdd1side\ufdd2',
  ]
  const shown = samples.map((sample) => showText(inLine(sample)))
  for (const [i, sample] of samples.entries()) {
    expect(shown[i], sample).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u202e\ufeff\ufdd0-\ufdd2]/)
    expect(unshow(shown[i]), sample).toBe(sample)
  }
  expect(new Set(shown).size).toBe(samples.length)
  expect(showText('a\u001b[2Jb')).toBe('a\\u{1b}[2Jb')
  expect(showText('text \\u{1b}')).toBe('text \\u{5c}u{1b}')
  expect(showText('c:\\folder\\name')).toBe('c:\\folder\\name') // any other backslash is left as it is
  // Newline and tab are the structure of a listing and stay; inside a name on a line they are shown.
  expect(showText('row one\n\trow two')).toBe('row one\n\trow two')
  expect(showText(`${inLine('one\nname')}\n${inLine('tab\there')}`)).toBe('one\\u{a}name\ntab\\u{9}here')
  // A cut says how much was cut.
  expect(capped('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}… [40 more characters not shown]`)
  expect(capped('short', 10)).toBe('short')
  expect(showText(quoted('pa\u001b[1mth\nname'))).toBe('"pa\\u{1b}[1mth\\u{a}name"')
  expect(showText(quoted('y'.repeat(50), 10))).toBe(`"${'y'.repeat(10)}" [cut: 40 more characters not shown]`)
  // JSON output carries the exact value and prints nothing raw.
  const serialised = escapeForJson(JSON.stringify({ name: 'a\u009b31m\u202e\u007fb\u001b[0m' }))
  expect(serialised).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/)
  expect(JSON.parse(serialised)).toEqual({ name: 'a\u009b31m\u202e\u007fb\u001b[0m' })
})
