import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SnapshotStore } from '@bridle/core'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { BoardMaterialDesk } from '../../src/main/board-material-desk'
import { prepareOffcutPromotion } from '../../src/main/board-material'

// Independent parent review: an outside writer changes source metadata after its
// restore snapshot. A Board step must not restore older metadata over that later edit.
let base: string | undefined
afterEach(async () => { if (base) await rm(base, { recursive: true, force: true }); base = undefined })
test('Board preserves an external Scratchpad metadata edit between its snapshot and consumption', async () => {
  base = await mkdtemp(join(import.meta.dirname, '.scratchpad-board-read-review-'))
  const piece = '# Piece\n\nOriginal paragraph.\n'
  await writeFile(join(base, 'piece.md'), piece)
  const ws = new Workspace(base)
  const scraps = new ScrapStore(ws)
  const store = new ScratchpadStore(ws, scraps)
  const item = await store.addText({ origin: 'piece.md', markdown: '**Kept words.**\n', how: 'copy', by: 'writer' })
  const externalGroup = await store.createGroup('Another writer’s group')
  const recordPath = join(base, store.recordPathFor(item.id))
  const snapshots = await SnapshotStore.open({ dir: join(base, '.bridle') })
  let changed = false
  const board = new BoardMaterialDesk(ws, {
    sessionId: () => 'parent-review',
    snapshots: {
      beginRestorePoint: (...args) => snapshots.beginRestorePoint(...args),
      entries: () => snapshots.entries(),
      restoreTo: (...args) => snapshots.restoreTo(...args),
      snapshotFile: async (...args) => {
        const result = await snapshots.snapshotFile(...args)
        if (args[0] === join(base!, 'piece.md') && !changed) {
          const record = JSON.parse(await readFile(recordPath, 'utf8'))
          record.group = externalGroup.id
          await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)
          changed = true
        }
        return result
      },
    },
  }, scraps)
  const result = await board.appendScrap({ piece: 'piece.md', scrapId: item.id })
  expect(changed).toBe(true)
  // Either refuse the stale source before committing, or preserve the external metadata
  // under a fresh restore point. A successful step's Undo must never erase that edit.
  if (result.ok) expect(await board.undo(result.step.id)).toMatchObject({ ok: true })
  expect(await readFile(join(base, 'piece.md'), 'utf8')).toBe(piece)
  expect((await store.get(item.id)).group).toBe(externalGroup.id)
})

test('Board Undo restores a lossless text item and document without an intervening edit', async () => {
  base = await mkdtemp(join(import.meta.dirname, '.scratchpad-board-read-review-'))
  const piece = '# Piece\n\nOriginal paragraph.\n'
  await writeFile(join(base, 'piece.md'), piece)
  const ws = new Workspace(base)
  const scraps = new ScrapStore(ws)
  const store = new ScratchpadStore(ws, scraps)
  const item = await store.addText({ origin: 'piece.md', markdown: '**Kept words.**\n', how: 'copy', by: 'writer' })
  const snapshots = await SnapshotStore.open({ dir: join(base, '.bridle') })
  const board = new BoardMaterialDesk(ws, { snapshots, sessionId: () => 'parent-review' }, scraps)
  const result = await board.appendScrap({ piece: 'piece.md', scrapId: item.id })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(await board.undo(result.step.id)).toMatchObject({ ok: true })
  expect(await readFile(join(base, 'piece.md'), 'utf8')).toBe(piece)
  expect((await store.get(item.id)).markdown).toBe(item.markdown)
})


test('promoting lossless text preserves indentation that makes its first block code', async () => {
  base = await mkdtemp(join(import.meta.dirname, '.scratchpad-board-read-review-'))
  await writeFile(join(base, 'piece.md'), '# Piece\n')
  const ws = new Workspace(base)
  const store = new ScratchpadStore(ws, null)
  const exact = '    const kept = true\n    next()\n'
  const item = await store.addText({ origin: 'piece.md', markdown: exact, how: 'copy', by: 'writer' })
  const plan = await prepareOffcutPromotion(ws, { dir: '', scrapsPath: '', scrapId: item.id, name: 'Kept code' })
  expect(plan.tracker.after).toContain('>     const kept = true')
  expect(plan.tracker.after).toContain('>     next()')
  expect((await store.get(item.id)).markdown).toBe(exact)
})
