import { describe, expect, test } from 'bun:test'
import { pastedImagePath } from '../../src/main/workspace'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { link, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace, sanitiseFileName } from '../../src/main/workspace'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wf-fileops-'))
  writeFileSync(join(root, 'note.md'), '# Note\n\nBody.\n')
  mkdirSync(join(root, 'chapters'))
  writeFileSync(join(root, 'chapters', 'one.md'), '# One\n')
  return root
}

describe('sanitiseFileName (ADR-0017 naming rule)', () => {
  test('keeps the typed name faithfully, only stripping path separators', () => {
    expect(sanitiseFileName('My Great Chapter.md')).toBe('My Great Chapter.md')
    expect(sanitiseFileName('  spaced  ')).toBe('spaced')
    expect(sanitiseFileName('a/b\\c')).toBe('a-b-c')
  })
})

test('pasted image paths use the timestamp and suffix collisions', () => {
  const stamp = new Date('2026-07-12T09:30:12Z')
  expect(pastedImagePath('png', stamp, () => false)).toBe('assets/pasted-2026-07-12-093012.png')
  expect(pastedImagePath('.jpeg', stamp, (path) => path === 'assets/pasted-2026-07-12-093012.jpeg')).toBe('assets/pasted-2026-07-12-093012-2.jpeg')
})

describe('duplicateFile', () => {
  test('clones beside the original as “name (copy).md” with identical content', async () => {
    const ws = new Workspace(makeRoot())
    const copy = await ws.duplicateFile('note.md')
    expect(copy.file.path).toBe('note (copy).md')
    expect(copy.content).toBe('# Note\n\nBody.\n')
    expect(await readFile(join(ws.root, 'note.md'), 'utf8')).toBe('# Note\n\nBody.\n')
  })

  test('never clobbers — auto-suffixes -2, -3', async () => {
    const ws = new Workspace(makeRoot())
    await ws.duplicateFile('note.md')
    const second = await ws.duplicateFile('note.md')
    const third = await ws.duplicateFile('note.md')
    expect(second.file.path).toBe('note (copy)-2.md')
    expect(third.file.path).toBe('note (copy)-3.md')
  })

  test('duplicates inside a folder stay in that folder', async () => {
    const ws = new Workspace(makeRoot())
    const copy = await ws.duplicateFile('chapters/one.md')
    expect(copy.file.path).toBe('chapters/one (copy).md')
  })
})

describe('createFolder', () => {
  test('creates and is idempotent (an existing folder is a success)', async () => {
    const ws = new Workspace(makeRoot())
    expect((await ws.createFolder('notes')).path).toBe('notes')
    expect((await ws.createFolder('notes')).path).toBe('notes')
    expect(existsSync(join(ws.root, 'notes'))).toBe(true)
  })

  test('sanitises each segment and rejects empty names', async () => {
    const ws = new Workspace(makeRoot())
    expect((await ws.createFolder(' drafts ')).path).toBe('drafts')
    await expect(ws.createFolder('   ')).rejects.toThrow('empty')
  })
})

describe('renameFolder', () => {
  test('renames in place and refuses collisions', async () => {
    const ws = new Workspace(makeRoot())
    await ws.createFolder('drafts')
    expect((await ws.renameFolder('drafts', 'sketches')).path).toBe('sketches')
    await ws.createFolder('drafts')
    await expect(ws.renameFolder('drafts', 'sketches')).rejects.toThrow('already exists')
  })

  test('refuses to rename a file as a folder', async () => {
    const ws = new Workspace(makeRoot())
    await expect(ws.renameFolder('note.md', 'other')).rejects.toThrow('Not a folder')
  })
})

describe('renameFile collision policy (unchanged, now user-facing)', () => {
  test('a rename must land exactly where pointed — collisions refuse', async () => {
    const ws = new Workspace(makeRoot())
    writeFileSync(join(ws.root, 'other.md'), 'x')
    await expect(ws.renameFile('note.md', 'other.md')).rejects.toThrow('already exists')
  })

  test('a missing source and an existing target produce clean file-operation messages', async () => {
    const ws = new Workspace(makeRoot())
    await expect(ws.renameFile('missing.md', 'other.md')).rejects.toThrow('File not found: missing.md')
    writeFileSync(join(ws.root, 'other.md'), 'Existing.\n')
    await expect(ws.renameFile('note.md', 'other.md')).rejects.toThrow('File already exists: other.md')
  })

  test('distinct hard-linked paths are still a collision', async () => {
    const root = makeRoot()
    const ws = new Workspace(root)
    await link(join(root, 'note.md'), join(root, 'hard-link.md'))

    await expect(ws.renameFile('note.md', 'hard-link.md')).rejects.toThrow('File already exists: hard-link.md')
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('# Note\n\nBody.\n')
    expect(await readFile(join(root, 'hard-link.md'), 'utf8')).toBe('# Note\n\nBody.\n')
  })

  test('the first case-only move uses a listable Markdown intermediate', async () => {
    const root = makeRoot()
    const ws = new Workspace(root)
    const probe = Bun.spawn([process.execPath, '-e', String.raw`
      import { mock } from 'bun:test'
      import * as fsPromises from 'node:fs/promises'
      import { rename as callbackRename } from 'node:fs'
      import { promisify } from 'node:util'
      const root = process.env.WF_CRASH_ROOT
      const realRename = promisify(callbackRename)
      let moves = 0
      void mock.module('node:fs/promises', () => ({
        ...fsPromises,
        rename: async (from, to) => {
          moves += 1
          await realRename(from, to)
          if (moves === 1) process.exit(23)
        },
      }))
      const { Workspace } = await import('./src/main/workspace.ts')
      await new Workspace(root).renameFile('note.md', 'NOTE.md')
    `], { cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, WF_CRASH_ROOT: root }, stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stderr] = await Promise.all([probe.exited, new Response(probe.stderr).text()])
    if (exitCode !== 23) throw new Error(`Crash probe exited ${exitCode}: ${stderr}`)
    const survivors = readdirSync(root).filter((name) => name.includes('rename-tmp'))
    expect(survivors).toHaveLength(1)
    expect(survivors[0]).toMatch(/\.md$/i)
    expect((await ws.listFiles()).map((file) => file.name)).toContain(survivors[0])
  })
})
