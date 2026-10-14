// The channel that hands a widget's HTML to the renderer (interactive-widgets ticket 02): resolved by
// ticket 01's resolveWidget inside the workspace, read in main, nothing written.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWidget, registerWidgetIpcHandlers, WIDGET_MAX_BYTES } from '../../src/main/widget-ipc'

let base: string
let root: string

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-widget-ipc-'))
  root = join(base, 'workspace')
  await mkdir(join(root, 'notes', 'widgets'), { recursive: true })
  await writeFile(join(root, 'notes', 'doc.md'), '[Simulation: widgets/orbit.html]\n')
  await writeFile(join(root, 'notes', 'widgets', 'orbit.html'), '<!doctype html><title>Orbit &amp; gravity</title><p>hi</p>')
  await writeFile(join(root, 'notes', 'widgets', 'notes.txt'), 'plain')
  await writeFile(join(base, 'outside.html'), '<title>secret</title>')
  await symlink(join(base, 'outside.html'), join(root, 'notes', 'widgets', 'link-out.html'))
  await writeFile(join(root, 'notes', 'widgets', 'huge.html'), Buffer.alloc(WIDGET_MAX_BYTES + 1, 0x61))
})
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

test('a widget beside the document is read with its title', async () => {
  const result = await readWidget(root, 'notes/doc.md', 'widgets/orbit.html')
  expect(result).toEqual({ ok: true, html: '<!doctype html><title>Orbit &amp; gravity</title><p>hi</p>', relativePath: 'notes/widgets/orbit.html', title: 'Orbit & gravity' })
})

test('every refusal of the resolver comes back as it is, and nothing outside is read', async () => {
  expect(await readWidget(root, 'notes/doc.md', '../../outside.html')).toEqual({ ok: false, reason: 'outside-workspace' })
  expect(await readWidget(root, 'notes/doc.md', 'widgets/link-out.html')).toEqual({ ok: false, reason: 'outside-workspace' })
  expect(await readWidget(root, 'notes/doc.md', join(base, 'outside.html'))).toEqual({ ok: false, reason: 'outside-workspace' })
  expect(await readWidget(root, 'notes/doc.md', 'widgets/notes.txt')).toEqual({ ok: false, reason: 'not-html' })
  expect(await readWidget(root, 'notes/doc.md', 'widgets/none.html')).toEqual({ ok: false, reason: 'missing' })
  expect(await readWidget(root, 'notes/doc.md', 'https://example.com/x.html')).toEqual({ ok: false, reason: 'web-address' })
  expect(await readWidget(root, 'notes/doc.md', 'widgets/huge.html')).toEqual({ ok: false, reason: 'too-large' })
})

test('the document path must be workspace-relative', async () => {
  await expect(readWidget(root, '/etc/doc.md', 'widgets/orbit.html')).rejects.toThrow()
  await expect(readWidget(root, '../doc.md', 'widgets/orbit.html')).rejects.toThrow()
})

test('the handler validates its input and reads nothing for a bad request; it writes nothing', async () => {
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  registerWidgetIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, { workspaceRootFor: () => root })
  const read = handlers.get('widget:read')!
  const event = { sender: { id: 1 } }
  const before = await readdir(join(root, 'notes', 'widgets'))
  expect(await read(event, { documentPath: 'notes/doc.md', rawPath: 'widgets/orbit.html' })).toMatchObject({ ok: true, title: 'Orbit & gravity' })
  for (const bad of [null, {}, { documentPath: 'notes/doc.md' }, { documentPath: 1, rawPath: 'x' }, { documentPath: 'notes/doc.md', rawPath: 'a\0b' }, { documentPath: 'notes/doc.md', rawPath: 'x'.repeat(5000) }]) {
    await expect(Promise.resolve().then(() => read(event, bad))).rejects.toThrow(/Invalid widget request/)
  }
  expect(await readdir(join(root, 'notes', 'widgets'))).toEqual(before)
})
