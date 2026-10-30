import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import { ScratchpadStore, scratchpadStoreSeams } from '../../src/main/scratchpad-store'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { storeWriteSeams } from '../../src/main/checked-store-write'
import { MANIFEST_NAME } from '../../src/shared/folio-constants'
import { isPlaced } from '../../src/shared/scratchpad-items'

// The guarded workspace persistence seam of the floating Scratchpad (ticket 01): exact Markdown
// payloads and item metadata under .writeflex, a non-migrating reader over existing SCRAPS.md files,
// and link resolution from the recorded origin. Every assertion reads real bytes from a temporary folder.

let root: string
let ws: Workspace
let scraps: ScrapStore
let store: ScratchpadStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-scratchpad-'))
  ws = new Workspace(root)
  scraps = new ScrapStore(ws)
  store = new ScratchpadStore(ws, scraps)
  await mkdir(join(root, 'book', 'part-a'), { recursive: true })
  await mkdir(join(root, 'book', 'part-b'), { recursive: true })
  await writeFile(join(root, 'book', 'part-a', 'one.md'), '# One\n', 'utf8')
  await writeFile(join(root, 'book', 'part-b', 'two.md'), '# Two\n', 'utf8')
  await writeFile(join(root, 'notes.md'), '# Notes\n', 'utf8')
})
afterEach(async () => {
  scratchpadStoreSeams.afterDiscardRead = undefined
  storeWriteSeams.beforePromote = undefined
  storeWriteSeams.afterContentCheck = undefined
  storeWriteSeams.afterTempWrite = undefined
  resumeCollectionWrites(root)
  await rm(root, { recursive: true, force: true })
})

const storeFiles = async (): Promise<string[]> =>
  existsSync(join(root, '.writeflex')) ? (await readdir(join(root, '.writeflex'))).filter((name) => name.startsWith('scratchpad')).sort() : []

// A section with everything the legacy grammar loses: boundary blank lines, a reserved-looking
// `## s_…` line inside a fence, CRLF, trailing spaces, nested lists, a table, a link and an image.
const RICH = '\r\n\r\n## What the second round added\r\n\r\nEach round had a **different job**:  \r\n\r\n1. *Meaning*\r\n   - nested [guide](../guide.md)\r\n\r\n```md\r\n## s_abc123\r\nnot a scrap\r\n```\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n![sketch](figures/loop.png)\r\n\r\n\r\n'

describe('exact payloads', () => {
  test('a sent copy keeps every byte, including CRLF, boundary blank lines and a fenced reserved heading', async () => {
    const item = await store.addText({ origin: 'book/part-a/one.md', markdown: RICH, how: 'copy', by: 'writer', heading: 'One' })
    const got = await store.get(item.id)
    expect(got.markdown).toBe(RICH)
    const payload = (await storeFiles()).find((name) => name.endsWith('.md'))!
    expect(Buffer.compare(await readFile(join(root, '.writeflex', payload)), Buffer.from(RICH, 'utf8'))).toBe(0)
    const listed = (await store.list({ activePath: 'book/part-a/one.md' })).items.find((entry) => entry.id === item.id)!
    expect(listed).toMatchObject({ source: 'lossless', how: 'copy', status: 'active', origin: { path: 'book/part-a/one.md', heading: 'One' } })
    expect(listed.markdown).toBe(RICH)
    // Nothing went into the legacy grammar.
    expect(existsSync(join(root, 'book', 'part-a', 'scraps'))).toBe(false)
  })

  test('a copy is promoted to a cut only by confirmCut; a cut is never recorded before that', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Text.', how: 'copy', by: 'writer' })
    expect((await store.get(item.id)).how).toBe('copy')
    await store.confirmCut(item.id)
    expect((await store.get(item.id)).how).toBe('cut')
  })

  test('twenty concurrent sends all land, each with its own exact payload', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `Fragment ${i}\n\n- item ${i}\n`)
    const added = await Promise.all(texts.map((markdown) => store.addText({ origin: 'notes.md', markdown, how: 'copy', by: 'writer' })))
    expect(new Set(added.map((item) => item.id)).size).toBe(20)
    const listed = (await store.list({ activePath: 'notes.md' })).items.filter((item) => item.source === 'lossless')
    expect(listed.map((item) => item.markdown).sort()).toEqual([...texts].sort())
  })

  test('a paused Collection refuses the write and leaves no file behind', async () => {
    pauseCollectionWrites(root, 'Another WriteFlex window owns this folder.')
    await expect(store.addText({ origin: 'notes.md', markdown: 'Keep me.', how: 'copy', by: 'writer' })).rejects.toThrow('Another WriteFlex window owns this folder.')
    expect(await storeFiles()).toEqual([])
  })

  test('an origin outside the workspace or not a Markdown document is refused', async () => {
    await expect(store.addText({ origin: '../outside.md', markdown: 'x', how: 'copy', by: 'writer' })).rejects.toThrow()
    await expect(store.addText({ origin: '/etc/passwd', markdown: 'x', how: 'copy', by: 'writer' })).rejects.toThrow()
    await expect(store.addText({ origin: 'notes.txt', markdown: 'x', how: 'copy', by: 'writer' })).rejects.toThrow()
    expect(await storeFiles()).toEqual([])
  })
})

describe('status, groups and uses', () => {
  test('reject and restore change status only; the payload stays byte-identical', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: RICH, how: 'copy', by: 'writer' })
    await store.setStatus([item.id], 'rejected')
    expect((await store.get(item.id)).status).toBe('rejected')
    await store.setStatus([item.id], 'active')
    expect((await store.get(item.id)).status).toBe('active')
    expect((await store.get(item.id)).markdown).toBe(RICH)
  })

  test('a group is created once and items move into it', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'x', how: 'copy', by: 'writer' })
    const group = await store.createGroup('References')
    await store.setGroup([item.id], group.id)
    const snapshot = await store.list({ activePath: 'notes.md' })
    expect(snapshot.groups).toEqual([group])
    expect(snapshot.items.find((entry) => entry.id === item.id)!.group).toBe(group.id)
  })

  test('a put-back use places the item; dropping it returns the item to the candidates, payload retained', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Cut words.', how: 'copy', by: 'writer' })
    await store.confirmCut(item.id)
    await store.recordUse(item.id, { useId: 'u_first1', path: 'book/part-a/one.md', mode: 'put-back' })
    expect((await store.get(item.id)).uses.map((use) => use.mode)).toEqual(['put-back'])
    await store.dropUse(item.id, 'u_first1')
    const back = await store.get(item.id)
    expect(back.uses).toEqual([])
    expect(back.markdown).toBe('Cut words.')
  })
})

describe('two writers on one folder', () => {
  test('a record changed by another window mid-update is not overwritten: the update is refused', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Shared.', how: 'copy', by: 'writer' })
    const other = new ScratchpadStore(new Workspace(root), new ScrapStore(new Workspace(root)))
    const recordPath = join(root, '.writeflex', `scratchpad-item-${item.id}.json`)
    const group = await store.createGroup('Later')
    let theirs = ''
    storeWriteSeams.beforePromote = async () => {
      storeWriteSeams.beforePromote = undefined
      await other.setStatus([item.id], 'rejected') // the other window lands first
      theirs = await readFile(recordPath, 'utf8')
    }
    try {
      await expect(store.setGroup([item.id], group.id)).rejects.toThrow('changed by another program')
    } finally {
      storeWriteSeams.beforePromote = undefined
    }
    expect(await readFile(recordPath, 'utf8')).toBe(theirs)
    expect(await store.get(item.id)).toMatchObject({ status: 'rejected', group: null })
  })
})

describe('existing scraps through the non-migrating adapter', () => {
  const LEGACY = '## s_a {sig} (#b97d10)\nKind regards,\nDominik\n\n## s_b [x]\nCheck the quotes.\n'

  test('legacy scraps are listed with done, colour and trigger, as Saved scrap of unknown capture, and their file is not rewritten', async () => {
    await mkdir(join(root, 'scraps'), { recursive: true })
    await writeFile(join(root, 'scraps', 'notes-SCRAPS.md'), LEGACY, 'utf8')
    const snapshot = await store.list({ activePath: 'notes.md' })
    const legacy = snapshot.items.filter((item) => item.source === 'legacy')
    expect(legacy.map((item) => [item.markdown, item.done, item.colour ?? null, item.expandTrigger ?? null, item.how])).toEqual([
      ['Kind regards,\nDominik', false, '#b97d10', 'sig', null],
      ['Check the quotes.', true, null, null, null],
    ])
    expect(await readFile(join(root, 'scraps', 'notes-SCRAPS.md'), 'utf8')).toBe(LEGACY)
  })

  test('rejecting a legacy scrap is recorded beside it; its SCRAPS.md stays byte-identical', async () => {
    await mkdir(join(root, 'scraps'), { recursive: true })
    await writeFile(join(root, 'scraps', 'notes-SCRAPS.md'), LEGACY, 'utf8')
    const [first] = (await store.list({ activePath: 'notes.md' })).items
    await store.setStatus([first.id], 'rejected')
    const again = (await store.list({ activePath: 'notes.md' })).items.find((item) => item.id === first.id)!
    expect(again.status).toBe('rejected')
    expect(await readFile(join(root, 'scraps', 'notes-SCRAPS.md'), 'utf8')).toBe(LEGACY)
  })

  test('done and colour on a legacy scrap still go to its own heading line (the existing contract)', async () => {
    await mkdir(join(root, 'scraps'), { recursive: true })
    await writeFile(join(root, 'scraps', 'notes-SCRAPS.md'), LEGACY, 'utf8')
    const [first] = (await store.list({ activePath: 'notes.md' })).items
    await store.toggleDone(first.id)
    expect(await readFile(join(root, 'scraps', 'notes-SCRAPS.md'), 'utf8')).toBe('## s_a [x] {sig} (#b97d10)\nKind regards,\nDominik\n\n## s_b [x]\nCheck the quotes.\n')
  })
})

describe('damaged records are visible and preserved', () => {
  test('corrupt metadata is reported, its files are left as they are, and other items still list', async () => {
    const good = await store.addText({ origin: 'notes.md', markdown: 'Good.', how: 'copy', by: 'writer' })
    const bad = await store.addText({ origin: 'notes.md', markdown: 'Bad record.', how: 'copy', by: 'writer' })
    const metaName = (await storeFiles()).find((name) => name.includes(bad.id) && name.endsWith('.json'))!
    await writeFile(join(root, '.writeflex', metaName), '{ not json', 'utf8')
    const snapshot = await store.list({ activePath: 'notes.md' })
    expect(snapshot.items.map((item) => item.id)).toEqual([good.id])
    expect(snapshot.notices.join('\n')).toContain(metaName)
    expect(await readFile(join(root, '.writeflex', metaName), 'utf8')).toBe('{ not json')
    const payloadName = (await storeFiles()).find((name) => name.includes(bad.id) && name.endsWith('.md'))!
    expect(await readFile(join(root, '.writeflex', payloadName), 'utf8')).toBe('Bad record.')
  })

  test('a payload changed outside the app is shown as it now is, with a problem note, never rewritten', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Original.', how: 'copy', by: 'writer' })
    const payloadName = (await storeFiles()).find((name) => name.includes(item.id) && name.endsWith('.md'))!
    await writeFile(join(root, '.writeflex', payloadName), 'Edited elsewhere.', 'utf8')
    const got = await store.get(item.id)
    expect(got.markdown).toBe('Edited elsewhere.')
    expect(got.problem).toBeTruthy()
  })
})

describe('scope and origin-relative links', () => {
  test('the snapshot names the Folio folder of the asking document', async () => {
    await writeFile(join(root, 'book', MANIFEST_NAME), JSON.stringify({ files: [] }), 'utf8')
    expect((await store.list({ activePath: 'book/part-b/two.md' })).folioDir).toBe('book')
    expect((await store.list({ activePath: 'notes.md' })).folioDir).toBeNull()
  })

  test('insertion in the origin folder keeps the Markdown exactly', async () => {
    const item = await store.addText({ origin: 'book/part-a/one.md', markdown: RICH, how: 'copy', by: 'writer' })
    const prepared = await store.prepareInsert(item.id, 'book/part-a/one.md')
    expect(prepared).toEqual({ ok: true, markdown: RICH, rewritten: 0 })
  })

  test('insertion in another folder rewrites relative links and images from the origin, leaving code alone', async () => {
    const source = 'See [guide](../guide.md) and ![loop](figures/loop.png).\n\n```\n[raw](figures/loop.png)\n```\n'
    const item = await store.addText({ origin: 'book/part-a/one.md', markdown: source, how: 'copy', by: 'writer' })
    const prepared = await store.prepareInsert(item.id, 'notes.md')
    expect(prepared).toEqual({ ok: true, markdown: 'See [guide](book/guide.md) and ![loop](book/part-a/figures/loop.png).\n\n```\n[raw](figures/loop.png)\n```\n', rewritten: 2 })
  })

  test('a link that leaves the workspace cannot be carried to another folder: the insert is refused', async () => {
    const item = await store.addText({ origin: 'book/part-a/one.md', markdown: 'Out [there](../../../elsewhere.md).', how: 'copy', by: 'writer' })
    const prepared = await store.prepareInsert(item.id, 'notes.md')
    expect(prepared.ok).toBe(false)
  })
})

// F1: Send a copy's Undo withdraws metadata only, preserving both files with the store's ownership and
// version checks. Each interleaving is driven deterministically through a seam: a second window with its
// own Workspace (so not ordered with this one) or another program acts at the instant named.
describe('taking back a copy: checked withdrawal (F1)', () => {
  const other = (): ScratchpadStore => new ScratchpadStore(new Workspace(root), new ScrapStore(new Workspace(root)))
  const filesOf = async (id: string): Promise<string[]> => (await readdir(join(root, '.writeflex'))).filter((name) => name.includes(id)).sort()

  test('an unused copy is unavailable, retaining its record and exact payload', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Gone soon.', how: 'copy', by: 'writer' })
    await store.discardCopy(item.id)
    expect(await filesOf(item.id)).toHaveLength(2)
    expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'utf8')).toBe('Gone soon.')
    expect((await store.list({ activePath: null })).items).toEqual([])
    expect((await store.list({ activePath: null })).notices).toEqual([])
    await expect(store.confirmCut(item.id)).rejects.toThrow('not there')
  })

  test('another window promotes the copy to a cut after it was read: nothing is removed', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Now a cutting.', how: 'copy', by: 'writer' })
    scratchpadStoreSeams.afterDiscardRead = async () => { scratchpadStoreSeams.afterDiscardRead = undefined; await other().confirmCut(item.id) }
    await expect(store.discardCopy(item.id)).rejects.toThrow('was kept')
    const kept = await store.get(item.id)
    expect(kept).toMatchObject({ how: 'cut', markdown: 'Now a cutting.' })
    expect(kept.problem).toBeUndefined()
  })

  test('another window records a use after it was read: nothing is removed', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'In use.', how: 'copy', by: 'writer' })
    scratchpadStoreSeams.afterDiscardRead = async () => {
      scratchpadStoreSeams.afterDiscardRead = undefined
      await other().recordUse(item.id, { useId: 'u_other01', path: 'notes.md', mode: 'copy' })
    }
    await expect(store.discardCopy(item.id)).rejects.toThrow('was kept')
    expect((await store.get(item.id)).uses.map((use) => use.useId)).toEqual(['u_other01'])
    expect(await filesOf(item.id)).toHaveLength(2)
  })

  test('a payload changed outside WriteFlex is refused before anything is removed', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Original.', how: 'copy', by: 'writer' })
    await writeFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'Rewritten by sync.', 'utf8')
    await expect(store.discardCopy(item.id)).rejects.toThrow('changed outside WriteFlex')
    expect(await filesOf(item.id)).toHaveLength(2)
    expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'utf8')).toBe('Rewritten by sync.')
  })

  test('a payload changed during metadata promotion refuses withdrawal and keeps both files', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Original.', how: 'copy', by: 'writer' })
    const payload = join(root, '.writeflex', `scratchpad-item-${item.id}.md`)
    storeWriteSeams.afterContentCheck = async () => {
      storeWriteSeams.afterContentCheck = undefined
      await writeFile(payload, 'Written in the gap.', 'utf8')
    }
    await expect(store.discardCopy(item.id)).rejects.toThrow('changed outside WriteFlex')
    expect((await store.get(item.id)).markdown).toBe('Written in the gap.')
    expect(await filesOf(item.id)).toHaveLength(2)
  })

  test('a record promoted at the writer content check protects the cutting', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Original.', how: 'copy', by: 'writer' })
    storeWriteSeams.afterContentCheck = async () => {
      storeWriteSeams.afterContentCheck = undefined
      await other().confirmCut(item.id)
    }
    await expect(store.discardCopy(item.id)).rejects.toThrow('was kept')
    expect(await store.get(item.id)).toMatchObject({ how: 'cut', markdown: 'Original.' })
    expect(await filesOf(item.id)).toHaveLength(2)
  })

  test('the store folder swapped for a link after the read: refused, and nothing on either side is removed', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Guarded.', how: 'copy', by: 'writer' })
    const outside = await mkdtemp(join(tmpdir(), 'wf-scratchpad-outside-'))
    scratchpadStoreSeams.afterDiscardRead = async () => {
      scratchpadStoreSeams.afterDiscardRead = undefined
      await rename(join(root, '.writeflex'), join(root, 'moved-store'))
      await cp(join(root, 'moved-store'), outside, { recursive: true })
      await symlink(outside, join(root, '.writeflex'))
    }
    try {
      await expect(store.discardCopy(item.id)).rejects.toThrow()
      const kept = (name: string) => readFile(join(name, `scratchpad-item-${item.id}.md`), 'utf8')
      expect(await kept(outside)).toBe('Guarded.')
      expect(await kept(join(root, 'moved-store'))).toBe('Guarded.')
      expect(existsSync(join(outside, `scratchpad-item-${item.id}.json`))).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a failed record create retains every payload, including changed bytes', async () => {
    const records = (): Promise<string[]> => readdir(join(root, '.writeflex')).then((names) => names.filter((n) => n.endsWith('.json') && n.startsWith('scratchpad-item-')))
    // The record's name taken by another writer at the last instant: the create fails.
    storeWriteSeams.beforePromote = async (_temp, target) => {
      if (!target.endsWith('.json')) return
      storeWriteSeams.beforePromote = undefined
      await writeFile(target, '{}', 'utf8')
    }
    await expect(store.addText({ origin: 'notes.md', markdown: 'Ours.', how: 'copy', by: 'writer' })).rejects.toThrow()
    const leftovers = (await readdir(join(root, '.writeflex'))).filter((n) => n.endsWith('.md'))
    expect(leftovers).toHaveLength(1)
    expect(await readFile(join(root, '.writeflex', leftovers[0]), 'utf8')).toBe('Ours.')
    expect(await records()).toHaveLength(1) // the other writer's file, untouched

    storeWriteSeams.beforePromote = async (_temp, target) => {
      if (!target.endsWith('.json')) return
      storeWriteSeams.beforePromote = undefined
      await writeFile(target.replace(/\.json$/, '.md'), 'Changed meanwhile.', 'utf8')
      await writeFile(target, '{}', 'utf8')
    }
    await expect(store.addText({ origin: 'notes.md', markdown: 'Ours again.', how: 'copy', by: 'writer' })).rejects.toThrow()
    const kept = (await readdir(join(root, '.writeflex'))).filter((n) => n.endsWith('.md'))
    expect(kept).toHaveLength(2)
    expect(await Promise.all(kept.map((name) => readFile(join(root, '.writeflex', name), 'utf8')))).toContain('Changed meanwhile.')
  })
})

// R4: a put-back holds its item out of Candidates only while the editor session whose anchor stands for
// it is alive; afterwards it is reported unverified (conservative invalidation), never inferred from prose.
describe('placement claims after the editor that made them is gone (R4)', () => {
  test('a put-back from a session that is gone no longer places the item, and says why', async () => {
    let live = new Set(['run:1'])
    const tracked = new ScratchpadStore(ws, scraps, { liveHolders: () => live })
    const item = await tracked.addText({ origin: 'notes.md', markdown: 'Cut words.', how: 'copy', by: 'writer' })
    await tracked.confirmCut(item.id)
    await tracked.recordUse(item.id, { useId: 'u_back0001', path: 'notes.md', mode: 'put-back', holder: 'run:1' })
    expect(isPlaced(await tracked.get(item.id))).toBe(true)
    live = new Set()
    const after = await tracked.get(item.id)
    expect(isPlaced(after)).toBe(false)
    expect(after.uses).toEqual([expect.objectContaining({ useId: 'u_back0001', unverified: true })])
    expect(after.problem).toContain('can no longer confirm')
    expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.json`), 'utf8')).not.toContain('unverified')
  })

  test('reopening a document drops only that session\'s uses there whose anchors are gone', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Cut words.', how: 'copy', by: 'writer' })
    await store.confirmCut(item.id)
    await store.recordUse(item.id, { useId: 'u_gone0001', path: 'notes.md', mode: 'put-back', holder: 'run:1' })
    await store.recordUse(item.id, { useId: 'u_kept0001', path: 'notes.md', mode: 'copy', holder: 'run:1' })
    await store.recordUse(item.id, { useId: 'u_else0001', path: 'notes.md', mode: 'copy', holder: 'run:2' })
    await store.recordUse(item.id, { useId: 'u_part0001', path: 'book/part-a/one.md', mode: 'copy', holder: 'run:1' })
    expect(await store.releaseUses('notes.md', 'run:1', ['u_kept0001'])).toBe(1)
    expect((await store.get(item.id)).uses.map((use) => use.useId).sort()).toEqual(['u_else0001', 'u_kept0001', 'u_part0001'])
    expect((await store.get(item.id)).markdown).toBe('Cut words.')
  })
})

// R5: app-owned rename and move carry an item's identity; its bytes are never rewritten.
describe('following app-owned renames and moves (R5)', () => {
  const PICTURE = 'A figure: ![loop](figures/loop.png)\n'
  const payloadOf = (id: string): Promise<string> => readFile(join(root, '.writeflex', `scratchpad-item-${id}.md`), 'utf8')

  test('a document moved to another folder: origin and uses follow, id and payload stay, links still resolve from where they were written', async () => {
    const item = await store.addText({ origin: 'book/part-a/one.md', markdown: PICTURE, how: 'copy', by: 'writer' })
    await store.recordUse(item.id, { useId: 'u_in00001', path: 'book/part-a/one.md', mode: 'copy' })
    expect(await store.followRename('book/part-a/one.md', 'book/part-b/one.md')).toBe(1)
    const moved = await store.get(item.id)
    expect(moved.id).toBe(item.id)
    expect(moved.origin).toEqual({ path: 'book/part-b/one.md', heading: null, base: 'book/part-a' })
    expect(moved.uses.map((use) => use.path)).toEqual(['book/part-b/one.md'])
    expect(await payloadOf(item.id)).toBe(PICTURE)
    expect((await store.list({ activePath: 'book/part-b/one.md' })).items.map((i) => i.id)).toContain(item.id)
    // Inserted beside the moved document, the picture still points at book/part-a/figures.
    expect(await store.prepareInsert(item.id, 'book/part-b/two.md')).toEqual({ ok: true, markdown: 'A figure: ![loop](../part-a/figures/loop.png)\n', rewritten: 1 })
    expect(await store.prepareInsert(item.id, 'book/part-a/one.md')).toEqual({ ok: true, markdown: PICTURE, rewritten: 0 })
  })

  test('a folder moved with its pictures: origin and base move together, so the payload needs no rewriting there', async () => {
    const item = await store.addText({ origin: 'book/part-a/one.md', markdown: PICTURE, how: 'copy', by: 'writer' })
    await store.followRename('book/part-a', 'book/chapter-1')
    const moved = await store.get(item.id)
    expect(moved.origin).toEqual({ path: 'book/chapter-1/one.md', heading: null })
    expect(await store.prepareInsert(item.id, 'book/chapter-1/one.md')).toEqual({ ok: true, markdown: PICTURE, rewritten: 0 })
    expect(await payloadOf(item.id)).toBe(PICTURE)
  })

  test('a rename that does not touch an item changes nothing', async () => {
    const item = await store.addText({ origin: 'notes.md', markdown: 'Here.', how: 'copy', by: 'writer' })
    const before = await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.json`), 'utf8')
    expect(await store.followRename('book/part-a/one.md', 'book/one.md')).toBe(0)
    expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.json`), 'utf8')).toBe(before)
  })
})


test('withdrawn ids refuse every item mutation and insertion, without resurrection or orphan notices', async () => {
  const item = await store.addText({ origin: 'notes.md', markdown: RICH, how: 'copy', by: 'writer' })
  await store.discardCopy(item.id)
  for (const op of [
    () => store.get(item.id), () => store.reserveCut(item.id, 'run:1'), () => store.cancelCut(item.id, 'run:1'), () => store.confirmCut(item.id), () => store.discardCopy(item.id),
    () => store.prepareInsert(item.id, 'notes.md'), () => store.toggleDone(item.id),
    () => store.setColour(item.id, 'red'), () => store.setStatus([item.id], 'active'),
    () => store.setGroup([item.id], null), () => store.dropUse(item.id, 'u_stale001'),
    () => store.recordUse(item.id, { useId: 'u_stale001', path: 'notes.md', mode: 'copy' }),
  ]) await expect(op()).rejects.toThrow('not there')
  await store.followRename('notes.md', 'renamed.md')
  expect(await store.releaseUses('notes.md', 'dead:1', [])).toBe(0)
  expect((await store.list({ activePath: null }))).toMatchObject({ items: [], notices: [] })
  expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'utf8')).toBe(RICH)
  const record = JSON.parse(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.json`), 'utf8'))
  expect(record).toMatchObject({ withdrawn: true, status: 'active', how: 'copy', origin: { path: 'notes.md' } })
})

test('a stale promotion waiting in the checked writer cannot resurrect a withdrawn copy', async () => {
  const item = await store.addText({ origin: 'notes.md', markdown: 'Retained.', how: 'copy', by: 'writer' })
  storeWriteSeams.beforePromote = async () => {
    storeWriteSeams.beforePromote = undefined
    await store.discardCopy(item.id)
  }
  const second = new ScratchpadStore(new Workspace(root), null)
  await expect(second.confirmCut(item.id)).rejects.toThrow('changed')
  await expect(store.get(item.id)).rejects.toThrow('not there')
  expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'utf8')).toBe('Retained.')
})

test('failed metadata creation leaves a visible orphan payload without cleanup deletion', async () => {
  storeWriteSeams.beforePromote = async (_temp, target) => {
    if (!target.endsWith('.json')) return
    storeWriteSeams.beforePromote = undefined
    throw new Error('Metadata unavailable.')
  }
  await expect(store.addText({ origin: 'notes.md', markdown: RICH, how: 'copy', by: 'writer' })).rejects.toThrow('Metadata unavailable')
  const snapshot = await store.list({ activePath: null })
  expect(snapshot.items).toEqual([])
  expect(snapshot.notices.join(' ')).toContain('has no record')
  const files = await storeFiles()
  expect(files).toHaveLength(1)
  expect(await readFile(join(root, '.writeflex', files[0]), 'utf8')).toBe(RICH)
})

test('folder swapped for a link during metadata promotion refuses withdrawal without touching either record', async () => {
  const item = await store.addText({ origin: 'notes.md', markdown: 'Guarded.', how: 'copy', by: 'writer' })
  const recordName = `scratchpad-item-${item.id}.json`
  const original = await readFile(join(root, '.writeflex', recordName), 'utf8')
  const outside = join(root, 'substitute-store')
  storeWriteSeams.beforePromote = async () => {
    storeWriteSeams.beforePromote = undefined
    await rename(join(root, '.writeflex'), join(root, 'moved-store'))
    await cp(join(root, 'moved-store'), outside, { recursive: true })
    await symlink(outside, join(root, '.writeflex'))
  }
  await expect(store.discardCopy(item.id)).rejects.toThrow()
  expect(await readFile(join(outside, recordName), 'utf8')).toBe(original)
  expect(await readFile(join(root, 'moved-store', recordName), 'utf8')).toBe(original)
  expect(await readFile(join(outside, `scratchpad-item-${item.id}.md`), 'utf8')).toBe('Guarded.')
})


test('a cut reservation blocks withdrawal, stays a copy until confirmed, and only its holder can cancel it', async () => {
  const item = await store.addText({ origin: 'notes.md', markdown: RICH, how: 'copy', by: 'writer' })
  await store.reserveCut(item.id, 'run:1')
  expect((await store.get(item.id)).how).toBe('copy')
  await expect(store.discardCopy(item.id)).rejects.toThrow('has not been used')
  await expect(store.cancelCut(item.id, 'run:2')).rejects.toThrow('another editor')
  await expect(store.confirmCut(item.id, 'run:2')).rejects.toThrow('another editor')
  await store.cancelCut(item.id, 'run:1')
  expect((await store.get(item.id)).how).toBe('copy')
  await store.reserveCut(item.id, 'run:1')
  await store.confirmCut(item.id, 'run:1')
  expect((await store.get(item.id)).how).toBe('cut')
  await expect(store.discardCopy(item.id)).rejects.toThrow('has not been used')
  expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'utf8')).toBe(RICH)
})

test('withdrawal wins before a stale cut reservation, which cannot revive the item', async () => {
  const item = await store.addText({ origin: 'notes.md', markdown: 'Retained.', how: 'copy', by: 'writer' })
  storeWriteSeams.beforePromote = async () => {
    storeWriteSeams.beforePromote = undefined
    await store.discardCopy(item.id)
  }
  await expect(new ScratchpadStore(new Workspace(root), null).reserveCut(item.id, 'run:2')).rejects.toThrow('changed')
  await expect(store.get(item.id)).rejects.toThrow('not there')
})

test('a reservation winning after the withdrawal read protects the captured copy', async () => {
  const item = await store.addText({ origin: 'notes.md', markdown: 'Reserved.', how: 'copy', by: 'writer' })
  scratchpadStoreSeams.afterDiscardRead = async () => {
    scratchpadStoreSeams.afterDiscardRead = undefined
    await new ScratchpadStore(new Workspace(root), null).reserveCut(item.id, 'run:2')
  }
  await expect(store.discardCopy(item.id)).rejects.toThrow('was kept')
  expect((await store.get(item.id)).how).toBe('copy')
  await store.confirmCut(item.id, 'run:2')
  expect((await store.get(item.id)).how).toBe('cut')
})

test('payload changes during reservation refuse it; failed confirmation leaves a protected, retained copy', async () => {
  const item = await store.addText({ origin: 'notes.md', markdown: 'Original.', how: 'copy', by: 'writer' })
  const payload = join(root, '.writeflex', `scratchpad-item-${item.id}.md`)
  storeWriteSeams.afterContentCheck = async () => {
    storeWriteSeams.afterContentCheck = undefined
    await writeFile(payload, 'Changed outside.', 'utf8')
  }
  await expect(store.reserveCut(item.id, 'run:1')).rejects.toThrow('changed outside')
  expect((await store.get(item.id)).how).toBe('copy')
  const clean = await store.addText({ origin: 'notes.md', markdown: 'Keep safe.', how: 'copy', by: 'writer' })
  await store.reserveCut(clean.id, 'run:1')
  storeWriteSeams.beforePromote = async () => { storeWriteSeams.beforePromote = undefined; throw new Error('Disk full.') }
  await expect(store.confirmCut(clean.id, 'run:1')).rejects.toThrow('Disk full')
  await expect(new ScratchpadStore(new Workspace(root), null).discardCopy(clean.id)).rejects.toThrow('has not been used')
  expect((await store.get(clean.id))).toMatchObject({ how: 'copy', markdown: 'Keep safe.' })
})


test('releasing a stale legacy use reports the change and preserves the original scrap bytes', async () => {
  const text = '## s_release\nLegacy words.\n'
  await mkdir(join(root, 'scraps'), { recursive: true })
  await writeFile(join(root, 'scraps/notes-SCRAPS.md'), text)
  const item = (await store.list({ activePath: 'notes.md' })).items.find((item) => item.source === 'legacy')!
  await store.recordUse(item.id, { useId: 'u_legacy01', path: 'notes.md', mode: 'copy', holder: 'run:1' })
  expect(await store.releaseUses('notes.md', 'run:1', [])).toBe(1)
  expect((await store.get(item.id)).uses).toEqual([])
  expect(await readFile(join(root, 'scraps/notes-SCRAPS.md'), 'utf8')).toBe(text)
})
