import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import { ScratchpadStore } from '../../src/main/scratchpad-store'

// Independent parent review regression: copied legacy scrap files may share an id.
// Delete forever must honour the origin encoded in the selected Scratchpad identity.
let root: string | undefined
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined })
test('deleting a rejected legacy item only removes that origin when ids repeat', async () => {
  root = await mkdtemp(join(import.meta.dirname, '.scratchpad-delete-review-'))
  await mkdir(join(root, 'scraps'))
  await writeFile(join(root, 'a.md'), '# A\n')
  await writeFile(join(root, 'b.md'), '# B\n')
  const first = '## s_same\n\nKeep the first origin.\n'
  const second = '## s_same\n\nDelete only this origin.\n'
  await writeFile(join(root, 'scraps/a-SCRAPS.md'), first)
  await writeFile(join(root, 'scraps/b-SCRAPS.md'), second)
  const ws = new Workspace(root)
  const store = new ScratchpadStore(ws, new ScrapStore(ws))
  const items = (await store.list({ activePath: null })).items
  const chosen = items.find(item => item.origin.path === 'b.md')!
  expect(chosen).toBeDefined()
  await store.setStatus([chosen.id], 'rejected')
  await store.deleteRejected(chosen.id)
  expect(await readFile(join(root, 'scraps/a-SCRAPS.md'), 'utf8')).toBe(first)
  expect(await readFile(join(root, 'scraps/b-SCRAPS.md'), 'utf8')).not.toContain('Delete only this origin.')
})
