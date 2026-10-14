import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability, CapabilityContext } from '@bridle/core'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { resolveWidget } from '../../src/main/widgets'
import { Workspace } from '../../src/main/workspace'
import { readDocument } from '../../src/shared/markdown/model'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toRtf } from '../../src/shared/markdown/to-rtf'
import { docxContent } from '../../src/shared/markdown/to-docx'
import { scanWidgets } from '../../src/shared/markdown/widgets'

// Interactive widgets, ticket 01: the embed line is a model block, resolves inside the workspace,
// and is listed by the widgets.list read verb. Emitters show the line as text.

const widgets = (text: string) => readDocument(text).blocks.filter((block) => block.kind === 'widget')

test('an embed line alone on its line is a widget block carrying its path and range', () => {
  const text = '# T\n\n[Simulation: sims/pendulum.html]\n\nAfter.'
  const [block] = widgets(text)
  expect(block).toMatchObject({ kind: 'widget', path: 'sims/pendulum.html', source: '[Simulation: sims/pendulum.html]' })
  if (block.kind !== 'widget') throw new Error('unreachable')
  // The range indexes the prepared source, which here is the text itself.
  expect(text.slice(block.range.from, block.range.to)).toBe('[Simulation: sims/pendulum.html]')
  expect(widgets('  [ SIMULATION :  a b.html ]  ')).toMatchObject([{ path: 'a b.html' }])
  expect(widgets('[Simulation: a.html]\n[Simulation: b.html]').map((b) => b.kind === 'widget' && b.path)).toEqual(['a.html', 'b.html'])
})

test('the same text inline, in a fence, in a list, with trailing words or typed as HTML is not a widget', () => {
  for (const text of [
    'See [Simulation: a.html] here.',
    '[Simulation: a.html] and more',
    '[Simulation: a.html]\nmore words',
    '```\n[Simulation: a.html]\n```',
    '    [Simulation: a.html]',
    '- [Simulation: a.html]',
    '> [Simulation: a.html]',
    '<iframe src="a.html"></iframe>',
    '[Simulation: ]',
    '[Other: a.html]',
  ]) expect(widgets(text)).toEqual([])
})

test('[Embed: …] is a widget with the web-address refusal', () => {
  expect(widgets('[Embed: https://example.com/x]')).toMatchObject([{ path: 'https://example.com/x', refusal: 'web-address' }])
  expect(widgets('[embed: local.html]')).toMatchObject([{ refusal: 'web-address' }])
})

test('every emitter shows the embed line as text', () => {
  const text = 'Before.\n\n[Simulation: sims/a.html]\n\nAfter.'
  expect(toPlain(text)).toContain('[Simulation: sims/a.html]')
  expect(toHtml(text).html).toContain('[Simulation: sims/a.html]')
  expect(toHtml(text).html).not.toContain('<iframe')
  expect(toRtf(text)).toContain('[Simulation: sims/a.html]')
  expect(JSON.stringify(docxContent(readDocument(text)).children)).toContain('[Simulation: sims/a.html]')
})

test('scanWidgets numbers the model\'s widgets by ordinal, skipping code, comments and footnotes', () => {
  const text = '---\ntitle: x\n---\n// a note\n\n[Simulation: a.html]\n\n```\n[Simulation: no.html]\n```\n\n[Embed: https://x.y]\n'
  expect(scanWidgets(text)).toEqual([
    { ordinal: 1, source: '[Simulation: a.html]', path: 'a.html' },
    { ordinal: 2, source: '[Embed: https://x.y]', path: 'https://x.y', refusal: 'web-address' },
  ])
})

let root: string
let outside: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-widget-root-')))
  outside = await mkdtemp(join(tmpdir(), 'wf-widget-out-'))
  await mkdir(join(root, 'essays/sims'), { recursive: true })
  await writeFile(join(root, 'essays/a.html'), '<p>a</p>')
  await writeFile(join(root, 'essays/sims/b.html'), '<p>b</p>')
  await writeFile(join(root, 'essays/notes.txt'), 'x')
  await writeFile(join(root, 'top.html'), '<p>top</p>')
  await writeFile(join(outside, 'evil.html'), '<p>evil</p>')
  await symlink(outside, join(root, 'essays/link'))
  await symlink(join(outside, 'evil.html'), join(root, 'essays/evil.html'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('resolveWidget resolves against the document folder and returns the real file', async () => {
  expect(await resolveWidget(root, 'essays/doc.md', 'a.html')).toEqual({ ok: true, absolutePath: join(root, 'essays/a.html'), relativePath: 'essays/a.html' })
  expect(await resolveWidget(root, 'essays/doc.md', './sims/b.html')).toMatchObject({ ok: true, relativePath: 'essays/sims/b.html' })
  expect(await resolveWidget(root, 'essays/doc.md', '../top.html')).toMatchObject({ ok: true, relativePath: 'top.html' })
  expect(await resolveWidget(root, join(root, 'essays/doc.md'), 'a.html')).toMatchObject({ ok: true })
})

test('resolveWidget refuses everything whose real location is outside the workspace', async () => {
  const outsideRefusal = { ok: false, reason: 'outside-workspace' }
  expect(await resolveWidget(root, 'essays/doc.md', '../../evil.html')).toEqual(outsideRefusal)
  expect(await resolveWidget(root, 'essays/doc.md', join(outside, 'evil.html'))).toEqual(outsideRefusal)
  expect(await resolveWidget(root, 'essays/doc.md', 'link/evil.html')).toEqual(outsideRefusal)
  expect(await resolveWidget(root, 'essays/doc.md', 'evil.html')).toEqual(outsideRefusal)
  expect(await resolveWidget(root, 'essays/doc.md', '../../nothing-here.html')).toEqual(outsideRefusal)
})

test('resolveWidget refuses a non-HTML file, a missing file and a web address', async () => {
  expect(await resolveWidget(root, 'essays/doc.md', 'notes.txt')).toEqual({ ok: false, reason: 'not-html' })
  expect(await resolveWidget(root, 'essays/doc.md', 'gone.html')).toEqual({ ok: false, reason: 'missing' })
  expect(await resolveWidget(root, 'essays/doc.md', 'https://example.com/a.html')).toEqual({ ok: false, reason: 'web-address' })
  expect(await resolveWidget(root, 'essays/doc.md', '//example.com/a.html')).toEqual({ ok: false, reason: 'web-address' })
})

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}

test('widgets.list returns each widget with its ordinal, source, path and resolution, and writes nothing', async () => {
  await writeFile(join(root, 'essays/doc.md'), 'Intro.\n\n[Simulation: a.html]\n\n[Simulation: gone.html]\n\n[Embed: https://x.y/z]\n')
  const ws = new Workspace(root)
  const cap = buildWriteFlexManifest(ws).capabilities.find((c): c is Capability => c.name === 'widgets.list')
  if (!cap) throw new Error('missing widgets.list')
  expect(cap.risk).toBe('read')
  const result = await cap.execute({ path: 'essays/doc.md' }, ctx)
  expect(result.isError).toBeFalsy()
  expect(JSON.parse(result.text)).toEqual({
    path: 'essays/doc.md',
    widgets: [
      { ordinal: 1, source: '[Simulation: a.html]', path: 'a.html', resolution: { ok: true, relativePath: 'essays/a.html' } },
      { ordinal: 2, source: '[Simulation: gone.html]', path: 'gone.html', resolution: { ok: false, reason: 'missing' } },
      { ordinal: 3, source: '[Embed: https://x.y/z]', path: 'https://x.y/z', resolution: { ok: false, reason: 'web-address' } },
    ],
  })
  expect((await cap.execute({ path: 'nope.md' }, ctx)).isError).toBe(true)
})

// ---- Review round 1 ---------------------------------------------------------------------------

test('scanWidgets takes its widgets from the model: no widget the model does not have', () => {
  for (const text of ['<div>\n// comment\n[Simulation: a.html]\n</div>', '- list\n// comment\n[Simulation: a.html]']) {
    expect(widgets(text)).toEqual([])
    expect(scanWidgets(text)).toEqual([])
  }
})

test('scanWidgets and the model agree; a footnote copy of a widget line is not listed', () => {
  const widgetLine = '[Simulation: a.html]'
  const text = [
    '---', 'title: x', '---', '', '', '// a note', 'Intro[^1].', '', '', '', `[^1]: A note\n${widgetLine}`, '',
    widgetLine, '   ', '', '```', '[Simulation: no.html]', '```', '', '// again', '[Embed: https://x.y]', '',
  ].join('\n')
  expect(widgets(text).map((b) => b.kind === 'widget' && b.path)).toEqual(['a.html', 'https://x.y'])
  expect(scanWidgets(text).map((w) => [w.ordinal, w.path])).toEqual([[1, 'a.html'], [2, 'https://x.y']])
})

test('trailing spaces on a widget line after blank lines still list it, with the source trimmed', () => {
  const text = 'Intro.\n\n\n   \n[Simulation: a.html]   \n\nEnd.'
  expect(scanWidgets(text)).toEqual([{ ordinal: 1, source: '[Simulation: a.html]', path: 'a.html' }])
})

test('CRLF and lone-CR line endings still make a widget, ', () => {
  for (const eol of ['\r\n', '\r']) {
    const text = ['Before.', '', '[Simulation: a.html]', '', 'After.'].join(eol)
    expect(widgets(text)).toMatchObject([{ path: 'a.html', source: '[Simulation: a.html]' }])
    expect(scanWidgets(text)).toEqual([{ ordinal: 1, source: '[Simulation: a.html]', path: 'a.html' }])
  }
  expect(widgets('[Simulation: a.html]\r\n[Simulation: b.html]\r\n')).toHaveLength(2)
})

test('a widget line is literal: wikilink brackets in it are not sealed', () => {
  const text = '[Simulation: [[part]].html]'
  expect(widgets(text)).toMatchObject([{ path: '[[part]].html', source: text }])
  expect(toPlain(text)).toContain(text)
  expect(toHtml(text).html).toContain(text)
  expect(toRtf(text)).toContain(text)
})

test('widgets.list returns workspace-relative paths only, and a sanitised error for a missing document', async () => {
  await writeFile(join(root, 'essays/doc.md'), '[Simulation: a.html]\n\n[Simulation: ../../evil.html]\n')
  const cap = buildWriteFlexManifest(new Workspace(root)).capabilities.find((c): c is Capability => c.name === 'widgets.list')
  if (!cap) throw new Error('missing widgets.list')
  const result = await cap.execute({ path: 'essays/doc.md' }, ctx)
  expect(result.text).not.toContain(root)
  expect(JSON.parse(result.text).widgets[0].resolution).toEqual({ ok: true, relativePath: 'essays/a.html' })
  const missing = await cap.execute({ path: 'essays/nope.md' }, ctx)
  expect(missing.isError).toBe(true)
  expect(missing.text).not.toContain(root)
  expect(missing.text).toContain('essays/nope.md')
})

test('a directory named like an HTML file is not a widget', async () => {
  await mkdir(join(root, 'essays/dir.html'))
  expect(await resolveWidget(root, 'essays/doc.md', 'dir.html')).toEqual({ ok: false, reason: 'not-html' })
})

test('widgets.list reports an absolute input path workspace-relative, or as outside with no path', async () => {
  const cap = buildWriteFlexManifest(new Workspace(root)).capabilities.find((c): c is Capability => c.name === 'widgets.list')
  if (!cap) throw new Error('missing widgets.list')
  const inside = await cap.execute({ path: join(root, 'essays/nope.md') }, ctx)
  expect(inside.isError).toBe(true)
  expect(inside.text).not.toContain(root)
  expect(inside.text).toContain('essays/nope.md')
  const out = await cap.execute({ path: join(outside, 'x.md') }, ctx)
  expect(out.isError).toBe(true)
  expect(out.text).not.toContain(outside)
  expect(out.text).toContain('outside the open Workspace')
})
