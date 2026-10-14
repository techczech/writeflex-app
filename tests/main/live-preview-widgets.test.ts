import { expect, test } from 'bun:test'
import { CodeWidget, FrontmatterWidget, ImageWidget, MERMAID_CONFIG, TableWidget, parseGfmTable } from '../../src/renderer/src/editor/live-preview-widgets'

test('table parser returns header and body cells and refuses malformed source', () => {
  expect(parseGfmTable('| A | B |\n| --- | --- |\n| 1 | 2 |')).toEqual({ header: ['A', 'B'], rows: [['1', '2']] })
  expect(parseGfmTable('| A |\n| nope |')).toBeNull()
})

test('widget equality is source-based', () => {
  expect(new TableWidget('| A |\n|---|').eq(new TableWidget('| A |\n|---|'))).toBe(true)
  expect(new CodeWidget('```ts\nx\n```', 'ts').eq(new CodeWidget('```ts\ny\n```', 'ts'))).toBe(false)
  expect(new ImageWidget('![a](x.png)', 'wf-asset://token/x.png', 'a').eq(new ImageWidget('![a](x.png)', 'wf-asset://token/x.png', 'a'))).toBe(true)
  expect(new FrontmatterWidget('---\ntitle: A\n---', false).eq(new FrontmatterWidget('---\ntitle: A\n---', false))).toBe(true)
})

test('Mermaid disables its global error DOM so inline source and message stay the only failure surface', () => {
  expect(MERMAID_CONFIG.suppressErrorRendering).toBe(true)
})
