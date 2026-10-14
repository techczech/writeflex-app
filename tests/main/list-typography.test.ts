import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { insertNewlineContinueMarkup, markdown } from '@codemirror/lang-markdown'
import { BLOCK_INDENT_STEP_PX, LIST_NESTING_PX, listLineIndent, listLineStyle } from '../../src/renderer/src/editor/list-typography'

describe('list line indentation', () => {
  test('indents by the blockquote step per level, level one already one step in, and aligns wraps under item text', () => {
    expect(LIST_NESTING_PX).toBe(BLOCK_INDENT_STEP_PX)
    expect(listLineIndent('- **Definition:** Working memory')).toEqual({ nestingPx: 18, leadingColumns: 0, markerColumns: 2 })
    expect(listLineIndent('  - nested item')).toEqual({ nestingPx: 36, leadingColumns: 2, markerColumns: 2 })
    expect(listLineIndent('    12. numbered item')).toEqual({ nestingPx: 54, leadingColumns: 4, markerColumns: 4 })
  })

  test('includes checkbox syntax in the hanging prefix and ignores ordinary lines', () => {
    expect(listLineIndent('  - [x] complete')).toEqual({ nestingPx: 36, leadingColumns: 2, markerColumns: 6 })
    expect(listLineIndent('paragraph')).toBeNull()
    expect(listLineIndent('  continuation')).toBeNull()
  })

  test('treats marker-only lines exactly like the same list items with text', () => {
    for (const marker of ['- ', '  - ', '    - ', '  1. ', '  - [ ] ']) {
      expect(listLineIndent(marker)).toEqual(listLineIndent(`${marker}text`))
    }
  })

  test('covers the exact marker-only line inserted by Return after a nested item', () => {
    const original = '  - test'
    let state = EditorState.create({
      doc: original,
      selection: { anchor: original.length },
      extensions: [markdown()],
    })

    expect(insertNewlineContinueMarkup({
      state,
      dispatch(transaction) { state = transaction.state },
    })).toBe(true)
    expect(state.doc.line(2).text).toBe('  - ')
    expect(listLineIndent(state.doc.line(2).text)).toEqual({
      nestingPx: 36,
      leadingColumns: 2,
      markerColumns: 2,
    })
  })

  test('computes the visible line decoration for a nested marker-only item', () => {
    const style = listLineStyle('  - ', (prefix) => prefix.length)
    expect(style).toEqual({
      paddingLeftPx: 2 * LIST_NESTING_PX + 2,
      textIndentPx: -4,
    })
  })
})
