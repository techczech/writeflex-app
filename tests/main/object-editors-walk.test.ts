import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { insertFootnote } from '../../src/renderer/src/editor/insert-objects'
import { newSibling } from '../../src/renderer/src/editor/object-editors/markmap-editor'
import { mermaidSkeleton } from '../../src/renderer/src/editor/object-editors/mermaid-editor'
import { innerSource, objectEditorReplacement } from '../../src/renderer/src/editor/object-editors/registry'
import { moveColumn, parseTable, serialiseTable } from '../../src/renderer/src/editor/object-editors/table-editor'
import { detectLivePreviewBlocks } from '../../src/renderer/src/editor/live-preview'
import { parseFrontmatterEntries, serialiseFrontmatterEntries } from '../../src/shared/object-markup'

// The logic of tests/e2e/object-editors.spec.ts without Electron: what each editor reads from its block and
// writes back, on the e2e's own documents. Focus order, the ⇧⌘→ chord and the grid's drawing stay in the e2e.

describe('table editor', () => {
  test('a multiline cell survives the grid and the file: written as a <br>, read back as two lines', () => {
    const model = parseTable('| A | B |\n| --- | --- |\n| one | two |')!
    model.cells[0][0] = 'top\nbottom'
    const written = serialiseTable(model)
    expect(written).toContain('top<br>bottom')
    expect(parseTable(written)!.cells[0][0]).toBe('top\nbottom') // reopened, the cell holds both lines
  })

  test('Tab from the last cell appends a row, and what is typed in it is a body row of the table', () => {
    const model = parseTable('| A | B |\n| --- | --- |\n| 1 | 2 |')!
    model.cells.push(['', '']) // the appended row
    model.cells[2][0] = '3'
    const rows = serialiseTable(model).split('\n')
    expect(rows).toHaveLength(4) // header, separator, 1 | 2, 3
    expect(rows.at(-1)).toContain('3')
    // The grid sees header + 2 body rows (the separator is not a rendered row).
    expect(parseTable(serialiseTable(model))!.cells).toHaveLength(3)
  })

  test('⇧⌘→ on the header cell moves the column right, header and body together', () => {
    const moved = moveColumn(parseTable('| A | B |\n| --- | --- |\n| 1 | 2 |')!, 0, 1)
    expect(moved.cells).toEqual([['B', 'A'], ['2', '1']])
  })
})

describe('mind map outline and diagram skeleton', () => {
  test('↵ on a parent makes its first child, and the Markup tab shows the nested text', () => {
    const source = '- Root\n  - Existing child\n- Last'
    const made = newSibling(source, 0) // ↵ below Root inherits the child depth
    expect(made.index).toBe(1)
    const typed = made.text.split('\n')
    typed[made.index] = '  - New child'
    expect(typed.join('\n')).toBe('- Root\n  - New child\n  - Existing child\n- Last')
  })

  test('the Markup tab\'s text is what the block holds: an edit reads back as the outline', () => {
    const block = { kind: 'markmap' as const, language: 'markmap', from: 0, to: 0, source: '```markmap\n- Root\n  - Existing child\n- Last\n```' }
    expect(innerSource(block)).toBe('- Root\n  - Existing child\n- Last')
    expect(objectEditorReplacement(block, '- Root\n  - Edited child\n  - Existing child\n- Last')).toBe('```markmap\n- Root\n  - Edited child\n  - Existing child\n- Last\n```')
  })

  test('the Sequence diagram plants a sequenceDiagram skeleton', () => {
    expect(mermaidSkeleton('sequence')).toMatch(/sequenceDiagram/)
  })
})

describe('footnotes', () => {
  test('inserted before a later marker, the new one is 1 and the later one renumbers to 2', () => {
    const doc = insertFootnote('Start here. Later[^8].\n\n[^8]: later', 0)
    expect(doc).toContain('[^1]Start here. Later[^2].')
    expect(doc).toContain('[^1]:')
    expect(doc).toContain('[^2]: later')
  })
})

describe('frontmatter', () => {
  const content = '---\ntitle: River\ntags: [water, essays]\n# keep byte-exact\nsettings:\n  nested: true\n---\n\nBody'

  test('renders as a metadata block of its own and reads title, tags and the opaque YAML as separate entries', () => {
    const blocks = detectLivePreviewBlocks(EditorState.create({ doc: content }))
    expect(blocks.map((block) => block.kind)).toEqual(['frontmatter'])
    const entries = parseFrontmatterEntries(innerSource(blocks[0]))
    expect(entries[0]).toEqual({ kind: 'scalar', key: 'title', value: 'River' })
    expect(entries[1]).toEqual({ kind: 'list', key: 'tags', values: ['water', 'essays'] })
    expect(entries[2].kind).toBe('raw')
  })

  test('structured edits write the new values and leave the opaque YAML byte for byte', () => {
    const block = detectLivePreviewBlocks(EditorState.create({ doc: content }))[0]
    const entries = parseFrontmatterEntries(innerSource(block))
    const title = entries.find((entry) => entry.kind === 'scalar' && entry.key === 'title')!
    if (title.kind === 'scalar') title.value = 'River: revised'
    const tags = entries.find((entry) => entry.kind === 'list' && entry.key === 'tags')!
    if (tags.kind === 'list') tags.values.push('draft')
    entries.push({ kind: 'scalar', key: 'status', value: 'working' })
    const replacement = objectEditorReplacement(block, serialiseFrontmatterEntries(entries))
    const written = replacement + content.slice(block.to)
    expect(written).toContain('# keep byte-exact\nsettings:\n  nested: true')
    expect(written).toContain('title: "River: revised"\ntags: [water, essays, draft]')
    expect(written).toContain('status: working')
    expect(written.endsWith('\n\nBody')).toBe(true)
  })

  test('opening the Markup tab and returning without a change leaves the YAML as it was', () => {
    const block = detectLivePreviewBlocks(EditorState.create({ doc: content }))[0]
    const entries = parseFrontmatterEntries(innerSource(block))
    const again = objectEditorReplacement(block, serialiseFrontmatterEntries(entries))
    expect(again + content.slice(block.to)).toContain('# keep byte-exact\nsettings:\n  nested: true')
  })

  test('unparseable frontmatter reads as one raw entry, which the block shows as its source with the fix-raw note', () => {
    const entries = parseFrontmatterEntries('title: [broken')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ kind: 'raw', lines: 'title: [broken' })
  })
})
