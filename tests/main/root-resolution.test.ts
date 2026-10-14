import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveWorkspaceRoot, normaliseRoot, WorkspaceRootError, LIBRARY_MARKER_DIR } from '../../src/main/root-resolution'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'wf-home-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function makeTree(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (p.endsWith('/')) await mkdir(join(home, p), { recursive: true })
    else { await mkdir(join(home, p, '..'), { recursive: true }); await writeFile(join(home, p), '') }
  }
}

test('library marker wins over closer .git', async () => {
  await makeTree([`proj/${LIBRARY_MARKER_DIR}/`, 'proj/sub/.git/', 'proj/sub/deep/'])
  await writeFile(join(home, 'proj/sub/deep/note.md'), '')
  expect(resolveWorkspaceRoot(join(home, 'proj/sub/deep/note.md'), { home })).toBe(join(home, 'proj'))
})

test('.bridle wins over .git; .git found when a plain file (worktree)', async () => {
  await makeTree(['a/.git/', 'a/b/.bridle/', 'a/b/c/'])
  await writeFile(join(home, 'a/b/c/note.md'), '')
  expect(resolveWorkspaceRoot(join(home, 'a/b/c/note.md'), { home })).toBe(join(home, 'a/b'))
  await makeTree(['w/x/'])
  await writeFile(join(home, 'w/.git'), 'gitdir: elsewhere')
  await writeFile(join(home, 'w/x/note.md'), '')
  expect(resolveWorkspaceRoot(join(home, 'w/x/note.md'), { home })).toBe(join(home, 'w'))
})

test('no markers → immediate parent', async () => {
  await makeTree(['plain/dir/'])
  await writeFile(join(home, 'plain/dir/note.md'), '')
  expect(resolveWorkspaceRoot(join(home, 'plain/dir/note.md'), { home })).toBe(join(home, 'plain/dir'))
})

test('markers in home itself are ignored; file directly in home throws', async () => {
  await makeTree([`${LIBRARY_MARKER_DIR}/`, 'solo/'])
  await writeFile(join(home, 'solo/note.md'), '')
  expect(resolveWorkspaceRoot(join(home, 'solo/note.md'), { home })).toBe(join(home, 'solo'))
  await writeFile(join(home, 'top.md'), '')
  expect(() => resolveWorkspaceRoot(join(home, 'top.md'), { home })).toThrow(WorkspaceRootError)
})

test('normaliseRoot: symlinked dir resolves to its physical target', async () => {
  await makeTree(['real/target/'])
  const link = join(home, 'link')
  await symlink(join(home, 'real/target'), link)
  expect(normaliseRoot(link)).toBe(realpathSync(join(home, 'real/target')))
})

test('normaliseRoot: nonexistent path falls back to resolve()', () => {
  const missing = join(home, 'nope', 'deep')
  expect(normaliseRoot(missing)).toBe(resolve(missing))
})
