/**
 * Renames made in the app keep a Folio's own title and its comments (PR 307 review, 24 Nov 2026), through the real
 * rename doors on a real vault on disk:
 * - renaming a Folio's folder renames its Index Note with it (as the command line's folder move does), so the Folio
 *   keeps the title its Index Note declares, and a link to the Index Note follows it;
 * - renaming a part carries its waiting comment in the change ledger to the new name, so the Folio's Comments tab
 *   still lists it under that part.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeStore } from '../../src/main/changes'
import { renameFile, renameFolder } from '../../src/main/rename-doors'
import { VaultIndexService } from '../../src/main/vault-index-service'
import { Workspace } from '../../src/main/workspace'
import { folioComments } from '../../src/renderer/src/app/folio-comments'
import type { Change } from '../../src/preload'
import { renameDoorWorld } from '../helpers/rename-door-world'

const VAULT_JSON = JSON.stringify({ version: 1, name: 'Writing', pins: [] })

async function folioWorld() {
  const world = await renameDoorWorld()
  await world.write('.writeflex/vault.json', VAULT_JSON)
  await world.write('papers/alpha/_report-structure.json', JSON.stringify({ title: 'Fallback', files: [{ path: '01-intro.md' }] }))
  await world.write('papers/alpha/_alpha_INDEX.md', '---\ntitle: Alpha revised\n---\n\n# Index\n')
  await world.write('papers/alpha/README.md', '# What this folio is\n')
  await world.write('papers/alpha/01-intro.md', '# Introduction\n\nSome words here.\n')
  await world.write('notes.md', 'See [[_alpha_INDEX]] for the plan.\n')
  return world
}

/** The vault index as a fresh window reads it from disk. */
const indexOf = async (root: string) => (await new VaultIndexService({ cacheDir: mkdtempSync(join(tmpdir(), 'wf-rename-index-')) }).get(new Workspace(root)))!

describe('a Folio folder rename in the app', () => {
  test('renames the Index Note with the folder, so the Folio keeps its own title, and links follow it', async () => {
    const world = await folioWorld()
    expect((await indexOf(world.root)).labels['papers/alpha']).toBe('Alpha revised')

    const renamed = await renameFolder(world.deps, 'papers/alpha', 'beta')

    expect(renamed.path).toBe('papers/beta')
    expect(await world.exists('papers/beta/_beta_INDEX.md')).toBe(true)
    expect(await world.exists('papers/beta/_alpha_INDEX.md')).toBe(false)
    expect(await world.read('papers/beta/_beta_INDEX.md')).toContain('title: Alpha revised')
    expect((await indexOf(world.root)).labels['papers/beta']).toBe('Alpha revised')
    // The ledger, the Scratchpad and sharing hear of the Index Note's own move, after the folder's.
    expect(world.follows).toContainEqual(['ledger', 'papers/beta/_alpha_INDEX.md', 'papers/beta/_beta_INDEX.md'])
    expect(await world.read('notes.md')).not.toContain('_alpha_INDEX')
  })

  test('refuses, moving nothing, when the folder already holds a file with the Index Note\'s new name', async () => {
    const world = await folioWorld()
    await world.write('papers/alpha/_beta_INDEX.md', '# Something else\n')
    await expect(renameFolder(world.deps, 'papers/alpha', 'beta')).rejects.toThrow('already holds a file of that name')
    expect(await world.exists('papers/alpha/_alpha_INDEX.md')).toBe(true)
    expect(await world.exists('papers/beta')).toBe(false)
  })
})

describe('a part rename in the app', () => {
  test('carries the part\'s waiting comment to its new name, so the Comments tab still lists it there', async () => {
    const world = await folioWorld()
    const changes = new ChangeStore(world.workspace)
    world.deps.follow.ledger = async (from, to) => { await changes.followRename(from, to) }
    const base = { provenance: 'agent' as const, editClass: 'content' as const, category: null, isCorrection: false }
    const comment = await changes.add({ ...base, path: 'papers/alpha/01-intro.md', summary: 'Which words?', oldText: 'Some words', newText: 'Some words' })
    const settled = await changes.add({ ...base, path: 'papers/alpha/01-intro.md', summary: 'Done already', oldText: 'here', newText: 'here' })
    await changes.setStatus(settled.id, 'accepted')

    await renameFile(world.deps, 'papers/alpha/01-intro.md', 'papers/alpha/01-opening.md')

    const after = new Map((await changes.list()).map((change) => [change.id, change]))
    expect(after.get(comment.id)?.path).toBe('papers/alpha/01-opening.md')
    // A settled comment is history: it keeps the name it was settled under.
    expect(after.get(settled.id)?.path).toBe('papers/alpha/01-intro.md')
    const listed = folioComments({ pieces: [{ path: 'papers/alpha/01-opening.md', title: 'Introduction', headings: [] }], also: [] }, [...after.values()] as Change[])
    expect(listed.groups.map((group) => [group.path, group.rows.map((row) => row.text)])).toEqual([['papers/alpha/01-opening.md', ['Which words?']]])
  })
})
