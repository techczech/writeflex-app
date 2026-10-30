import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace, atomicWriteSeams } from '../../src/main/workspace'
import { ScrapStore, scrapStoreSeams } from '../../src/main/scraps'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { scratchpadReadVerbs } from '../../src/main/verbs/scratchpad-reads'
import { buildVerbTable } from '../../src/main/verbs'
import { writeflexApprovalPolicy } from '../../src/main/capabilities'

// Correction parcel over 580eff99 (review-scratchpad-compare-writepaths.md):
//  1. Legacy Delete forever is origin-qualified and expected-version: repeated ids, a body changed
//     while confirmation waited, a sibling changed during the write, a linked scraps file.
//  1b. The checked index version that established the rejected status is rechecked in the commit
//     tick of the scraps write: an outside restore (after the removal's read, and while its
//     replacement is staged), any other outside index edit, a rewritten index file, and a linked
//     index or `.writeflex` folder all keep the scrap and the outside metadata exactly.
//  3. The declared metadata verbs (scratchpad.group / reject / restore / delete) run the same
//     guarded store methods as the panel; delete is approval-bound to the version shown.
// Real temporary folders; synthetic text only.

let root: string
let ws: Workspace
let scraps: ScrapStore
let store: ScratchpadStore

const ctx = { trigger: { id: 't', source: 'user', trust: 'interactive' }, sessionId: 's', attemptId: 'a', idempotencyKey: 'a', audit: () => {} } as never
const verb = (id: string) => {
  const found = scratchpadReadVerbs(ws, scraps).find((entry) => entry.id === id)
  if (!found) throw new Error(`missing verb ${id}`)
  return found
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-scratchpad-correction-'))
  ws = new Workspace(root)
  scraps = new ScrapStore(ws)
  store = new ScratchpadStore(ws, scraps)
  await writeFile(join(root, 'a.md'), '# A\n', 'utf8')
  await writeFile(join(root, 'b.md'), '# B\n', 'utf8')
  await mkdir(join(root, 'scraps'), { recursive: true })
})
afterEach(async () => {
  scrapStoreSeams.afterRemoveAtOriginRead = undefined
  delete atomicWriteSeams.afterStage
  await rm(root, { recursive: true, force: true })
})

describe('legacy Delete forever (origin-qualified, expected-version)', () => {
  const FOREIGN = 'A note the writer keeps above the scraps.\n\n'
  const seedRepeated = async () => {
    const aText = `${FOREIGN}## s_same\n\nKeep the first origin.\n`
    const bText = `## s_same\n\nDelete only this origin.\n\n## s_keep\n\nSibling stays.\n`
    await writeFile(join(root, 'scraps', 'a-SCRAPS.md'), aText, 'utf8')
    await writeFile(join(root, 'scraps', 'b-SCRAPS.md'), bText, 'utf8')
    const chosen = (await store.list({ activePath: null })).items.find((item) => item.origin.path === 'b.md' && item.markdown.includes('Delete only'))!
    await store.setStatus([chosen.id], 'rejected')
    const shown = (await store.list({ activePath: null })).items.find((item) => item.id === chosen.id)!
    return { aText, bText, shown }
  }

  test('removes only the selected origin section; foreign and sibling bytes are exact', async () => {
    const { aText, bText, shown } = await seedRepeated()
    await store.deleteRejected(shown.id, shown.version)
    expect(await readFile(join(root, 'scraps', 'a-SCRAPS.md'), 'utf8')).toBe(aText)
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe('## s_keep\n\nSibling stays.\n')
    expect(bText).toContain('Delete only this origin.')
    expect((await store.list({ activePath: null })).items.some((item) => item.id === shown.id)).toBe(false)
    expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('# B\n')
  })

  test('a body edited while the confirmation waited refuses: the old version deletes nothing', async () => {
    const { shown } = await seedRepeated()
    const edited = '## s_same\n\nEdited while the panel asked.\n\n## s_keep\n\nSibling stays.\n'
    await writeFile(join(root, 'scraps', 'b-SCRAPS.md'), edited, 'utf8')
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow('changed since it was shown')
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(edited)
    expect((await store.list({ activePath: null })).items.find((item) => item.id === shown.id)?.status).toBe('rejected')
  })

  test('a sibling changed during the write refuses whole and keeps the new sibling bytes', async () => {
    const { shown } = await seedRepeated()
    const during = '## s_same\n\nDelete only this origin.\n\n## s_keep\n\nSibling rewritten meanwhile.\n'
    scrapStoreSeams.afterRemoveAtOriginRead = async () => { await writeFile(join(root, 'scraps', 'b-SCRAPS.md'), during, 'utf8') }
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow()
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(during)
    // The overlay was not cleaned up after a failed removal: the item still shows as rejected.
    expect((await store.list({ activePath: null })).items.find((item) => item.id === shown.id)?.status).toBe('rejected')
  })

  test('a legacy candidate restored externally during removal is retained', async () => {
    const { bText, shown } = await seedRepeated()
    scrapStoreSeams.afterRemoveAtOriginRead = async () => {
      const path = join(root, '.writeflex', 'scratchpad-index.json')
      const index = JSON.parse(await readFile(path, 'utf8'))
      index.legacy[shown.id].status = 'active'
      await writeFile(path, JSON.stringify(index) + '\n')
    }
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow()
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(bText)
    expect((await store.list({ activePath: null })).items.find((item) => item.id === shown.id)?.status).toBe('active')
  })

  test('a candidate restored while the scraps replacement is staged is retained (commit-tick check)', async () => {
    const { aText, bText, shown } = await seedRepeated()
    // The atomic save behind saveFileOverRead stages its bytes, then this seam stands where an
    // outside program would act — after staging, before the rename that commits the removal.
    atomicWriteSeams.afterStage = async (absolute) => {
      delete atomicWriteSeams.afterStage
      if (!absolute.endsWith('b-SCRAPS.md')) return
      const path = join(root, '.writeflex', 'scratchpad-index.json')
      const index = JSON.parse(await readFile(path, 'utf8'))
      index.legacy[shown.id].status = 'active'
      await writeFile(path, JSON.stringify(index) + '\n')
    }
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow('kept')
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(bText)
    expect(await readFile(join(root, 'scraps', 'a-SCRAPS.md'), 'utf8')).toBe(aText)
    // The outside restore stands exactly as the outside writer left it.
    expect((await store.list({ activePath: null })).items.find((item) => item.id === shown.id)?.status).toBe('active')
  })

  test('an unrelated outside index edit during removal refuses conservatively and is preserved', async () => {
    const { bText, shown } = await seedRepeated()
    scrapStoreSeams.afterRemoveAtOriginRead = async () => {
      const path = join(root, '.writeflex', 'scratchpad-index.json')
      const index = JSON.parse(await readFile(path, 'utf8'))
      index.groups = [{ id: 'g_outside', name: 'Outside group' }]
      await writeFile(path, JSON.stringify(index) + '\n')
    }
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow('kept')
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(bText)
    const after = await store.list({ activePath: null })
    expect(after.groups).toEqual([{ id: 'g_outside', name: 'Outside group' }])
    expect(after.items.find((item) => item.id === shown.id)?.status).toBe('rejected')
  })

  test('an index rewritten with the same bytes during removal still refuses (the stamp moved)', async () => {
    const { bText, shown } = await seedRepeated()
    scrapStoreSeams.afterRemoveAtOriginRead = async () => {
      const path = join(root, '.writeflex', 'scratchpad-index.json')
      await writeFile(path, await readFile(path, 'utf8'), 'utf8')
    }
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow('kept')
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(bText)
    expect((await store.list({ activePath: null })).items.find((item) => item.id === shown.id)?.status).toBe('rejected')
  })

  test('a linked index file refuses; the link target and the scrap are untouched', async () => {
    const { bText, shown } = await seedRepeated()
    const indexPath = join(root, '.writeflex', 'scratchpad-index.json')
    const outside = join(root, 'outside-index.json')
    const indexBytes = await readFile(indexPath, 'utf8')
    await writeFile(outside, indexBytes, 'utf8')
    await rm(indexPath)
    await symlink(outside, indexPath)
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow()
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(bText)
    expect(await readFile(outside, 'utf8')).toBe(indexBytes)
  })

  test('a linked .writeflex folder refuses; nothing through the link is read as authority or written', async () => {
    const { bText, shown } = await seedRepeated()
    const real = join(root, 'elsewhere-writeflex')
    const indexBytes = await readFile(join(root, '.writeflex', 'scratchpad-index.json'), 'utf8')
    await rename(join(root, '.writeflex'), real)
    await symlink(real, join(root, '.writeflex'))
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow()
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe(bText)
    expect(await readFile(join(real, 'scratchpad-index.json'), 'utf8')).toBe(indexBytes)
  })

  test('a normal deletion keeps every other item metadata edit: groups and other overlays stand', async () => {
    const { aText, shown } = await seedRepeated()
    const group = await store.createGroup('Keepers')
    const sibling = (await store.list({ activePath: null })).items.find((item) => item.markdown.includes('Sibling stays.'))!
    const first = (await store.list({ activePath: null })).items.find((item) => item.origin.path === 'a.md')!
    await store.setGroup([sibling.id], group.id)
    await store.setStatus([first.id], 'rejected')
    const fresh = (await store.list({ activePath: null })).items.find((item) => item.id === shown.id)!
    await store.deleteRejected(fresh.id, fresh.version)
    const after = await store.list({ activePath: null })
    expect(after.items.some((item) => item.id === shown.id)).toBe(false)
    expect(after.groups).toEqual([{ id: group.id, name: 'Keepers' }])
    expect(after.items.find((item) => item.id === sibling.id)?.group).toBe(group.id)
    expect(after.items.find((item) => item.id === first.id)?.status).toBe('rejected')
    expect(await readFile(join(root, 'scraps', 'a-SCRAPS.md'), 'utf8')).toBe(aText)
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe('## s_keep\n\nSibling stays.\n')
    // The deleted item's own overlay entry went with it; the others were not rewritten away.
    const index = JSON.parse(await readFile(join(root, '.writeflex', 'scratchpad-index.json'), 'utf8'))
    expect(index.legacy[shown.id]).toBeUndefined()
    expect(index.legacy[sibling.id]?.group).toBe(group.id)
    expect(index.legacy[first.id]?.status).toBe('rejected')
  })

  test('a scraps file replaced by a symlink refuses; the link target is untouched', async () => {
    const { shown } = await seedRepeated()
    const outside = join(root, 'outside.md')
    await writeFile(outside, '# Outside\n', 'utf8')
    await rm(join(root, 'scraps', 'b-SCRAPS.md'))
    await symlink(outside, join(root, 'scraps', 'b-SCRAPS.md'))
    await expect(store.deleteRejected(shown.id, shown.version)).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('# Outside\n')
  })

  test('an emptied owned scraps file is left standing empty; the other origin keeps its file', async () => {
    await writeFile(join(root, 'scraps', 'a-SCRAPS.md'), '## s_same\n\nKeep the first origin.\n', 'utf8')
    await writeFile(join(root, 'scraps', 'b-SCRAPS.md'), '## s_same\n\nDelete only this origin.\n', 'utf8')
    const chosen = (await store.list({ activePath: null })).items.find((item) => item.origin.path === 'b.md')!
    await store.setStatus([chosen.id], 'rejected')
    const shown = (await store.list({ activePath: null })).items.find((item) => item.id === chosen.id)!
    await store.deleteRejected(shown.id, shown.version)
    expect(existsSync(join(root, 'scraps', 'b-SCRAPS.md'))).toBe(true)
    expect(await readFile(join(root, 'scraps', 'b-SCRAPS.md'), 'utf8')).toBe('')
    expect(await readFile(join(root, 'scraps', 'a-SCRAPS.md'), 'utf8')).toBe('## s_same\n\nKeep the first origin.\n')
  })

  test('the old global-id ScrapStore.remove keeps its behaviour for its existing callers', async () => {
    await writeFile(join(root, 'scraps', 'a-SCRAPS.md'), '## s_one\n\nOnly scrap.\n', 'utf8')
    const removed = await scraps.remove('s_one')
    expect(removed.text).toBe('Only scrap.')
    expect(existsSync(join(root, 'scraps', 'a-SCRAPS.md'))).toBe(false)
  })
})

describe('declared metadata verbs (spec §8)', () => {
  test('group create/rename/move run through the checked store and report actual outcomes', async () => {
    const item = await store.addText({ origin: 'a.md', markdown: 'Filed words.', how: 'copy', by: 'writer' })
    const created = await verb('scratchpad.group').run(ctx, { op: 'create', name: 'Methods' } as never)
    const groupId = (created.details as { group: { id: string } }).group.id
    expect(created.text).toContain('Methods')

    const moved = await verb('scratchpad.group').run(ctx, { op: 'move', group: groupId, ids: [item.id, 'p_missing0'] } as never)
    expect(moved.details).toMatchObject({ done: [item.id], failed: [{ id: 'p_missing0' }] })
    expect((await store.get(item.id)).group).toBe(groupId)

    const renamed = await verb('scratchpad.group').run(ctx, { op: 'rename', group: groupId, name: 'Field notes' } as never)
    expect(renamed.text).toContain('Field notes')
    expect((await store.list({ activePath: null })).groups).toEqual([{ id: groupId, name: 'Field notes' }])
    expect((await store.get(item.id)).group).toBe(groupId)

    const unknown = await verb('scratchpad.group').run(ctx, { op: 'move', group: 'g_nope', ids: [item.id] } as never)
    expect(unknown.text).toContain('No Scratchpad group')
    expect((await store.get(item.id)).group).toBe(groupId)

    const ungrouped = await verb('scratchpad.group').run(ctx, { op: 'move', group: null, ids: [item.id] } as never)
    expect(ungrouped.details).toMatchObject({ done: [item.id] })
    expect((await store.get(item.id)).group).toBeNull()
    // Payload bytes were never rewritten by any of this.
    expect(await readFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'utf8')).toBe('Filed words.')
  })

  test('reject and restore move items through the panel status writer; unknown ids are reported, not written', async () => {
    const item = await store.addText({ origin: 'a.md', markdown: 'Triage me.', how: 'copy', by: 'writer' })
    const rejected = await verb('scratchpad.reject').run(ctx, { ids: [item.id, 'legacy:nope.md#s_gone'] } as never)
    expect(rejected.details).toMatchObject({ done: [item.id] })
    expect((await store.get(item.id)).status).toBe('rejected')
    const restored = await verb('scratchpad.restore').run(ctx, { ids: [item.id] } as never)
    expect(restored.details).toMatchObject({ done: [item.id], failed: [] })
    expect((await store.get(item.id)).status).toBe('active')
  })

  test('delete is approval-posture at every trust level and the policy never lowers it to allow/stage', async () => {
    const table = buildVerbTable(ws, { scraps } as never)
    expect(table.find((entry) => entry.id === 'scratchpad.delete')).toMatchObject({ posture: 'approval', asks: true, risk: 'destructive', class: 'content' })
    expect(table.find((entry) => entry.id === 'scratchpad.group')).toMatchObject({ posture: 'direct' })
    expect(table.find((entry) => entry.id === 'scratchpad.reject')).toMatchObject({ posture: 'direct' })
    expect(table.find((entry) => entry.id === 'scratchpad.restore')).toMatchObject({ posture: 'direct' })
    const policy = writeflexApprovalPolicy()
    for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
      const decision = await policy({ capability: { name: 'scratchpad.delete', risk: 'destructive' }, input: {}, trigger: { id: 't', source: 'user', trust } })
      expect(decision).toBe(trust === 'background' ? 'deny' : 'ask')
    }
  })

  test('delete without a previewed approval writes nothing; an approved delete of the shown version succeeds once', async () => {
    const item = await store.addText({ origin: 'a.md', markdown: 'Delete via verb.', how: 'copy', by: 'writer' })
    await store.setStatus([item.id], 'rejected')
    const del = verb('scratchpad.delete')
    const input = { id: item.id }
    const denied = await del.run(ctx, input as never)
    expect(denied.text).toContain('Nothing was deleted')
    expect(existsSync(join(root, '.writeflex', `scratchpad-item-${item.id}.json`))).toBe(true)

    const preview = await del.preview!(input as never)
    expect(preview).toContain('Delete forever')
    const done = await del.run(ctx, input as never)
    expect(done.details).toMatchObject({ deleted: item.id, origin: 'a.md' })
    expect(existsSync(join(root, '.writeflex', `scratchpad-item-${item.id}.json`))).toBe(false)
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# A\n')
    // The binding was consumed: a second run on the same input deletes nothing more.
    const again = await del.run(ctx, input as never)
    expect(again.text).toContain('Nothing was deleted')
  })

  test('delete refuses an active item at preview and a body changed after preview at execution', async () => {
    const del = verb('scratchpad.delete')
    const active = await store.addText({ origin: 'a.md', markdown: 'Still a candidate.', how: 'copy', by: 'writer' })
    await expect(del.preview!({ id: active.id } as never)).rejects.toThrow('Only a rejected item')
    await expect(del.preview!({ id: 'p_missing0' } as never)).rejects.toThrow()
    await expect(del.preview!({ id: '../a.md' } as never)).rejects.toThrow()

    const item = await store.addText({ origin: 'a.md', markdown: 'Shown body.', how: 'copy', by: 'writer' })
    await store.setStatus([item.id], 'rejected')
    const input = { id: item.id }
    await del.preview!(input as never)
    // The payload changes while approval waits (with its record digest kept coherent by an outside
    // writer is out of scope; an incoherent payload change is refused by the store either way).
    await writeFile(join(root, '.writeflex', `scratchpad-item-${item.id}.md`), 'Changed body.', 'utf8')
    const refused = await del.run(ctx, input as never)
    expect(refused.text).toContain('kept')
    expect(existsSync(join(root, '.writeflex', `scratchpad-item-${item.id}.json`))).toBe(true)
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# A\n')
  })

  test('delete of a rejected legacy item through the verb removes only its own origin section', async () => {
    await writeFile(join(root, 'scraps', 'a-SCRAPS.md'), '## s_same\n\nKeep the first origin.\n', 'utf8')
    await writeFile(join(root, 'scraps', 'b-SCRAPS.md'), '## s_same\n\nDelete only this origin.\n', 'utf8')
    const chosen = (await store.list({ activePath: null })).items.find((item) => item.origin.path === 'b.md')!
    await verb('scratchpad.reject').run(ctx, { ids: [chosen.id] } as never)
    const del = verb('scratchpad.delete')
    const input = { id: chosen.id }
    await del.preview!(input as never)
    const done = await del.run(ctx, input as never)
    expect(done.details).toMatchObject({ deleted: chosen.id, origin: 'b.md', source: 'legacy' })
    expect(await readFile(join(root, 'scraps', 'a-SCRAPS.md'), 'utf8')).toBe('## s_same\n\nKeep the first origin.\n')
    expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('# B\n')
  })
})
