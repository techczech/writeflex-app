import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/main/cli/run'
import { Workspace } from '../../src/main/workspace'

const SECRET = 'zebra-secret-token'
let root: string
let outside: string
let ws: Workspace

/** Each entry: a path that reaches hidden content, and the folder holding it. */
const PLANTED: Array<{ what: string; file: string; folder: string }> = [
  { what: 'a link to .writeflex', file: 'wf/secret.md', folder: 'wf' },
  { what: 'a link to .bridle', file: 'br/store.md', folder: 'br' },
  { what: 'a link to a hidden folder two levels down', file: 'two/x.md', folder: 'two' },
  { what: 'a link into a folder below a hidden one', file: 'below/x.md', folder: 'below' },
  { what: 'a link chain', file: 'chain1/secret.md', folder: 'chain1' },
  { what: 'a link below an ordinary folder', file: 'talks/inner-link/secret.md', folder: 'talks/inner-link' },
  { what: 'an ignored folder', file: 'node_modules/pkg/readme.md', folder: 'node_modules/pkg' },
  { what: 'a link to an ignored folder', file: 'deps/pkg/readme.md', folder: 'deps' },
]

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-docpath-')))
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-docpath-out-')))
  ws = new Workspace(root)
  for (const dir of ['talks', '.writeflex', '.bridle', 'deep/.hidden/inner', 'node_modules/pkg', 'Release', 'Out/Node_Modules']) await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, 'notes.md'), '# Notes\nordinary text\n')
  await writeFile(join(root, 'talks', 'york.md'), '---\nstatus: draft\n---\n# York\nordinary talk\n')
  await writeFile(join(root, 'Release', 'notes.md'), '# Release notes\nordinary release text\n')
  await writeFile(join(root, 'Out', 'Node_Modules', 'essay.md'), '# Essay\nordinary essay text\n')
  await symlink('node_modules', join(root, 'deps'))
  for (const file of ['.writeflex/secret.md', '.bridle/store.md', 'deep/.hidden/inner/x.md', 'node_modules/pkg/readme.md']) {
    await writeFile(join(root, file), `---\nstatus: draft\n---\n# Hidden\n${SECRET}\n`)
  }
  await writeFile(join(outside, 'elsewhere.md'), `${SECRET}\n`)
  await symlink('.writeflex', join(root, 'wf'))
  await symlink('.bridle', join(root, 'br'))
  await symlink('deep/.hidden', join(root, 'two'))
  await symlink('deep/.hidden/inner', join(root, 'below'))
  await symlink('chain2', join(root, 'chain1'))
  await symlink('chain3', join(root, 'chain2'))
  await symlink('.writeflex', join(root, 'chain3'))
  await symlink('../.writeflex', join(root, 'talks', 'inner-link'))
  await symlink('talks', join(root, 'plain'))
  await symlink('.writeflex/secret.md', join(root, 'leak.md'))
  await symlink(outside, join(root, 'away'))
  await symlink('nowhere/at-all', join(root, 'dangling'))
  // `two` points at the hidden folder itself, so its file sits one level further in.
  await writeFile(join(root, 'deep', '.hidden', 'x.md'), `${SECRET}\n`)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runCli(['--root', root, ...argv], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: (t) => { err += t }, openUrl: async () => {} })
  return { code, out, err }
}

test('a link inside the Collection that reaches a hidden folder is refused for a file argument and for a folder argument', async () => {
  for (const planted of PLANTED) {
    for (const argv of [['read', planted.file], ['tasks', planted.file], ['open', planted.file], ['versions', planted.file]]) {
      const result = await cli(...argv)
      expect(result.code, `${planted.what}: ${argv.join(' ')}`).toBe(1)
      expect(result.err, `${planted.what}: ${argv.join(' ')}`).toMatch(/dot-folder or an ignored folder/)
      expect(result.out + result.err).not.toContain(SECRET)
    }
    for (const argv of [['files', planted.folder], ['search', 'zebra', '--folder', planted.folder], ['query', 'status: draft', '--dir', planted.folder], ['running-order', planted.folder]]) {
      const result = await cli(...argv)
      expect(result.code, `${planted.what}: ${argv.join(' ')}`).toBe(1)
      expect(result.err, `${planted.what}: ${argv.join(' ')}`).toMatch(/dot-folder or an ignored folder/)
      expect(result.out + result.err).not.toContain(SECRET)
    }
  }
})

test('a file that is itself a link into a hidden folder is refused', async () => {
  const result = await cli('read', 'leak.md')
  expect(result.code).toBe(1)
  expect(result.err).toMatch(/dot-folder or an ignored folder/)
  expect(result.out + result.err).not.toContain(SECRET)
})

test('a dot-folder is refused in any letter case, reached directly or through a link', async () => {
  // On a disk that ignores case these reach .writeflex and .bridle; the leading dot refuses them
  // whatever the case. (On a disk that respects case they name nothing, and the link leads nowhere.)
  await symlink('.WriteFlex', join(root, 'caps'))
  await symlink('.BRIDLE', join(root, 'caps-bridle'))
  for (const path of ['.WriteFlex/secret.md', '.WRITEFLEX/secret.md', '.BRIDLE/store.md', '.Bridle/store.md', 'caps/secret.md', 'caps-bridle/store.md']) {
    const result = await cli('read', path)
    expect(result.code, path).toBe(1)
    expect(result.err, path).toMatch(/dot-folder or an ignored folder|outside the Collection/)
    expect(result.out + result.err, path).not.toContain(SECRET)
    expect(ws.classifyPath(path), path).not.toBe('document')
  }
  for (const folder of ['.WriteFlex', '.BRIDLE', 'caps', 'caps-bridle']) {
    expect((await cli('files', folder)).code, folder).toBe(1)
    expect(ws.classifyPath(folder, 'folder'), folder).not.toBe('document')
  }
  expect(ws.classifyPath('.WriteFlex/secret.md')).toBe('hidden')
  expect(ws.classifyPath('.BRIDLE', 'folder')).toBe('hidden')
})

test('a writer\'s folder named Release, Out or Node_Modules is an ordinary folder: only the exact lower-case names are ignored', async () => {
  const read = await cli('read', 'Release/notes.md')
  expect(read.code).toBe(0)
  expect(read.out).toContain('ordinary release text')
  expect((await cli('read', 'Out/Node_Modules/essay.md')).out).toContain('ordinary essay text')
  expect((await cli('files', 'Release')).code).toBe(0)
  expect(ws.classifyPath('Release/notes.md')).toBe('document')
  expect(ws.classifyPath('Release', 'folder')).toBe('document')
  expect(ws.classifyPath('Out/Node_Modules', 'folder')).toBe('document')
  expect(ws.isVisiblePath('Release/notes.md')).toBe(true)
  expect(ws.isVisiblePath('release/notes.md')).toBe(false)
  expect((await cli('search', 'ordinary release')).out).toContain('Release/notes.md')
})

test('the sidebar listing still shows a folder named Release, and its files', async () => {
  expect(await ws.listFolders()).toEqual(['deep', 'Out', 'Out/Node_Modules', 'Release', 'talks'].sort((a, b) => a.localeCompare(b)))
  expect((await ws.listFiles()).map((file) => file.path)).toContain('Release/notes.md')
})

test('a link to an ordinary folder inside the Collection still works; one that leaves it, or leads nowhere, does not', async () => {
  const read = await cli('read', 'plain/york.md')
  expect(read.code).toBe(0)
  expect(read.out).toContain('ordinary talk')
  expect((await cli('files', 'plain')).code).toBe(0)
  expect((await cli('tasks', 'plain/york.md')).code).toBe(0)
  for (const argv of [['read', 'away/elsewhere.md'], ['files', 'away'], ['read', 'dangling/x.md'], ['files', 'dangling']]) {
    const result = await cli(...argv)
    expect(result.code, argv.join(' ')).toBe(1)
    expect(result.err, argv.join(' ')).toMatch(/outside the Collection/)
  }
})

test('the Workspace classifies the typed path and its real location together', () => {
  expect(ws.classifyPath('notes.md')).toBe('document')
  expect(ws.classifyPath('talks', 'folder')).toBe('document')
  expect(ws.classifyPath('talks/not-written-yet.md')).toBe('document')
  expect(ws.classifyPath('plain/york.md')).toBe('document')
  expect(ws.classifyPath('plain', 'folder')).toBe('document')
  // A dot-prefixed file name is still a document; only folders are hidden.
  expect(ws.classifyPath('talks/.draft.md')).toBe('document')
  for (const planted of PLANTED) {
    expect(ws.classifyPath(planted.file), planted.what).toBe('hidden')
    expect(ws.classifyPath(planted.folder, 'folder'), planted.what).toBe('hidden')
    expect(ws.classifyPath(`${planted.folder}/not-written-yet.md`), planted.what).toBe('hidden')
  }
  expect(ws.classifyPath('leak.md')).toBe('hidden')
  expect(ws.classifyPath('.writeflex', 'folder')).toBe('hidden')
  expect(ws.classifyPath('.Bridle/x.md')).toBe('hidden')
  expect(ws.classifyPath('away/elsewhere.md')).toBe('outside')
  expect(ws.classifyPath('dangling/x.md')).toBe('outside')
  expect(ws.classifyPath('../x.md')).toBe('outside')
  expect(ws.classifyPath('')).toBe('outside')
})

test('search, list and query never return content reached through a link: the walker does not follow links at all', async () => {
  const files = (await ws.listFiles()).map((file) => file.path)
  expect(files).toEqual(['notes.md', 'Out/Node_Modules/essay.md', 'Release/notes.md', 'talks/york.md'])
  for (const folder of await ws.listFolders()) expect(['deep', 'Out', 'Out/Node_Modules', 'Release', 'talks']).toContain(folder)
  const search = await cli('--json', 'search', 'zebra')
  expect(JSON.parse(search.out).result.total).toBe(0)
  expect(search.out).not.toContain(SECRET)
  const list = await cli('--json', 'files')
  expect(JSON.parse(list.out).result.files.map((file: { path: string }) => file.path)).toEqual(files)
  const query = await cli('--json', 'query', 'status: draft')
  expect(JSON.parse(query.out).result.rows.map((row: { path: string }) => row.path)).toEqual(['talks/york.md'])
})
