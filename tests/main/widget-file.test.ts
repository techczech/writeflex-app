// A widget's file is read, and opened in the browser, only as the file that passed containment
// (security round 3, T2): the open descriptor is verified against the symlink-free real path, walked
// again without following anything, so a folder swapped for a symlink between the check and the open is
// refused. The race is staged with the test-only pause between resolving and opening.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWidgetFile, setWidgetFilePauseForTest } from '../../src/main/widget-file'
import { openWidgetFile, removeOpenedWidgetCopies } from '../../src/main/widget-open'

let base: string
let root: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-widget-file-'))
  root = join(base, 'workspace')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'demo.html'), '<title>inside</title>')
  await mkdir(join(base, 'outside'), { recursive: true })
  await writeFile(join(base, 'outside', 'demo.html'), '<title>SECRET outside</title>')
})
afterEach(async () => {
  setWidgetFilePauseForTest(null)
  await rm(base, { recursive: true, force: true })
})
afterAll(async () => { await removeOpenedWidgetCopies() })

/** Between resolving and opening: the `assets` folder is swapped for a symlink to the outside folder. */
const swapAncestor = async (): Promise<void> => {
  await rename(join(root, 'assets'), join(root, 'assets-moved'))
  await symlink(join(base, 'outside'), join(root, 'assets'))
}

test('the file that passed containment is read', async () => {
  const read = await readWidgetFile(root, 'doc.md', 'assets/demo.html')
  expect(read.ok && read.bytes.toString('utf8')).toBe('<title>inside</title>')
})

test('a folder swapped for a symlink to outside between the check and the open is refused', async () => {
  setWidgetFilePauseForTest(swapAncestor)
  const read = await readWidgetFile(root, 'doc.md', 'assets/demo.html')
  // On macOS the open itself refuses the symlinked ancestor (O_NOFOLLOW_ANY), before the descriptor walk runs.
  expect(read).toEqual({ ok: false, reason: process.platform === 'darwin' ? 'missing' : 'changed' })
})

test('the file itself swapped for a symlink is refused', async () => {
  setWidgetFilePauseForTest(async () => {
    await rm(join(root, 'assets', 'demo.html'))
    await symlink(join(base, 'outside', 'demo.html'), join(root, 'assets', 'demo.html'))
  })
  const read = await readWidgetFile(root, 'doc.md', 'assets/demo.html')
  expect(read.ok).toBe(false)
})

test('the file replaced in place by another file inside the workspace is still read (it is inside)', async () => {
  setWidgetFilePauseForTest(async () => {
    await writeFile(join(root, 'assets', 'new.html'), '<title>saved again</title>')
    await rename(join(root, 'assets', 'new.html'), join(root, 'assets', 'demo.html'))
  })
  const read = await readWidgetFile(root, 'doc.md', 'assets/demo.html')
  expect(read.ok && read.bytes.toString('utf8')).toBe('<title>saved again</title>')
})

test('Open file: the browser gets a private copy of the verified bytes, never a workspace path; the race is refused', async () => {
  const opened: string[] = []
  expect(await openWidgetFile(root, 'doc.md', 'assets/demo.html', (url) => opened.push(url))).toEqual({ ok: true })
  const copy = fileURLToPath(opened[0])
  expect(copy.startsWith(root)).toBe(false)
  expect(await readFile(copy, 'utf8')).toBe('<title>inside</title>')
  expect((await stat(join(copy, '..'))).mode & 0o777).toBe(0o700)
  expect((await stat(copy)).mode & 0o777).toBe(0o600)
  setWidgetFilePauseForTest(swapAncestor)
  expect(await openWidgetFile(root, 'doc.md', 'assets/demo.html', (url) => opened.push(url))).toEqual({ ok: false })
  expect(opened.length).toBe(1)
  await removeOpenedWidgetCopies()
  await expect(stat(copy)).rejects.toThrow()
})

// Darwin only: the kernel refuses an open whose path has a symlink in any component (O_NOFOLLOW_ANY, which
// widget-file.ts uses on macOS). There is no hook that disables the descriptor walk, so this asserts the open
// itself: with the ancestor swapped, the open fails with ELOOP.
const O_NOFOLLOW_ANY = 0x20000000
test.skipIf(process.platform !== 'darwin')('an open with O_NOFOLLOW_ANY fails with ELOOP when an ancestor folder is a symlink', async () => {
  await rename(join(root, 'assets'), join(root, 'assets-moved'))
  await symlink(join(base, 'outside'), join(root, 'assets'))
  const { open } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  let code: string | undefined
  try {
    const handle = await open(join(root, 'assets', 'demo.html'), constants.O_RDONLY | O_NOFOLLOW_ANY)
    await handle.close()
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code
  }
  expect(code).toBe('ELOOP')
})
