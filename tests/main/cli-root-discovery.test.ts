import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/main/cli/run'
import { findCollectionRoot, resolveCollectionRoot } from '../../src/main/cli/root'

let base: string
let home: string

beforeEach(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-root-')))
  home = join(base, 'home', 'someone')
  await mkdir(join(home, 'Documents', 'essays', 'drafts'), { recursive: true })
  await mkdir(join(home, 'code', 'repo', 'src'), { recursive: true })
  await writeFile(join(home, 'Documents', 'essays', 'drafts', 'one.md'), '# One\ninside the Collection\n')
})
afterEach(() => rm(base, { recursive: true, force: true }))

async function cli(cwd: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { cwd, home, stdout: (t) => { out += t }, stderr: (t) => { err += t }, openUrl: async () => {} })
  return { code, out, err }
}

test('a marker planted in the home folder never makes the home folder the Collection', async () => {
  await mkdir(join(home, '.writeflex'))
  for (const cwd of [home, join(home, 'Documents'), join(home, 'Documents', 'essays', 'drafts')]) {
    expect(() => findCollectionRoot(cwd, undefined, { home }), cwd).toThrow(/No Collection found/)
  }
  const listed = await cli(join(home, 'Documents', 'essays'), 'files')
  expect(listed.code).toBe(1)
  expect(listed.out).not.toContain('one.md')
})

test('climbing stops at the home folder: a marker above it is never reached', async () => {
  await mkdir(join(base, 'home', '.writeflex'))
  await mkdir(join(base, '.writeflex'))
  expect(() => findCollectionRoot(join(home, 'Documents'), undefined, { home })).toThrow(/No Collection found/)
  // Started above the home folder, the folders that contain it are not Collections either.
  expect(() => findCollectionRoot(join(base, 'home'), undefined, { home })).toThrow(/No Collection found/)
})

test('only the WriteFlex marker folder counts: .bridle alone, or a file named .writeflex, is not a Collection', async () => {
  await mkdir(join(home, 'code', 'repo', '.bridle'))
  expect(() => findCollectionRoot(join(home, 'code', 'repo', 'src'), undefined, { home })).toThrow(/No Collection found/)
  await writeFile(join(home, 'code', '.writeflex'), 'not a folder')
  expect(() => findCollectionRoot(join(home, 'code', 'repo', 'src'), undefined, { home })).toThrow(/No Collection found/)
  await mkdir(join(home, 'Documents', 'essays', '.writeflex'))
  expect(findCollectionRoot(join(home, 'Documents', 'essays', 'drafts'), undefined, { home })).toBe(join(home, 'Documents', 'essays'))
  // The nearest marker wins.
  await mkdir(join(home, 'Documents', '.writeflex'))
  expect(findCollectionRoot(join(home, 'Documents', 'essays', 'drafts'), undefined, { home })).toBe(join(home, 'Documents', 'essays'))
})

test('a link named .writeflex is not a marker: discovery never follows it', async () => {
  const elsewhere = join(base, 'elsewhere')
  await mkdir(join(elsewhere, '.writeflex'), { recursive: true })
  // A link to a real marker folder, and a link to a plain folder: neither makes its folder a Collection.
  await symlink(join(elsewhere, '.writeflex'), join(home, 'code', 'repo', '.writeflex'))
  await symlink(elsewhere, join(home, 'code', '.writeflex'))
  expect(() => findCollectionRoot(join(home, 'code', 'repo', 'src'), undefined, { home })).toThrow(/No Collection found/)
  // The climb goes on past it to a real marker.
  await mkdir(join(home, 'Documents', 'essays', '.writeflex'))
  await symlink(elsewhere, join(home, 'Documents', 'essays', 'drafts', '.writeflex'))
  expect(findCollectionRoot(join(home, 'Documents', 'essays', 'drafts'), undefined, { home })).toBe(join(home, 'Documents', 'essays'))
})

test('a volume root is never discovered, and climbing stops there', async () => {
  const volume = join(base, 'Volumes', 'Disk')
  await mkdir(join(volume, 'notes', 'deep'), { recursive: true })
  await mkdir(join(volume, '.writeflex'))
  await mkdir(join(base, '.writeflex'))
  const isVolumeRoot = (dir: string): boolean => dir === volume
  expect(() => findCollectionRoot(join(volume, 'notes', 'deep'), undefined, { home, isVolumeRoot })).toThrow(/No Collection found/)
  await mkdir(join(volume, 'notes', '.writeflex'))
  expect(findCollectionRoot(join(volume, 'notes', 'deep'), undefined, { home, isVolumeRoot })).toBe(join(volume, 'notes'))
})

test('--root is honoured for any existing folder except the home folder, a volume root and the filesystem root, which are refused with the reason', async () => {
  // No marker is needed when the folder is named outright.
  expect(findCollectionRoot(base, join(home, 'Documents'), { home })).toBe(join(home, 'Documents'))
  expect(() => findCollectionRoot(base, home, { home })).toThrow(/home folder/)
  expect(() => findCollectionRoot(base, '/', { home })).toThrow(/top of the filesystem/)
  const volume = join(base, 'Volumes', 'Disk')
  await mkdir(volume, { recursive: true })
  expect(() => findCollectionRoot(base, volume, { home, isVolumeRoot: (dir) => dir === volume })).toThrow(/root of a disk/)
  expect(() => findCollectionRoot(base, join(base, 'home'), { home })).toThrow(/contains your home folder/)
  // The real surroundings, with nothing injected.
  expect(() => findCollectionRoot(base, homedir())).toThrow(/home folder/)
  expect(() => findCollectionRoot(base, '/')).toThrow(/top of the filesystem/)
  const refused = await cli(base, '--json', '--root', home, 'files')
  expect(refused.code).toBe(1)
  expect(JSON.parse(refused.out)).toMatchObject({ ok: false, error: { code: 'refused' } })
})

test('every result names the Collection root it acted on, in text and in --json', async () => {
  const collection = join(home, 'Documents', 'essays')
  await mkdir(join(collection, '.writeflex'))
  const cwd = join(collection, 'drafts')
  const json = await cli(cwd, '--json', 'files')
  expect(JSON.parse(json.out)).toMatchObject({ ok: true, operation: 'files', root: collection, rootSource: 'discovered' })
  const text = await cli(cwd, 'read', 'drafts/one.md')
  expect(text.code).toBe(0)
  // Standard output stays exactly the document, so it can be piped; the root goes to standard error.
  expect(text.out).toBe('# One\ninside the Collection\n')
  expect(text.err).toBe(`writeflex: Collection found: ${collection}\n`)
  const refusedJson = await cli(cwd, '--json', 'read', '../outside.md')
  expect(JSON.parse(refusedJson.out)).toMatchObject({ ok: false, root: collection, rootSource: 'discovered' })
  const refusedText = await cli(cwd, 'read', '../outside.md')
  expect(refusedText.err).toStartWith(`writeflex: Collection found: ${collection}\n`)
  // help and describe act on no Collection and name none.
  const help = await cli(cwd, '--json', 'help')
  expect(JSON.parse(help.out).root).toBeUndefined()
  expect((await cli(cwd, 'help')).err).toBe('')
})

test('a root found by climbing is reported as discovered, one named with --root as given, so a writing operation can tell them apart', async () => {
  // A folder the user never made a Collection: the marker came with it (an unpacked download).
  const download = join(home, 'Downloads', 'unpacked')
  await mkdir(join(download, '.writeflex'), { recursive: true })
  await mkdir(join(download, 'docs'))
  await writeFile(join(download, 'docs', 'a.md'), '# A\n')
  expect(resolveCollectionRoot(join(download, 'docs'), undefined, { home })).toEqual({ root: download, source: 'discovered' })
  expect(resolveCollectionRoot(base, download, { home })).toEqual({ root: download, source: 'given' })
  // --root wins over whatever climbing would find, and is still "given" from inside the folder.
  expect(resolveCollectionRoot(join(download, 'docs'), '.', { home })).toEqual({ root: join(download, 'docs'), source: 'given' })

  const climbedJson = JSON.parse((await cli(join(download, 'docs'), '--json', 'files')).out)
  expect(climbedJson).toMatchObject({ ok: true, root: download, rootSource: 'discovered' })
  const givenJson = JSON.parse((await cli(base, '--json', '--root', download, 'files')).out)
  expect(givenJson).toMatchObject({ ok: true, root: download, rootSource: 'given' })
  expect((await cli(join(download, 'docs'), 'files')).err).toBe(`writeflex: Collection found: ${download}\n`)
  expect((await cli(base, '--root', download, 'files')).err).toBe(`writeflex: Collection given: ${download}\n`)
  const refused = JSON.parse((await cli(base, '--json', '--root', download, 'read', '../x.md')).out)
  expect(refused).toMatchObject({ ok: false, root: download, rootSource: 'given' })
})
