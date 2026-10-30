import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { registerScratchpadIpc } from '../../src/main/scratchpad-ipc'

// The validated IPC seam (ticket 01): each call is answered for the calling window's own bound folder,
// the renderer's idea of which folder it is in must match it, and no path is taken on the renderer's
// word. Two windows, two real temporary folders.

type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<any>
type Window = { workspace: Workspace | null; scratchpad: ScratchpadStore | null }

let roots: string[] = []
let windows: Map<number, Window>
let handlers: Map<string, Handler>
let announced: string[]

const makeWindow = async (id: number): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `wf-scratchpad-ipc-${id}-`))
  roots.push(root)
  await writeFile(join(root, 'notes.md'), '# Notes\n', 'utf8')
  const ws = new Workspace(root)
  windows.set(id, { workspace: ws, scratchpad: new ScratchpadStore(ws, new ScrapStore(ws)) })
  return root
}
const call = (channel: string, sender: number, input: unknown): Promise<any> => handlers.get(channel)!({ sender: { id: sender } }, input)

beforeEach(() => {
  roots = []
  windows = new Map()
  handlers = new Map()
  announced = []
  registerScratchpadIpc({ handle: (channel, handler) => { handlers.set(channel, handler as Handler) } }, {
    stateForSender: (id) => windows.get(id) ?? { workspace: null, scratchpad: null },
    announce: (root) => { announced.push(root) },
  })
})
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))) })

const itemFiles = async (root: string): Promise<string[]> => existsSync(join(root, '.writeflex')) ? (await readdir(join(root, '.writeflex'))).filter((n) => n.startsWith('scratchpad-item-')) : []

test('a send is kept in the calling window\'s folder only, and every window on that folder is told', async () => {
  const a = await makeWindow(1)
  const b = await makeWindow(2)
  const reply = await call('scratchpad:send-text', 1, { root: a, origin: 'notes.md', markdown: '## Kept\n\nExactly.\n', heading: 'Kept' })
  expect(reply.ok).toBe(true)
  expect(reply.item.markdown).toBe('## Kept\n\nExactly.\n')
  expect((await itemFiles(a)).length).toBe(2)
  expect(await itemFiles(b)).toEqual([])
  expect(announced).toEqual([a])
})

test('a call naming a folder other than the window\'s bound one is refused and writes nothing (a stale switch)', async () => {
  const a = await makeWindow(1)
  const b = await makeWindow(2)
  const reply = await call('scratchpad:send-text', 1, { root: b, origin: 'notes.md', markdown: 'x' })
  expect(reply.ok).toBe(false)
  expect(reply.error).toContain('another folder')
  expect(await itemFiles(a)).toEqual([])
  expect(await itemFiles(b)).toEqual([])
})

test('a window with no folder, malformed input and paths outside the folder are refused with a message', async () => {
  const a = await makeWindow(1)
  expect((await call('scratchpad:send-text', 9, { root: a, origin: 'notes.md', markdown: 'x' })).ok).toBe(false)
  expect((await call('scratchpad:send-text', 1, null)).ok).toBe(false)
  expect((await call('scratchpad:send-text', 1, { root: a, origin: 42, markdown: 'x' })).ok).toBe(false)
  expect((await call('scratchpad:send-text', 1, { root: a, origin: '../escape.md', markdown: 'x' })).ok).toBe(false)
  expect((await call('scratchpad:send-text', 1, { root: a, origin: join(a, 'notes.md'), markdown: 'x' })).ok).toBe(false)
  expect((await call('scratchpad:prepare-insert', 1, { root: a, id: 'p_nothere0', destination: '../../x.md' })).ok).toBe(false)
  expect(await itemFiles(a)).toEqual([])
})

test('list answers for the asking document; a stale root gets a refusal, not the other folder\'s items', async () => {
  const a = await makeWindow(1)
  const b = await makeWindow(2)
  await call('scratchpad:send-text', 2, { root: b, origin: 'notes.md', markdown: 'In b.' })
  const own = await call('scratchpad:list', 1, { root: a, activePath: 'notes.md' })
  expect(own.ok).toBe(true)
  expect(own.snapshot.items).toEqual([])
  expect((await call('scratchpad:list', 1, { root: b, activePath: 'notes.md' })).ok).toBe(false)
})

test('a just-sent copy can be taken back; a confirmed cut cannot be discarded this way', async () => {
  const a = await makeWindow(1)
  const sent = await call('scratchpad:send-text', 1, { root: a, origin: 'notes.md', markdown: 'Undo me.' })
  expect((await call('scratchpad:discard-copy', 1, { root: a, id: sent.item.id })).ok).toBe(true)
  expect(await itemFiles(a)).toHaveLength(2)
  expect((await call('scratchpad:confirm-cut', 1, { root: a, id: sent.item.id })).ok).toBe(false)
  const cut = await call('scratchpad:send-text', 1, { root: a, origin: 'notes.md', markdown: 'Keep me.' })
  expect((await call('scratchpad:confirm-cut', 1, { root: a, id: cut.item.id })).ok).toBe(true)
  expect((await call('scratchpad:discard-copy', 1, { root: a, id: cut.item.id })).ok).toBe(false)
  expect((await itemFiles(a)).length).toBe(4)
})

test('a use is recorded under the calling window\'s own session, and only that window\'s stale uses are released', async () => {
  const a = await makeWindow(1)
  windows.set(2, windows.get(1)!) // a second window on the same folder
  const sent = await call('scratchpad:send-text', 1, { root: a, origin: 'notes.md', markdown: 'Words.' })
  const id = sent.item.id
  await call('scratchpad:confirm-cut', 1, { root: a, id })
  expect((await call('scratchpad:record-use', 1, { root: a, id, use: { useId: 'u_win10001', path: 'notes.md', mode: 'put-back', holder: 'forged' } })).ok).toBe(true)
  expect((await call('scratchpad:record-use', 2, { root: a, id, use: { useId: 'u_win20001', path: 'notes.md', mode: 'copy' } })).ok).toBe(true)
  const uses = (await windows.get(1)!.scratchpad!.get(id)).uses
  expect(uses.map((use) => use.holder?.endsWith(':1') || use.holder?.endsWith(':2'))).toEqual([true, true])
  expect(uses.some((use) => use.holder === 'forged')).toBe(false)
  expect((await call('scratchpad:drop-use', 1, { root: a, id, useId: 'u_win20001', holder: uses[1].holder })).ok).toBe(false)
  expect((await call('scratchpad:record-use', 1, { root: a, id, use: { useId: 'u_win20001', path: 'notes.md', mode: 'put-back', holder: uses[1].holder } })).ok).toBe(false)
  expect(await call('scratchpad:release-uses', 1, { root: a, path: 'notes.md', keep: [] })).toEqual({ ok: true, dropped: 1 })
  expect((await windows.get(1)!.scratchpad!.get(id)).uses.map((use) => use.useId)).toEqual(['u_win20001'])
})


test('cut reservations use the sender identity, cannot be released or confirmed by another window, and never mark an uncut copy as cut', async () => {
  const root = await makeWindow(1)
  windows.set(2, windows.get(1)!)
  const sent = await call('scratchpad:send-text', 1, { root, origin: 'notes.md', markdown: 'Copy until removed.' })
  const id = sent.item.id
  expect((await call('scratchpad:reserve-cut', 1, { root, id, holder: 'forged' })).ok).toBe(true)
  expect((await windows.get(1)!.scratchpad!.get(id)).how).toBe('copy')
  expect((await call('scratchpad:discard-copy', 2, { root, id })).ok).toBe(false)
  expect((await call('scratchpad:cancel-cut', 2, { root, id, holder: 'forged' })).ok).toBe(false)
  expect((await call('scratchpad:confirm-cut', 2, { root, id })).ok).toBe(false)
  expect((await call('scratchpad:cancel-cut', 1, { root, id })).ok).toBe(true)
  expect((await windows.get(1)!.scratchpad!.get(id)).how).toBe('copy')
  expect((await call('scratchpad:discard-copy', 1, { root, id })).ok).toBe(true)
  expect((await call('scratchpad:reserve-cut', 1, { root, id })).ok).toBe(false)
})

test('widget preview: a stale panel payload cannot name another file; the checked bytes are the returned bytes', async () => {
  const root = await makeWindow(1)
  await mkdir(join(root, 'assets'))
  const good = '<!doctype html><title>Good</title><p>Checked page</p>'
  await writeFile(join(root, 'assets/good.html'), good)
  await writeFile(join(root, 'assets/other.html'), '<!doctype html><title>Other</title><script>fetch("remote")</script>')
  const widget = '[Simulation: assets/good.html]'
  const item = await windows.get(1)!.scratchpad!.addAsset({ origin: 'notes.md', kind: 'widget', markdown: widget })
  // The caller claims the item points at other.html (the stale-snapshot attack): the id alone
  // governs, so the reply is the store-current payload and its own checked bytes.
  const reply = await call('scratchpad:prepare-widget-preview', 1, { root, id: item.id, markdown: '[Simulation: assets/other.html]' })
  expect(reply).toMatchObject({ ok: true, markdown: widget, html: good, title: 'Good' })
  expect(announced).toEqual([])
  // Another window's folder, or a stale root, gets nothing.
  expect((await call('scratchpad:prepare-widget-preview', 2, { root, id: item.id })).ok).toBe(false)
  // Document-derived preview re-derives the exact span, then checks that file's bytes.
  await writeFile(join(root, 'notes.md'), widget + '\n')
  const derived = await call('scratchpad:prepare-widget-preview', 1, { root, origin: 'notes.md', markdown: widget, from: 0, to: widget.length })
  expect(derived).toMatchObject({ ok: true, markdown: widget, html: good })
  expect((await call('scratchpad:prepare-widget-preview', 1, { root, origin: 'notes.md', markdown: widget, from: 1, to: widget.length })).ok).toBe(false)
  // Bytes that turn incompatible are refused at preparation, so nothing unchecked can mount.
  await writeFile(join(root, 'assets/good.html'), '<title>Bad</title><script>fetch("remote")</script>')
  expect((await call('scratchpad:prepare-widget-preview', 1, { root, id: item.id })).ok).toBe(false)
  expect((await call('scratchpad:prepare-widget-preview', 1, { root, origin: 'notes.md', markdown: widget, from: 0, to: widget.length })).ok).toBe(false)
})

test('typed collection revalidates its exact parsed source span and preserves the source', async () => {
  const root = await makeWindow(1)
  const markdown = '| A | B |\n|---|---|\n| 1 | 2 |'
  await writeFile(join(root, 'notes.md'), markdown)
  const input = { root, origin: 'notes.md', kind: 'table', markdown, from: 0, to: markdown.length }
  expect((await call('scratchpad:collect-asset', 2, input)).ok).toBe(false)
  expect((await call('scratchpad:collect-asset', 1, { ...input, from: 1 })).ok).toBe(false)
  const reply = await call('scratchpad:collect-asset', 1, input)
  expect(reply).toMatchObject({ ok: true, item: { kind: 'table', markdown } })
  expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe(markdown)
  await writeFile(join(root, 'notes.md'), 'Changed')
  expect((await call('scratchpad:collect-asset', 1, input)).ok).toBe(false)
})


test('showing a document with no stale placements sends no mutation notification', async () => {
  const root = await makeWindow(1)
  expect(await call('scratchpad:release-uses', 1, { root, path: 'notes.md', keep: [] })).toEqual({ ok: true, dropped: 0 })
  expect(announced).toEqual([])
})
