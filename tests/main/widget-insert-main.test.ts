import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability, CapabilityContext } from '@bridle/core'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { writeflexApprovalPolicy } from '../../src/main/verbs/verb-support'
import { listWidgetChoices, registerWidgetInsertHandlers, resolveWidgetDrop } from '../../src/main/widget-insert'
import { Workspace } from '../../src/main/workspace'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { commandTaskGroups } from '../../src/renderer/src/commands/command-task-groups'

// Interactive widgets, ticket 05: the picker's listing, the drop's resolution, the two verbs, the command.

let root: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-widget-ins-')))
  outside = await mkdtemp(join(tmpdir(), 'wf-widget-ins-out-'))
  await mkdir(join(root, 'essays/assets'), { recursive: true })
  await mkdir(join(root, 'essays/.hidden'), { recursive: true })
  await mkdir(join(root, 'other'), { recursive: true })
  await writeFile(join(root, 'essays/doc.md'), 'Intro.\n\nMore.\n')
  await writeFile(join(root, 'essays/page.html'), '<p>p</p>')
  await writeFile(join(root, 'essays/assets/b.html'), '<p>b</p>')
  await writeFile(join(root, 'essays/.hidden/c.html'), '<p>c</p>')
  await writeFile(join(root, 'essays/notes.txt'), 'x')
  await writeFile(join(root, 'other/o.html'), '<p>o</p>')
  await writeFile(join(outside, 'evil.html'), '<p>evil</p>')
  await symlink(join(outside, 'evil.html'), join(root, 'essays/link.html'))
  await symlink(outside, join(root, 'essays/outdir'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('the picker lists the HTML files in the document folder and below it, inside the workspace only', async () => {
  const listed = await listWidgetChoices(root, 'essays/doc.md')
  expect(listed.folder).toBe('essays')
  expect(listed.files).toEqual([
    { name: 'b.html', directory: 'assets', rawPath: 'assets/b.html' },
    { name: 'page.html', directory: '', rawPath: 'page.html' },
  ])
  // Not the sibling folder, not hidden folders, not a link out of the workspace, not a non-HTML file.
  expect(JSON.stringify(listed)).not.toMatch(/evil|o\.html|notes|\.hidden/)
})

test('a document at the workspace root lists the whole workspace and names it by its folder', async () => {
  await writeFile(join(root, 'top.md'), 'x')
  const listed = await listWidgetChoices(root, 'top.md')
  expect(listed.files.map((file) => file.rawPath)).toEqual(['essays/assets/b.html', 'essays/page.html', 'other/o.html'])
})

test('a dropped file resolves to the path the embed line carries, or is refused', async () => {
  expect(await resolveWidgetDrop(root, 'essays/doc.md', join(root, 'essays/assets/b.html'))).toEqual({ ok: true, rawPath: 'assets/b.html' })
  expect(await resolveWidgetDrop(root, 'essays/doc.md', join(root, 'other/o.html'))).toEqual({ ok: true, rawPath: '../other/o.html' })
  expect(await resolveWidgetDrop(root, 'essays/doc.md', join(outside, 'evil.html'))).toEqual({ ok: false, reason: 'outside-workspace' })
  // A link inside the workspace to a file outside is outside by its real location.
  expect(await resolveWidgetDrop(root, 'essays/doc.md', join(root, 'essays/link.html'))).toEqual({ ok: false, reason: 'outside-workspace' })
  expect(await resolveWidgetDrop(root, 'essays/doc.md', join(root, 'essays/notes.txt'))).toEqual({ ok: false, reason: 'not-html' })
  expect(await resolveWidgetDrop(root, 'essays/doc.md', join(root, 'essays/nope.html'))).toEqual({ ok: false, reason: 'missing' })
  expect(await resolveWidgetDrop(root, 'essays/doc.md', 'relative.html')).toEqual({ ok: false, reason: 'missing' })
})

test('the two channels are read-only handlers on the window\'s own workspace', async () => {
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  registerWidgetInsertHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } }, { workspaceRootFor: () => root })
  expect([...handlers.keys()].sort()).toEqual(['widget:list-choices', 'widget:resolve-drop'])
  const listed = await handlers.get('widget:list-choices')!({ sender: { id: 1 } }, { documentPath: 'essays/doc.md' })
  expect((listed as { files: unknown[] }).files).toHaveLength(2)
  expect(() => handlers.get('widget:list-choices')!({ sender: { id: 1 } }, { documentPath: '' })).toThrow(/Invalid widget request/)
})

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}
const verb = (ws: Workspace, name: string): Capability => {
  const cap = buildWriteFlexManifest(ws).capabilities.find((c): c is Capability => c.name === name)
  if (!cap) throw new Error(`missing ${name}`)
  return cap
}

test('widgets.insert and widgets.remove exist at proposal posture: the policy stages them even for an interactive trigger', async () => {
  const policy = writeflexApprovalPolicy()
  const interactive = { id: 't', source: 'user' as const, trust: 'interactive' as const }
  expect(await policy({ capability: { name: 'widgets.insert', risk: 'write' }, input: {}, trigger: interactive })).toBe('stage')
  expect(await policy({ capability: { name: 'widgets.remove', risk: 'write' }, input: {}, trigger: interactive })).toBe('stage')
  expect(await policy({ capability: { name: 'widgets.list', risk: 'read' }, input: {}, trigger: interactive })).toBe('allow')
  const ws = new Workspace(root)
  expect(verb(ws, 'widgets.insert').risk).toBe('write')
  expect(verb(ws, 'widgets.remove').risk).toBe('write')
})

test('widgets.insert writes only the embed line, with a path from the document\'s folder', async () => {
  const ws = new Workspace(root)
  const before = await readFile(join(root, 'essays/assets/b.html'), 'utf8')
  const result = await verb(ws, 'widgets.insert').execute({ path: 'essays/doc.md', file: 'essays/assets/b.html', position: 'end' }, ctx)
  expect(result.isError).toBeFalsy()
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n\n[Simulation: assets/b.html]\n')
  expect(await readFile(join(root, 'essays/assets/b.html'), 'utf8')).toBe(before)
  const second = await verb(ws, 'widgets.insert').execute({ path: 'essays/doc.md', file: 'other/o.html', position: 1 }, ctx)
  expect(second.isError).toBeFalsy()
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n\n[Simulation: assets/b.html]\n\n[Simulation: ../other/o.html]\n')
})

test('widgets.insert refuses a file outside the workspace, a web address, a non-HTML file and a missing widget ordinal', async () => {
  const ws = new Workspace(root)
  const insert = verb(ws, 'widgets.insert')
  const original = await readFile(join(root, 'essays/doc.md'), 'utf8')
  for (const file of [join(outside, 'evil.html'), '../outside.html', 'essays/link.html', 'https://example.com/a.html', 'essays/notes.txt', 'essays/missing.html']) {
    const refused = await insert.execute({ path: 'essays/doc.md', file }, ctx)
    expect(refused.isError, file).toBe(true)
    expect(refused.text, file).not.toContain(outside)
  }
  expect((await insert.execute({ path: 'essays/doc.md', file: 'essays/page.html', position: 4 }, ctx)).isError).toBe(true)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe(original)
  const stage = (insert as unknown as { validateStage?: (input: unknown) => Promise<{ decision: string }> }).validateStage
  if (stage) expect((await stage({ path: 'essays/doc.md', file: join(outside, 'evil.html') })).decision).toBe('deny')
})

test('widgets.remove takes one widget line out and leaves the file on disk', async () => {
  await writeFile(join(root, 'essays/doc.md'), 'Intro.\n\n[Simulation: page.html]\n\nMore.\n\n[Simulation: assets/b.html]\n')
  const ws = new Workspace(root)
  const remove = verb(ws, 'widgets.remove')
  expect((await remove.execute({ path: 'essays/doc.md', ordinal: 3 }, ctx)).isError).toBe(true)
  expect((await remove.execute({ path: 'essays/doc.md', ordinal: 1 }, ctx)).isError).toBeFalsy()
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n\n[Simulation: assets/b.html]\n')
  expect(await readFile(join(root, 'essays/page.html'), 'utf8')).toBe('<p>p</p>')
})

test('Insert widget… is a registered, palette-listed command in the Write task group, and the Insert object list carries it', () => {
  const command = commandRegistry.find((entry) => entry.id === 'insert.widget')
  expect(command).toMatchObject({ label: 'Insert widget…', group: 'Writing' })
  expect(command?.surfaces).toContain('palette')
  expect(command?.surfaces).toContain('menu')
  expect(command?.run).toBeUndefined() // the picker is App's; the palette row is App's too
  expect(commandTaskGroups['insert.widget']).toEqual(['Write', 'Insert objects'])
  expect(command?.task).toBe('Write')
  expect(command?.verb).toBe('widgets.insert')
  expect(command?.keys).toBeUndefined() // no default shortcut; rebindable like every command
})
