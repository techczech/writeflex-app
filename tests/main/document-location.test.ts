import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDocumentLocation } from '../../src/main/document-location'
import { Workspace } from '../../src/main/workspace'

let fixture: string
let workspace: Workspace
const shell = {
  openPath: mock(async (_path: string) => ''),
  showItemInFolder: mock((_path: string) => {}),
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'wf-document-location-'))
  const root = join(fixture, 'vault')
  mkdirSync(join(root, 'Reference.bundle'), { recursive: true })
  writeFileSync(join(fixture, 'outside.md'), '# Outside')
  writeFileSync(join(root, 'notes.md'), '# Notes')
  writeFileSync(join(root, 'plain.txt'), 'Plain text')
  writeFileSync(join(root, 'Reference.bundle', 'notes.md'), '# Notes in a package directory')
  symlinkSync('plain.txt', join(root, 'plain-link.md'))
  symlinkSync('notes.md', join(root, 'notes-link.md'))
  symlinkSync('../outside.md', join(root, 'outside-link.md'))
  workspace = new Workspace(root)
  shell.openPath.mockClear()
  shell.showItemInFolder.mockClear()
})

afterEach(() => rmSync(fixture, { recursive: true, force: true }))

test.each([
  ['an absolute path within the vault', () => join(workspace.root, 'notes.md')],
  ['a non-Markdown path', () => 'plain.txt'],
  ['a Markdown alias for an in-vault non-Markdown file', () => 'plain-link.md'],
  ['a package directory itself', () => 'Reference.bundle'],
  ['traversal outside the vault', () => '../outside.md'],
  ['a Markdown alias for a file outside the vault', () => 'outside-link.md'],
] as const)('refuses %s before either shell action', async (_label, path) => {
  for (const action of ['default-app', 'containing-folder'] as const) {
    await expect(openDocumentLocation(workspace, { path: path(), location: action }, shell)).rejects.toThrow(/open vault/)
  }
  expect(shell.openPath).not.toHaveBeenCalled()
  expect(shell.showItemInFolder).not.toHaveBeenCalled()
})

test('opens the canonical path of a valid Markdown alias', async () => {
  await openDocumentLocation(workspace, { path: 'notes-link.md', location: 'default-app' }, shell)
  expect(shell.openPath).toHaveBeenCalledWith(realpathSync(join(workspace.root, 'notes.md')))
  expect(shell.openPath).toHaveBeenCalledTimes(1)
  expect(shell.showItemInFolder).not.toHaveBeenCalled()
})

test('reveals the document inside a package parent without opening the package', async () => {
  const path = 'Reference.bundle/notes.md'
  await openDocumentLocation(workspace, { path, location: 'containing-folder' }, shell)
  expect(shell.showItemInFolder).toHaveBeenCalledWith(join(workspace.root, path))
  expect(shell.showItemInFolder).toHaveBeenCalledTimes(1)
  expect(shell.openPath).not.toHaveBeenCalled()
})
