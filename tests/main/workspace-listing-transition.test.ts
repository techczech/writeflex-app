import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let temporary: string
let root: string
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'wf-listing-transition-'))
  root = join(temporary, 'workspace')
  await mkdir(join(root, 'pangram/contents'), { recursive: true })
  await mkdir(join(root, 'pangram/.folio-bin'))
  await mkdir(join(root, 'empty'))
  await writeFile(join(root, 'pangram/contents/01-summary.md'), '# Summary\n')
  await writeFile(join(root, 'pangram/contents/02-details.md'), '# Details\n')
  await writeFile(join(root, 'keep.md'), '# Keep\n')
  await writeFile(join(root, 'ignored.txt'), 'not markdown')
  await symlink(join(root, 'pangram/contents'), join(root, 'linked'))
})
afterEach(async () => { await rm(temporary, { recursive: true, force: true }) })

// Only this child replaces fs exports. The suite process and other Workspace users keep real fs.
// The real directory entries are captured before a real rename; the subsequent real stat fails.
const probe = String.raw`
  import { mock } from 'bun:test'
  import * as fs from 'node:fs/promises'
  import { join } from 'node:path'
  const { readdir, stat, rename, rm } = fs
  const root = process.env.WF_LISTING_ROOT
  const mode = process.env.WF_LISTING_MODE
  const base = join(root, 'pangram/contents')
  const target = join(base, '01-summary.md')
  const events = []
  const fault = Object.assign(new Error('listing fault'), { code: mode, path: target, syscall: 'stat' })
  let transitioned = false
  void mock.module('node:fs/promises', () => ({
    ...fs,
    readdir: async (path, options) => {
      const entries = await readdir(path, options)
      if (path === base && !transitioned) {
        transitioned = true
        events.push({ operation: 'readdir', path, names: entries.map(entry => entry.name) })
        if (mode === 'move') {
          await rename(target, join(root, 'pangram/.folio-bin/01-summary.md'))
          events.push({ operation: 'rename', path: target })
        } else if (mode === 'root-lost') {
          await rm(root, { recursive: true })
          events.push({ operation: 'remove-root', path: root })
        }
      }
      return entries
    },
    stat: async (path, options) => {
      if (path === target) {
        events.push({ operation: 'stat', path })
        if (mode === 'EACCES' || mode === 'EIO') throw fault
      }
      try { return await stat(path, options) }
      catch (error) {
        events.push({ operation: 'stat-error', path, code: error.code, syscall: error.syscall })
        throw error
      }
    },
  }))
  const { Workspace } = await import('./src/main/workspace.ts')
  if (mode === 'missing-root') await rm(root, { recursive: true })
  try {
    const listing = await new Workspace(root).listFilesAndFolders()
    console.log(JSON.stringify({ ok: true, listing, events }))
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { code: error.code, path: error.path,
      syscall: error.syscall, message: error.message, stack: error.stack, sameFault: error === fault }, events }))
  }
`

async function list(mode: string): Promise<any> {
  const child = Bun.spawn([process.execPath, '-e', probe], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, WF_LISTING_ROOT: root, WF_LISTING_MODE: mode },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  return JSON.parse(stdout)
}

test('workspace listing survives a listed chapter moving to the Folio bin before stat', async () => {
  const result = await list('move')
  expect(result.events.map((event: any) => event.operation)).toEqual(['readdir', 'rename', 'stat', 'stat-error'])
  expect([...result.events[0].names].sort()).toEqual(['01-summary.md', '02-details.md'])
  expect(result.events[3]).toMatchObject({ code: 'ENOENT', syscall: 'stat', path: join(root, 'pangram/contents/01-summary.md') })
  // An old-source failure prints the precise error and event order into the test receipt.
  if (!result.ok) throw new Error(JSON.stringify(result, null, 2))
  expect(result.listing.files.map((file: any) => file.path)).toEqual(['keep.md', 'pangram/contents/02-details.md'])
  expect(result.listing.folders).toEqual(['empty', 'pangram', 'pangram/contents'])
})

for (const code of ['EACCES', 'EIO']) {
  test(`workspace listing preserves the original ${code} stat failure`, async () => {
    const result = await list(code)
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code, syscall: 'stat', path: join(root, 'pangram/contents/01-summary.md'), sameFault: true })
  })
}

for (const mode of ['missing-root', 'root-lost']) {
  test(`workspace listing rejects ${mode} instead of returning a partial workspace`, async () => {
    const result = await list(mode)
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('ENOENT')
  })
}

test('ordinary workspace listing retains exact files, metadata, empty folders and ignore/symlink rules', async () => {
  const result = await list('ordinary')
  expect(result.ok).toBe(true)
  expect(result.listing.files.map((file: any) => [file.path, file.name, file.directory, file.size])).toEqual([
    ['keep.md', 'keep.md', '', 7],
    ['pangram/contents/01-summary.md', '01-summary.md', 'pangram/contents', 10],
    ['pangram/contents/02-details.md', '02-details.md', 'pangram/contents', 10],
  ])
  expect(result.listing.files.every((file: any) => Number.isFinite(file.modifiedAt))).toBe(true)
  expect(result.listing.folders).toEqual(['empty', 'pangram', 'pangram/contents'])
})
