import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/main/cli/run'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { INTRO, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// Ticket 04, "Carried from ticket 09": which roots may be written, check-then-use, the shared write
// gate; and the owner lock confirmed before each file of a multi-file operation.
let fx: WriteFixture
let aside: string
beforeEach(async () => {
  fx = await writeFixture()
  aside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-aside-')))
})
afterEach(async () => {
  await fx.dispose()
  await rm(aside, { recursive: true, force: true })
})

test('a discovered root is written only when the app has opened it (recent or pinned); --root always may', async () => {
  // A fake home: nothing here reads the real settings file.
  const home = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-home-')))
  try {
    const collection = join(home, 'work', 'collection')
    await mkdir(join(collection, '.writeflex'), { recursive: true })
    await mkdir(join(collection, 'talks'))
    const settings = join(home, 'Library', 'Application Support', 'writeflex-desktop', 'settings.json')
    const beta = join(home, 'Library', 'Application Support', 'writeflex-desktop-beta', 'settings.json')
    await mkdir(join(settings, '..'), { recursive: true })
    await mkdir(join(beta, '..'), { recursive: true })
    const create = async (name: string, argv: string[] = []): Promise<{ code: number; json: { rootSource?: string; error?: { code: string; message: string } } }> => {
      let out = ''
      const code = await runCli([...argv, '--json', 'create', name], { cwd: join(collection, 'talks'), home, stdout: (t) => { out += t }, stderr: () => {} })
      return { code, json: JSON.parse(out) }
    }

    const unlisted = await create('one.md')
    expect(unlisted.code).toBe(1)
    expect(unlisted.json).toMatchObject({ rootSource: 'discovered', error: { code: 'root-not-chosen' } })
    expect(unlisted.json.error!.message).toContain('WriteFlex has never opened it')
    expect(unlisted.json.error!.message).toContain(`writeflex --root "${collection}"`)
    expect(existsSync(join(collection, 'one.md'))).toBe(false)
    expect(await readdir(join(collection, '.writeflex'))).toEqual([]) // refused before the lock is touched

    // Listed for another folder, or an unreadable settings file: still refused. Reading stays allowed.
    await writeFile(settings, JSON.stringify({ recents: [{ root: join(home, 'work'), openedAt: 1 }], pinned: [join(home, 'other')] }))
    await writeFile(beta, '{ not json')
    expect((await create('one.md')).code).toBe(1)
    let listing = ''
    expect(await runCli(['--json', 'files'], { cwd: join(collection, 'talks'), home, stdout: (t) => { listing += t }, stderr: () => {} })).toBe(0)

    await writeFile(settings, JSON.stringify({ recents: [{ root: collection, openedAt: 1 }], pinned: [] }))
    expect((await create('recent.md')).code).toBe(0)
    await writeFile(settings, JSON.stringify({ recents: [], pinned: [] }))
    await writeFile(beta, JSON.stringify({ recents: [], pinned: [collection] }))
    expect((await create('pinned.md')).code).toBe(0)
    await writeFile(beta, JSON.stringify({ recents: [], pinned: [] }))
    expect((await create('two.md')).code).toBe(1)
    const given = await create('given.md', ['--root', collection])
    expect(given.json.rootSource).toBe('given')
    expect(given.code).toBe(0)
    // `.bridle` holds the version each create saved to record itself (cli/agent-created-hook.ts).
    expect((await readdir(collection)).sort()).toEqual(['.bridle', '.writeflex', 'given.md', 'pinned.md', 'recent.md', 'talks'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a link planted between the check and the write is not followed: creating a document', async () => {
  for (const target of [join(fx.root, '.writeflex'), aside]) {
    await mkdir(join(fx.root, 'drafts'))
    const before = { stores: await readdir(join(fx.root, '.writeflex')), aside: await readdir(aside) }
    let swaps = 0
    const result = await fx.cli(['create', 'drafts/new.md', '--content', 'secret draft'], {
      write: { seams: { betweenCheckAndWrite: async (path) => {
        if (path !== 'drafts/new.md') return
        swaps++
        await rename(join(fx.root, 'drafts'), join(fx.root, 'drafts-real'))
        await symlink(target, join(fx.root, 'drafts'))
      } } },
    })
    expect(swaps).toBe(1)
    expect(result.code).toBe(1)
    expect(result.json.error!.message).toContain('a link now stands where the folder was')
    // Nothing landed at the far end of the link, not even the temporary file, and nothing in the real folder.
    expect((await readdir(join(fx.root, '.writeflex'))).filter((name) => name !== 'owner.lock')).toEqual(before.stores)
    expect(await readdir(aside)).toEqual(before.aside)
    expect(await readdir(join(fx.root, 'drafts-real'))).toEqual([])
    await rm(join(fx.root, 'drafts'))
    await rm(join(fx.root, 'drafts-real'), { recursive: true })
  }
})

test('a link planted between the check and the write is not followed: rewriting a document and moving one', async () => {
  // Rewrite: the folder of a document being repaired is swapped for a link to a look-alike outside.
  await writeFile(join(aside, 'intro.md'), INTRO)
  const rewritten = await fx.cli(['move', 'talks/york.md', 'york-2026.md'], {
    write: { seams: { betweenCheckAndWrite: async (path) => {
      if (path !== 'talks/intro.md' || existsSync(join(fx.root, 'talks-real'))) return
      await rename(join(fx.root, 'talks'), join(fx.root, 'talks-real'))
      await symlink(aside, join(fx.root, 'talks'))
    } } },
  })
  expect(rewritten.code).toBe(1)
  expect(await readdir(aside)).toEqual(['intro.md'])
  expect(await readFile(join(aside, 'intro.md'), 'utf8')).toBe(INTRO)
  expect(await readFile(join(fx.root, 'talks-real', 'intro.md'), 'utf8')).toBe(INTRO)
  await rm(join(fx.root, 'talks'))
  await rename(join(fx.root, 'talks-real'), join(fx.root, 'talks'))

  // Move: the folder to move into is swapped for a link to the app's own folder.
  await mkdir(join(fx.root, 'archive'))
  const stores = await readdir(join(fx.root, '.writeflex'))
  const moved = await fx.cli(['move', 'notes.md', 'archive/notes.md'], {
    write: { seams: { betweenCheckAndWrite: async (path) => {
      if (path !== 'notes.md') return
      await rename(join(fx.root, 'archive'), join(fx.root, 'archive-real'))
      await symlink(join(fx.root, '.writeflex'), join(fx.root, 'archive'))
    } } },
  })
  expect(moved.code).toBe(1)
  expect(moved.json.error!.message).toContain('a link now stands where the folder was')
  expect(existsSync(join(fx.root, 'notes.md'))).toBe(true)
  expect((await readdir(join(fx.root, '.writeflex'))).filter((name) => name !== 'owner.lock')).toEqual(stores)
})

test('a document that is itself a link is never written through, read for copying, moved or trashed', async () => {
  await writeFile(join(aside, 'target.md'), 'outside text [[york]]\n')
  await symlink(join(aside, 'target.md'), join(fx.root, 'escape.md'))
  await symlink(join(aside, 'not-there.md'), join(fx.root, 'dangling.md'))
  await symlink(join(fx.root, 'notes.md'), join(fx.root, 'alias.md'))
  const before = await fx.snapshot({ journal: true })
  for (const argv of [
    ['create', 'dangling.md', '--content', 'x'], ['create', 'alias.md', '--content', 'x'], ['duplicate', 'alias.md'], ['duplicate', 'escape.md'],
    ['move', 'alias.md', 'renamed.md'], ['trash', 'alias.md'], ['trash', 'escape.md'], ['scrap', 'escape.md', '--text', 'x'],
  ]) {
    const result = await fx.cli(argv)
    expect(result.code, argv.join(' ')).toBe(1)
  }
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect(await readdir(aside)).toEqual(['target.md'])
  expect(await readdir(fx.trashed)).toEqual([])
})

// An operation that loses the owner lock partway stops and writes nothing more, putting back included:
// tests/main/cli-rollback-lost-lock.test.ts.

test('every write asks the shared Collection write gate', async () => {
  expect((await fx.cli(['scrap', 'notes.md', '--text', 'before the pause'])).code).toBe(0)
  expect((await fx.cli(['scrap', 'notes.md', '--text', 'journalled'])).code).toBe(0)
  const before = await fx.snapshot({ journal: true })
  pauseCollectionWrites(fx.root, 'Saving is paused for this test.')
  try {
    for (const argv of [
      ['create', 'x.md'], ['create-folder', 'f'], ['duplicate', 'notes.md'], ['note', 'notes.md', '--body', 'n'], ['scrap', 'notes.md', '--text', 's'],
      ['move', 'talks/york.md', 'y.md'], ['move-folder', 'talks', 'events'], ['trash', 'notes.md'], ['create-manifest', 'scraps'], ['undo'], ['save-version', 'notes.md', '--name', 'Paused'],
      ['export', 'notes.md', '--to', join(fx.root, 'out.html'), '--confirm'],
    ]) {
      const result = await fx.cli(argv)
      expect(result.code, argv.join(' ')).toBe(1)
      expect(result.json.error!.message, argv.join(' ')).toContain('Saving is paused for this test.')
    }
    expect(await fx.snapshot({ journal: true })).toEqual(before)
    expect(await readdir(fx.trashed)).toEqual([])
  } finally {
    resumeCollectionWrites(fx.root)
  }
})

test('a Collection whose .writeflex is a link is not changed by the command line, and nothing is written where the link points', async () => {
  const target = join(aside, 'target')
  await mkdir(target)
  await rename(join(fx.root, '.writeflex'), join(aside, 'real-writeflex'))
  await symlink(target, join(fx.root, '.writeflex'))
  const before = await readdir(fx.root)
  for (const argv of [['create', 'new.md'], ['move', 'talks/york.md', 'talks/york-2026.md']]) {
    const result = await fx.cli(argv)
    expect(result.code, argv.join(' ')).toBe(1)
    expect(result.json.error).toMatchObject({ code: 'write-not-permitted' })
    expect(result.json.error!.message).toContain('cannot be marked as in use')
  }
  expect(await readdir(target)).toEqual([])
  expect(await readdir(fx.root)).toEqual(before)
  expect(existsSync(join(fx.root, 'talks', 'york.md'))).toBe(true)
})
