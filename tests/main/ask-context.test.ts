import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { livePreview } from '../../src/renderer/src/editor/live-preview'
import { placeAt, type Place } from '../../src/renderer/src/commands/place'
import { ASK_CONTEXT_LIMIT, SHORTENED_NOTE, askComposerText, askContextAt, askLabelAt, cutAtBlock } from '../../src/renderer/src/commands/ask-context'
import { actionLayoutAt } from '../../src/renderer/src/commands/actions-here'

// Actions here ticket 03: the context the composer receives, per place. Nothing here sends anything.
const DOC = `# The long way

## The wall builders

Every wall up here was built by hand, with [[Dry stone]] beside it.

![The ridge](ridge.png)

- first item
  - its child
- [ ] buy string

> A quoted line.

| Stone | Count |
|-------|-------|
| cope  | 12    |

\`\`\`js
const stones = 12
\`\`\`

### A subsection

Inside it.

## Weather

After.
`

const stateAt = (needle: string, offset = 1, to?: number): EditorState => {
  const anchor = DOC.indexOf(needle) + offset
  const state = EditorState.create({ doc: DOC, selection: to === undefined ? { anchor } : { anchor, head: anchor + to }, extensions: [markdown({ extensions: markdownDialect() }), livePreview({ assetBaseUrl: () => '' })] })
  ensureSyntaxTree(state, DOC.length, 5_000)
  return state.update({}).state
}
const contextAt = (place: Place, state: EditorState): string => { expect(placeAt(state)).toBe(place); return askContextAt(state, place) }

describe('what is quoted, per place', () => {
  test('a selection: the selected text only', () => {
    expect(contextAt('selection', stateAt('Every wall', 0, 10))).toBe('Every wall')
  })
  test('a paragraph: the block', () => {
    expect(contextAt('paragraph', stateAt('Every wall', 3))).toBe('Every wall up here was built by hand, with [[Dry stone]] beside it.')
  })
  test('a link: the block it is in', () => {
    expect(contextAt('link', stateAt('Dry stone', 3))).toBe('Every wall up here was built by hand, with [[Dry stone]] beside it.')
  })
  test('a list item with its children, a task item, a quotation', () => {
    expect(contextAt('list-item', stateAt('first item', 3))).toBe('- first item\n  - its child')
    expect(contextAt('task-item', stateAt('buy string', 3))).toBe('- [ ] buy string')
    expect(contextAt('quotation', stateAt('A quoted', 3))).toBe('> A quoted line.')
  })
  test('a heading: the section up to the next heading of the same or a higher level, subsections included', () => {
    const section = contextAt('heading', stateAt('The wall builders', 3))
    expect(section.startsWith('## The wall builders')).toBe(true)
    expect(section).toContain('### A subsection\n\nInside it.')
    expect(section).not.toContain('## Weather')
    expect(section.endsWith('Inside it.')).toBe(true)
  })
  test('a table and a code block: the source; an image: its path', () => {
    expect(contextAt('table', stateAt('cope', 2))).toBe('| Stone | Count |\n|-------|-------|\n| cope  | 12    |')
    expect(contextAt('code-block', stateAt('const stones', 3))).toContain('const stones = 12')
    expect(contextAt('image', stateAt('The ridge', 3))).toBe('ridge.png')
  })
  test('an empty document: nothing', () => {
    expect(askContextAt(EditorState.create({ doc: '' }), 'empty-document')).toBe('')
    expect(askComposerText('')).toBe('')
  })
})

describe('the composer text', () => {
  test('the context is quoted line by line, a blank line follows for the question', () => {
    expect(askComposerText('One\n\nTwo')).toBe('> One\n>\n> Two\n\n')
  })
  test('an under-limit text is not cut and carries no note', () => {
    expect(askComposerText('x'.repeat(ASK_CONTEXT_LIMIT))).not.toContain(SHORTENED_NOTE)
  })
  test('a longer text is cut at a block boundary, at most 4,000 characters, with a visible note', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => `Block ${i} ${'w'.repeat(400)}`)
    const cut = cutAtBlock(blocks.join('\n\n'))
    expect(cut.shortened).toBe(true)
    expect(cut.text.length).toBeLessThanOrEqual(ASK_CONTEXT_LIMIT)
    expect(blocks.some((block) => block === cut.text.split('\n\n').at(-1))).toBe(true) // ends on a whole block
    const text = askComposerText(blocks.join('\n\n'))
    expect(text).toContain(`\n${SHORTENED_NOTE}\n`)
    expect(text).not.toContain('Block 11')
  })
  test('one block longer than the limit is cut at a line, else at the limit', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'y'.repeat(30)}`).join('\n')
    const byLine = cutAtBlock(lines)
    expect(byLine.text.length).toBeLessThanOrEqual(ASK_CONTEXT_LIMIT)
    expect(lines.startsWith(byLine.text) && lines[byLine.text.length] === '\n').toBe(true)
    expect(cutAtBlock('z'.repeat(ASK_CONTEXT_LIMIT + 50)).text).toHaveLength(ASK_CONTEXT_LIMIT)
  })
})

describe('the row', () => {
  test('its label varies by place', () => {
    expect(askLabelAt('paragraph')).toBe('Ask the agent about this…')
    expect(askLabelAt('heading')).toBe('Ask the agent about this section…')
    expect(askLabelAt('table')).toBe('Ask the agent about this table…')
    expect(askLabelAt('code-block')).toBe('Ask the agent about this block…')
    expect(askLabelAt('image')).toBe('Ask the agent about this image…')
    expect(askLabelAt('empty-document')).toBe('Ask the agent…')
  })
  test('it is offered at exactly the listed places, wears the agent icon, and carries its place’s label', () => {
    const listed: Array<[Place, EditorState | null]> = [
      ['paragraph', stateAt('Every wall', 3)], ['selection', stateAt('Every wall', 0, 10)], ['heading', stateAt('The wall builders', 3)],
      ['list-item', stateAt('first item', 3)], ['task-item', stateAt('buy string', 3)], ['quotation', stateAt('A quoted', 3)],
      ['table', stateAt('cope', 2)], ['code-block', stateAt('const stones', 3)], ['link', stateAt('Dry stone', 3)], ['image', stateAt('The ridge', 3)],
      ['empty-document', EditorState.create({ doc: '' })],
    ]
    for (const [place, state] of listed) {
      const row = actionLayoutAt(place, state, {}).groups.flatMap((group) => group.rows).find((item) => item.id === 'agent.askHere')
      expect(row, place).toBeDefined()
      expect(row!.label, place).toBe(askLabelAt(place))
      expect(row!.agent, place).toBe(true)
    }
    for (const [place, state] of [['metadata', stateAt('title', 1)], ['file', null], ['folder', null], ['outline-row', stateAt('The wall builders', 3)]] as Array<[Place, EditorState | null]>) {
      expect(actionLayoutAt(place, state, {}).groups.flatMap((group) => group.rows).some((item) => item.id === 'agent.askHere'), place).toBe(false)
    }
  })
})
