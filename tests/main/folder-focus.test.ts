import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings'
import { Workspace } from '../../src/main/workspace'
import {
  applyFolderFocus,
  describeFolderFocus,
  folderFocusKind,
  normaliseFocusPath,
  restoreFolderFocus,
} from '../../src/main/folder-focus'
import { MANIFEST_NAME } from '../../src/main/folio'

/**
 * Focus a folder (ticket 03): the focus is a workspace-relative folder path on the root's recents
 * entry in main's settings — the record that reopens the root — so it survives a relaunch, and a
 * folder that has gone clears silently on the next bind.
 */

let dir: string
let root: string
let settingsPath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wf-folder-focus-'))
  root = join(dir, 'writing')
  settingsPath = join(dir, 'userData', 'settings.json')
  await mkdir(join(root, 'talks', 'ai-2026', 'parts'), { recursive: true })
  await writeFile(join(root, 'talks', 'ai-2026', 'parts', '01.md'), '# Opening')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('a focus written for a root survives a relaunch of the store and a reopen of the root', async () => {
  const settings = new SettingsStore(settingsPath)
  settings.touchRecent(root)
  const ws = new Workspace(root)
  expect(applyFolderFocus(settings, ws, 'talks/ai-2026')).toBe('talks/ai-2026')

  // Relaunch: a fresh store reads the file; opening the root again touches its recent first.
  const relaunched = new SettingsStore(settingsPath)
  relaunched.touchRecent(root)
  expect(restoreFolderFocus(relaunched, new Workspace(root))).toBe('talks/ai-2026')
  expect(JSON.parse(await readFile(settingsPath, 'utf8')).recents[0]).toMatchObject({ root, focus: 'talks/ai-2026' })
})

test('clearing the focus removes it from the record', () => {
  const settings = new SettingsStore(settingsPath)
  settings.touchRecent(root)
  const ws = new Workspace(root)
  applyFolderFocus(settings, ws, 'talks')
  expect(applyFolderFocus(settings, ws, null)).toBeNull()
  expect(new SettingsStore(settingsPath).folderFocus(root)).toBeNull()
  expect(new SettingsStore(settingsPath).recents()[0]).toEqual({ root, openedAt: expect.any(Number) })
})

test('a focused folder deleted between sessions clears silently on the next bind', async () => {
  const settings = new SettingsStore(settingsPath)
  settings.touchRecent(root)
  applyFolderFocus(settings, new Workspace(root), 'talks/ai-2026')
  await rm(join(root, 'talks', 'ai-2026'), { recursive: true, force: true })

  const relaunched = new SettingsStore(settingsPath)
  expect(restoreFolderFocus(relaunched, new Workspace(root))).toBeNull()
  expect(new SettingsStore(settingsPath).folderFocus(root)).toBeNull()
})

test('each root keeps its own focus; one window never sees another root\'s', async () => {
  const other = join(dir, 'other')
  await mkdir(join(other, 'notes'), { recursive: true })
  const settings = new SettingsStore(settingsPath)
  settings.touchRecent(root)
  settings.touchRecent(other)
  applyFolderFocus(settings, new Workspace(root), 'talks')
  applyFolderFocus(settings, new Workspace(other), 'notes')
  expect(restoreFolderFocus(settings, new Workspace(root))).toBe('talks')
  expect(restoreFolderFocus(settings, new Workspace(other))).toBe('notes')
})

test('the renderer cannot focus a file, a missing folder, or a path outside the Workspace', async () => {
  const settings = new SettingsStore(settingsPath)
  settings.touchRecent(root)
  const ws = new Workspace(root)
  expect(() => applyFolderFocus(settings, ws, 'talks/ai-2026/parts/01.md')).toThrow('Not a folder')
  expect(() => applyFolderFocus(settings, ws, 'nowhere')).toThrow('Not a folder')
  expect(() => applyFolderFocus(settings, ws, '../elsewhere')).toThrow('workspace-relative')
  expect(() => applyFolderFocus(settings, ws, '/etc')).toThrow('workspace-relative')
  expect(() => applyFolderFocus(settings, ws, 42)).toThrow('workspace-relative')
  expect(settings.folderFocus(root)).toBeNull()
  // The root itself is not a focus: it clears.
  applyFolderFocus(settings, ws, 'talks')
  expect(applyFolderFocus(settings, ws, '')).toBeNull()
})

test('focus paths are normalised to their stored form', () => {
  expect(normaliseFocusPath('talks/ai-2026/')).toBe('talks/ai-2026')
  expect(() => normaliseFocusPath('talks//ai-2026')).toThrow()
  expect(() => normaliseFocusPath('talks/./ai-2026')).toThrow()
})

test('reopening a root keeps its focus, and a corrupt record is dropped on load', async () => {
  const settings = new SettingsStore(settingsPath)
  settings.touchRecent(root)
  settings.setFolderFocus(root, 'talks')
  settings.touchRecent(join(dir, 'x'))
  settings.touchRecent(root)
  expect(settings.folderFocus(root)).toBe('talks')

  await writeFile(settingsPath, JSON.stringify({ recents: [{ root, openedAt: 1, focus: 7 }] }))
  expect(new SettingsStore(settingsPath).folderFocus(root)).toBeNull()
})

test('the kind picks the Search switch label: a Folio, a folder with an Index Note, a plain folder', async () => {
  const ws = new Workspace(root)
  expect(await folderFocusKind(ws, 'talks')).toBe('folder')
  await writeFile(join(root, 'talks', '_talks_INDEX.md'), '# Talks')
  expect(await folderFocusKind(ws, 'talks')).toBe('collection')
  await writeFile(join(root, 'talks', 'ai-2026', MANIFEST_NAME), JSON.stringify({ files: [] }))
  expect(await describeFolderFocus(ws, 'talks/ai-2026')).toEqual({ path: 'talks/ai-2026', kind: 'folio' })
  expect(await describeFolderFocus(ws, null)).toBeNull()
})
