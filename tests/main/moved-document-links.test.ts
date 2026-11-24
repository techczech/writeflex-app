import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { moveFile, renameFolder } from '../../src/main/rename-doors'
import { renameDoorWorld } from '../helpers/rename-door-world'
/** A document's own relative links follow it when the move and folder rename doors move it (rename-doors.ts). */
async function probeResult() {
  const world = await renameDoorWorld()
  const { root } = world
  await mkdir(join(root, 'papers/chapters'), { recursive: true })
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'archive'), { recursive: true })
  await writeFile(join(root, 'assets/pic.png'), 'image')
  await writeFile(join(root, 'assets/pic one.png'), 'image')
  await writeFile(join(root, 'assets/data.pdf'), 'asset')
  await writeFile(join(root, 'target.md'), 'target')
  const source = '![Picture](../../assets/pic.png "Title")\n[Document](../../target.md#part)\n[Asset](../../assets/data.pdf?download=1)\n![Root](/assets/pic.png)\n[Absolute](file:///tmp/a.png)\n[URL](https://example.org/pic.png)\n[Anchor](#part)\n[Broken](../../missing.png)\n[Folder](../../assets/)\n[Outside](../../../outside.png)\n![Encoded](<../../assets/pic%20one.png?raw=1#view> "Keep title")\n![Reference][picture]\n\n[picture]: ../../assets/pic.png "Keep reference title"\n'
  await writeFile(join(root, 'papers/chapters/draft.md'), source)
  const movedResult = await moveFile(world.deps, 'papers/chapters/draft.md', { to: 'folder', path: 'archive/draft.md' })
  const file = await world.read('archive/draft.md')
  await mkdir(join(root, 'special#name'), { recursive: true })
  await writeFile(join(root, 'special#name/local.png'), 'image')
  await writeFile(join(root, 'special#name/doc.md'), '![Local](local.png)')
  await moveFile(world.deps, 'special#name/doc.md', { to: 'folder', path: 'archive/special.md' })
  const special = await world.read('archive/special.md')
  await writeFile(join(root, 'papers/chapters/folder.md'), source.replaceAll('../../assets/', '../../papers/assets/'))
  await mkdir(join(root, 'papers/assets'), { recursive: true })
  await writeFile(join(root, 'papers/assets/pic.png'), 'image')
  await writeFile(join(root, 'papers/assets/data.pdf'), 'asset')
  await renameFolder(world.deps, 'papers', 'renamed')
  const folder = await world.read('renamed/chapters/folder.md')
  return { file, folder, source, special, notices: movedResult.repair.unrepairedReferences }
}
let pending: ReturnType<typeof probeResult> | undefined
const run = () => pending ??= probeResult()
for (const [label, old, replacement] of [
  ['image', '../../assets/pic.png', '../assets/pic.png'],
  ['document', '../../target.md#part', '../target.md#part'],
  ['asset', '../../assets/data.pdf?download=1', '../assets/data.pdf?download=1'],
]) test(`the move door preserves outgoing ${label} target`, async () => {
  const { file } = await run()
  expect(file).toContain(replacement)
  expect(file).not.toContain(old)
})
test('the folder rename door preserves outgoing relative targets', async () => {
  const { folder } = await run()
  expect(folder).toContain('![Picture](../assets/pic.png')
  expect(folder).toContain('../../target.md#part')
  expect(folder).toContain('[Asset](../assets/data.pdf?download=1)')
})
test('a move leaves root, absolute and broken links untouched', async () => {
  const { file } = await run()
  expect(file).toContain('![Root](/assets/pic.png)')
  expect(file).toContain('[Absolute](file:///tmp/a.png)')
  expect(file).toContain('[Broken](../../missing.png)')
  expect(file).toContain('[URL](https://example.org/pic.png)')
  expect(file).toContain('[Anchor](#part)')
})

test('a move preserves URL spelling, titles, suffixes and reference definitions', async () => {
  const { file, special } = await run()
  expect(special).toBe('![Local](../special%23name/local.png)')
  expect(file).toContain('![Encoded](<../assets/pic%20one.png?raw=1#view> "Keep title")')
  expect(file).toContain('[picture]: ../assets/pic.png "Keep reference title"')
  expect(file).toContain('![Picture](../assets/pic.png "Title")')
})

test('a move names folder and outside-vault links left unchanged when their resolution changes', async () => {
  const { file, notices } = await run()
  expect(file).toContain('[Folder](../../assets/)')
  expect(file).toContain('[Outside](../../../outside.png)')
  expect(notices.join(' ')).toContain('archive/draft.md: ../../assets/ was left unchanged')
  expect(notices.join(' ')).toContain('archive/draft.md: ../../../outside.png was left unchanged')
})
