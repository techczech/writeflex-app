import { describe, expect, test } from 'bun:test'
import { applyWidgetPlan, insertWidgetInText, planWidgetInsert, relativeEmbedPath, removeWidgetInText, widgetEmbedLine } from '../../src/shared/widget-insert'
import { scanWidgets } from '../../src/shared/markdown/widgets'

const L = '[Simulation: assets/a.html]'
const put = (doc: string, at: number) => applyWidgetPlan(doc, planWidgetInsert(doc, at, L))

describe('relative embed path', () => {
  test('from a nested document', () => {
    expect(relativeEmbedPath('notes/a.md', 'notes/assets/x.html')).toBe('assets/x.html')
    expect(relativeEmbedPath('notes/deep/a.md', 'notes/assets/x.html')).toBe('../assets/x.html')
    expect(relativeEmbedPath('a.md', 'widgets/x.html')).toBe('widgets/x.html')
    expect(relativeEmbedPath('a/b/c.md', 'x.html')).toBe('../../x.html')
  })
  test('line shape', () => {
    expect(widgetEmbedLine('assets/a.html')).toBe(L)
    expect(() => widgetEmbedLine('a\nb')).toThrow()
  })
})

describe('insert transaction', () => {
  test('on a blank line between paragraphs: blank lines either side, one widget', () => {
    const doc = 'One.\n\n\nTwo.\n'
    const next = put(doc, 6)
    expect(next).toBe(`One.\n\n${L}\n\nTwo.\n`)
    expect(next).toContain('One.\n\n' + L + '\n')
    expect(scanWidgets(next)).toHaveLength(1)
  })
  test('caret mid-paragraph goes after the paragraph, never splits it', () => {
    const doc = 'Alpha beta\ngamma delta\n\nNext.\n'
    const next = put(doc, 3)
    expect(next).toBe(`Alpha beta\ngamma delta\n\n${L}\n\nNext.\n`)
  })
  test('caret at the start of a paragraph goes before it', () => {
    expect(put('First.\n\nSecond.\n', 8)).toBe(`First.\n\n${L}\n\nSecond.\n`)
  })
  test('empty document and end of document', () => {
    expect(put('', 0)).toBe(L)
    expect(put('Text.', 5)).toBe(`Text.\n\n${L}`)
    expect(put('Text.\n', 6)).toBe(`Text.\n\n${L}\n`)
  })
  test('inside a code fence goes after the fence; frontmatter is skipped', () => {
    const fenced = '```\ncode\n```\n\nAfter.\n'
    expect(put(fenced, 6)).toBe(`\`\`\`\ncode\n\`\`\`\n\n${L}\n\nAfter.\n`)
    const fm = '---\ntitle: x\n---\n\nBody.\n'
    const next = put(fm, 2)
    expect(next.startsWith('---\ntitle: x\n---\n')).toBe(true)
    expect(scanWidgets(next)).toHaveLength(1)
  })
})

describe('verbs on text', () => {
  const doc = '# T\n\nOne.\n\n[Simulation: a.html]\n\nTwo.\n\n[Simulation: b.html]\n'
  test('insert at start, end and after a widget', () => {
    expect(scanWidgets(insertWidgetInText(doc, 'c.html', 'start')).map((w) => w.path)).toEqual(['c.html', 'a.html', 'b.html'])
    expect(scanWidgets(insertWidgetInText(doc, 'c.html', 'end')).map((w) => w.path)).toEqual(['a.html', 'b.html', 'c.html'])
    expect(scanWidgets(insertWidgetInText(doc, 'c.html', 1)).map((w) => w.path)).toEqual(['a.html', 'c.html', 'b.html'])
    expect(() => insertWidgetInText(doc, 'c.html', 5)).toThrow(/no widget 5/)
  })
  test('remove takes the line and one blank line, and only that widget', () => {
    expect(removeWidgetInText(doc, 1)).toBe('# T\n\nOne.\n\nTwo.\n\n[Simulation: b.html]\n')
    expect(removeWidgetInText(doc, 2)).toBe('# T\n\nOne.\n\n[Simulation: a.html]\n\nTwo.\n')
    expect(() => removeWidgetInText(doc, 3)).toThrow(/no widget 3/)
  })
  test('the same line inside a code fence is not mistaken for the widget', () => {
    const tricky = '```\n[Simulation: a.html]\n```\n\n[Simulation: a.html]\n'
    expect(removeWidgetInText(tricky, 1)).toBe('```\n[Simulation: a.html]\n```\n')
  })
})
