// The widget block's seams that need no browser (interactive-widgets ticket 03): which lines the live
// preview turns into widget blocks, how a typed path becomes the workspace path the file-change events
// use, and the Open file channel (resolved like the run, refused the same way).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { detectLivePreviewBlocks } from '../../src/renderer/src/editor/live-preview'
import { widgetWorkspacePath } from '../../src/renderer/src/widgets/widget-block'
import { openWidgetFile, removeOpenedWidgetCopies } from '../../src/main/widget-open'

const blocksOf = (text: string) => detectLivePreviewBlocks(EditorState.create({ doc: text, extensions: [markdown({ extensions: GFM })] }))
  .filter((block) => block.kind === 'widget')

test('an embed line alone in its paragraph is a widget block, one per line', () => {
  const text = 'Before\n\n[Simulation: assets/a.html]\n\nAfter\n\n[Simulation: b.html]\n[simulation:  c.htm ]\n'
  expect(blocksOf(text).map((block) => [block.url, block.source])).toEqual([
    ['assets/a.html', '[Simulation: assets/a.html]'],
    ['b.html', '[Simulation: b.html]'],
    ['c.htm', '[simulation:  c.htm ]'],
  ])
})

test('anything else is not a widget: trailing words, inside a paragraph, in code, web addresses, a list item', () => {
  expect(blocksOf('Text [Simulation: a.html] more\n')).toEqual([])
  expect(blocksOf('Intro line\n[Simulation: a.html]\n')).toEqual([])
  expect(blocksOf('```\n[Simulation: a.html]\n```\n')).toEqual([])
  expect(blocksOf('[Embed: https://example.com/page]\n')).toEqual([])
  expect(blocksOf('- [Simulation: a.html]\n')).toEqual([])
  expect(blocksOf('[Simulation: a.html] and more\n')).toEqual([])
})

test('a typed path becomes the workspace path beside the document', () => {
  expect(widgetWorkspacePath('notes/doc.md', 'assets/a.html')).toBe('notes/assets/a.html')
  expect(widgetWorkspacePath('notes/doc.md', './a.html')).toBe('notes/a.html')
  expect(widgetWorkspacePath('notes/sub/doc.md', '../a.html')).toBe('notes/a.html')
  expect(widgetWorkspacePath('doc.md', 'a.html')).toBe('a.html')
})

let base: string
let root: string
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-widget-open-'))
  root = join(base, 'workspace')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'a.html'), '<title>A</title>')
  await writeFile(join(root, 'assets', 'a.txt'), 'x')
  await writeFile(join(base, 'outside.html'), '<title>x</title>')
})
afterAll(async () => { await rm(base, { recursive: true, force: true }) })

test('Open file opens only a file the widget could run, as a private copy, never the workspace path', async () => {
  const opened: string[] = []
  expect(await openWidgetFile(root, 'doc.md', 'assets/a.html', (url) => opened.push(url))).toEqual({ ok: true })
  expect(opened.length).toBe(1)
  expect(opened[0].startsWith('file://')).toBe(true)
  expect(opened[0].includes('/workspace/')).toBe(false)
  expect(opened[0].endsWith('-a.html')).toBe(true)
  for (const raw of ['../outside.html', 'assets/a.txt', 'assets/missing.html', 'https://example.com/a.html']) {
    expect(await openWidgetFile(root, 'doc.md', raw, (url) => opened.push(url))).toEqual({ ok: false })
  }
  expect(opened.length).toBe(1)
  await removeOpenedWidgetCopies()
})
