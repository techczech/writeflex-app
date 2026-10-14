import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { mermaidSkeleton, mermaidType } from '../../src/renderer/src/editor/object-editors/mermaid-editor'
import { indentNode, moveNode, newSibling, outdentNode } from '../../src/renderer/src/editor/object-editors/markmap-editor'
import { normaliseTableMarkup, parseTable, parseTablePaste, serialiseTable, moveColumn, moveRow } from '../../src/renderer/src/editor/object-editors/table-editor'
import { renumberFootnotes } from '../../src/renderer/src/editor/insert-objects'
import { innerSource, objectEditorRegistry, objectEditorReplacement, serialiseBlock } from '../../src/renderer/src/editor/object-editors/registry'
import { detectLivePreviewBlocks, malformedFrontmatterRange, objectEditorCommitRefusal, shouldEscapeAboveBlock } from '../../src/renderer/src/editor/live-preview'
import { objectEditorKeyAction } from '../../src/renderer/src/editor/object-editors/shell'

test('table round-trips multiline cells and alignment markers', () => {
  const source = '| Name | Notes | Score |\n| :--- | :---: | ---: |\n| Ada | first<br>second | 10 |'
  const table = parseTable(source)
  expect(table).toEqual({
    cells: [['Name', 'Notes', 'Score'], ['Ada', 'first\nsecond', '10']],
    alignments: ['left', 'center', 'right'],
  })
  expect(serialiseTable(table!)).toBe(source)
})

test('table parsing requires a pipe-bearing header and keeps valid one- and two-column tables', () => {
  expect(parseTable('A\n|---|')).toBeNull()
  expect(parseTable('| A |\n| --- |\n| one |')).toMatchObject({ cells: [['A'], ['one']] })
  expect(parseTable('| A | B |\n| --- | --- |\n| one | two |')).toMatchObject({ cells: [['A', 'B'], ['one', 'two']] })
  expect(parseTable('Heading\n---')).toBeNull()
  expect(parseTable('---\n---')).toBeNull()
})

test('table paste accepts pipe markup and TSV', () => {
  expect(parseTablePaste('A\tB\n1\t2')).toEqual([['A', 'B'], ['1', '2']])
  expect(parseTablePaste('| A | B |\n| --- | --- |\n| 1 | 2 |')).toEqual([['A', 'B'], ['1', '2']])
})

test('table structural moves preserve row and column contents', () => {
  const table = { cells: [['A', 'B'], ['1', '2'], ['3', '4']], alignments: ['left', 'right'] as const }
  expect(moveColumn(table, 0, 1).cells).toEqual([['B', 'A'], ['2', '1'], ['4', '3']])
  expect(moveRow(table, 2, -1).cells).toEqual([['A', 'B'], ['3', '4'], ['1', '2']])
  expect(moveRow(table, 0, 1)).toEqual(table)
})

test('markmap transforms create, indent, outdent, and move whole subtrees', () => {
  expect(newSibling('- A\n  - B\n- C', 0)).toEqual({ text: '- A\n  - \n  - B\n- C', index: 1 })
  expect(indentNode('- A\n- B', 1)).toBe('- A\n  - B')
  expect(indentNode('- A\n    - B', 1)).toBe('- A\n  - B')
  expect(outdentNode('- A\n    - B', 1)).toBe('- A\n  - B')
  expect(moveNode('- A\n  - child\n- B', 0, 1)).toBe('- B\n- A\n  - child')
})

test('Mermaid type skeletons and detection follow the picker contract', () => {
  expect(mermaidSkeleton('sequence')).toBe('sequenceDiagram\n  Alice->>Bob: Hello')
  expect(mermaidSkeleton('flowchart-down')).toStartWith('flowchart TD')
  expect(mermaidType('stateDiagram-v2\n  [*] --> Ready')).toBe('state')
  expect(mermaidType('nonsense')).toBeNull()
})

function applyFootnotes(doc: string): string {
  const spec = renumberFootnotes(doc)
  if (!spec) return doc
  return EditorState.create({ doc }).update({ changes: spec.changes }).newDoc.toString()
}

test('footnotes renumber by first marker and reorder definition blocks at document end', () => {
  const doc = 'Second[^8], then first[^3].\n\n[^3]: three\n  continuation\n\n[^8]: eight'
  expect(applyFootnotes(doc)).toBe('Second[^1], then first[^2].\n\n[^1]: eight\n\n[^2]: three\n  continuation')
})

test('footnote definitions do not create order and unused definitions retain their numbers after used ones', () => {
  const doc = 'Used[^7].\n\n[^9]: unused\n\n[^7]: used\n\n[^11]: also unused'
  expect(applyFootnotes(doc)).toBe('Used[^1].\n\n[^1]: used\n\n[^9]: unused\n\n[^11]: also unused')
  expect(renumberFootnotes('No markers.\n\n[^4]: definition only')).toBeNull()
})

test('frontmatter ObjectEditor owns and restores its delimiters', () => {
  const block = { kind: 'frontmatter' as const, from: 0, to: 24, source: '---\ntitle: River\n---\n' }
  expect(innerSource(block)).toBe('title: River')
  expect(serialiseBlock(block, 'title: Thames')).toBe('---\ntitle: Thames\n---')
})

test('SVG ObjectEditor round-trips inner source through its fenced block', () => {
  const source = '```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```\n'
  const block = { kind: 'svg' as const, language: 'svg', from: 0, to: source.length, source }
  expect(innerSource(block)).toBe('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
  expect(serialiseBlock(block, '<svg><circle r="4"/></svg>')).toBe('```svg\n<svg><circle r="4"/></svg>\n```')
  expect(objectEditorReplacement(block, innerSource(block))).toBe(source)
  expect(objectEditorRegistry).toContainEqual({ kind: 'svg', label: 'SVG' })
})

test('whole-document frontmatter replacement remains fenced with or without a final newline', () => {
  const withoutNewline = { kind: 'frontmatter' as const, from: 0, to: 29, source: '---\n"another one": original\n---' }
  const withNewline = { ...withoutNewline, to: 30, source: `${withoutNewline.source}\n` }
  expect(objectEditorReplacement(withoutNewline, '"another one": edited')).toBe('---\n"another one": edited\n---')
  expect(objectEditorReplacement(withNewline, '"another one": edited')).toBe('---\n"another one": edited\n---\n')
  for (const block of [withoutNewline, withNewline]) {
    const replacement = objectEditorReplacement(block, innerSource(block))
    expect(detectLivePreviewBlocks(EditorState.create({ doc: replacement })).map((item) => item.kind)).toEqual(['frontmatter'])
  }
})

test('empty frontmatter serialisation always emits both fences', () => {
  const block = { kind: 'frontmatter' as const, from: 0, to: 7, source: '---\n---' }
  expect(serialiseBlock(block, '')).toBe('---\n\n---')
  expect(detectLivePreviewBlocks(EditorState.create({ doc: serialiseBlock(block, '') })).map((item) => item.kind)).toEqual(['frontmatter'])
})

test('ObjectEditor refuses stale and destructive empty replacements before dispatch', () => {
  const block = { kind: 'frontmatter' as const, from: 0, to: 21, source: '---\ntitle: River\n---' }
  expect(objectEditorCommitRefusal(block, block.source, '   \n')).toMatch(/empty/i)
  expect(objectEditorCommitRefusal(block, 'A different active file', '---\ntitle: Thames\n---')).toMatch(/stale/i)
  expect(objectEditorCommitRefusal(block, block.source, '---\ntitle: Thames\n---')).toBeNull()
})

test('a leading metadata block has no keyboard escape position above it', () => {
  expect(shouldEscapeAboveBlock({ kind: 'frontmatter', from: 0 })).toBe(false)
  expect(shouldEscapeAboveBlock({ kind: 'table', from: 0 })).toBe(true)
  expect(shouldEscapeAboveBlock({ kind: 'frontmatter', from: 4 })).toBe(false)
})

test('offset or unclosed metadata-like fences are identified for plain-source fallback styling', () => {
  expect(malformedFrontmatterRange('oops\n---\ntitle: River\n---\nBody')).toEqual({ from: 5, to: 26 })
  expect(malformedFrontmatterRange('---\ntitle: River')).toEqual({ from: 0, to: 16 })
  expect(malformedFrontmatterRange('Prose\n\n---\n\nMore')).toBeNull()
})

test('ObjectEditor keyboard grammar commits only with Command-Enter and reserves Escape for table browse', () => {
  expect(objectEditorKeyAction('Enter', true, false)).toBe('commit')
  expect(objectEditorKeyAction('Enter', false, false)).toBe('none')
  expect(objectEditorKeyAction('Escape', false, true)).toBe('handled')
  expect(objectEditorKeyAction('Escape', false, false)).toBe('none')
})

test('table repair: a header/separator width mismatch commits as a valid table of the widest row', () => {
  const after = '| Cowork planning profile | Credits per person per day | Usage per person per month \n| :--- | :--- | :--- | :--- |\n| Light | 100–280 | $22–$61.60 |\n| Medium | 280–400 | $61.60–$88 |\n| Heavy | 400–700 | $88–$154 |\n'
  const fixed = normaliseTableMarkup(after)!
  expect(fixed.split('\n')[1]).toBe('| :--- | :--- | :--- |')
  expect(parseTable(fixed)).toMatchObject({ cells: [['Cowork planning profile', 'Credits per person per day', 'Usage per person per month'], ['Light', '100–280', '$22–$61.60'], ['Medium', '280–400', '$61.60–$88'], ['Heavy', '400–700', '$88–$154']] })
  expect(normaliseTableMarkup('| A | B | C |\n\n| --- | --- | --- | --- |\n| 1 | 2 | 3 |')).toBe('| A | B | C |\n| :--- | :--- | :--- |\n| 1 | 2 | 3 |')
})

test('table repair pads ragged rows, keeps alignment markers and refuses non-tables', () => {
  expect(normaliseTableMarkup('| A | B | C |\n| :---: | ---: | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |')).toBe('| A | B | C |  |\n| :---: | ---: | :--- | :--- |\n| 1 |  |  |  |\n| 1 | 2 | 3 | 4 |')
  expect(normaliseTableMarkup('just some text\nmore text')).toBeNull()
  expect(normaliseTableMarkup('| A | B |')).toBeNull()
  expect(serialiseTable({ cells: [['A'], ['1', '2']], alignments: ['right'] })).toBe('| A |  |\n| ---: | :--- |\n| 1 | 2 |')
})
