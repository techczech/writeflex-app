import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { registerScratchLiveReads } from '../../src/main/scratchpad-live'
import { configureScratchLiveReader, readScratchInventory } from '../../src/main/scratchpad-inventory'
let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dir, '.scratchpad-live-'))
  ws = new Workspace(root)
  await writeFile(join(root, 'part.md'), '![Disk](disk.png)')
})
afterEach(async () => { configureScratchLiveReader(null); await rm(root, { recursive: true, force: true }) })

test('only the requested sender on its still-bound root may answer a live owner read', async () => {
  let answer: (event: { sender: { id: number } }, raw: unknown) => unknown = () => {}
  registerScratchLiveReads({ handle: (_channel, handler) => { answer = handler } }, () => [{ sender: 7, root, send: request => {
    answer({ sender: { id: 9 } }, { ...request, buffers: [{ path: 'part.md', content: '![Wrong](wrong.png)' }] })
    answer({ sender: { id: 7 } }, { ...request, buffers: [{ path: 'part.md', content: '| Live |\n|---|\n| unsaved |' }] })
  } }])
  const result = await readScratchInventory(ws, { activePath: 'part.md', scope: 'part' })
  expect(result.items.map(item => item.kind)).toEqual(['table'])
  expect(result.items[0].document!.basis).toBe('live')
})
test('a live buffer carries raw text plus excluded spans; inventory answers in raw coordinates', async () => {
  let answer: (event: { sender: { id: number } }, raw: unknown) => unknown = () => {}
  const gone = 'OLDGONE\n\n'
  const raw = gone + '![Live](loop.png)\n'
  registerScratchLiveReads({ handle: (_channel, handler) => { answer = handler } }, () => [{ sender: 7, root, send: request => {
    answer({ sender: { id: 7 } }, { ...request, buffers: [{ path: 'part.md', content: raw, removedSpans: [{ from: 0, to: gone.length }] }] })
  } }])
  const result = await readScratchInventory(ws, { activePath: 'part.md', scope: 'part' })
  expect(result.items).toHaveLength(1)
  expect(result.items[0].markdown).toBe('![Live](loop.png)')
  expect(result.items[0].document).toMatchObject({ from: raw.indexOf('!['), line: 3, basis: 'live' })
})
test('an inconsistent live projection refuses the inventory rather than substituting disk', async () => {
  let answer: (event: { sender: { id: number } }, raw: unknown) => unknown = () => {}
  registerScratchLiveReads({ handle: (_channel, handler) => { answer = handler } }, () => [{ sender: 7, root, send: request => {
    answer({ sender: { id: 7 } }, { ...request, buffers: [{ path: 'part.md', content: 'short', removedSpans: [{ from: 3, to: 99 }] }] })
  } }])
  await expect(readScratchInventory(ws, { activePath: 'part.md', scope: 'part' })).rejects.toThrow('disk was not substituted')
})
test('a root switch while replying refuses the inventory rather than substituting disk', async () => {
  let answer: (event: { sender: { id: number } }, raw: unknown) => unknown = () => {}
  let bound = root
  registerScratchLiveReads({ handle: (_channel, handler) => { answer = handler } }, () => [{ sender: 7, root: bound, send: request => {
    bound = '/another-folder'
    answer({ sender: { id: 7 } }, { ...request, buffers: [] })
  } }])
  await expect(readScratchInventory(ws, { activePath: 'part.md', scope: 'part' })).rejects.toThrow('disk was not substituted')
})
test('a reply cannot smuggle an unrequested file or duplicate owner into a snapshot', async () => {
  let answer: (event: { sender: { id: number } }, raw: unknown) => unknown = () => {}
  registerScratchLiveReads({ handle: (_channel, handler) => { answer = handler } }, () => [{ sender: 7, root, send: request => {
    answer({ sender: { id: 7 } }, { ...request, buffers: [{ path: '../other.md', content: 'private' }] })
  } }])
  await expect(readScratchInventory(ws, { activePath: 'part.md', scope: 'part' })).rejects.toThrow()
})
