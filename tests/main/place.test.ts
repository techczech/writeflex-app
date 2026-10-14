import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { livePreview } from '../../src/renderer/src/editor/live-preview'
import { EVERYWHERE, NOT_BY_PLACE, PLACES, PLACE_LABELS, type Place, type PlaceDeclaration } from '../../src/renderer/src/commands/command-places'
import { actionGroupOf, actionsAmong, actionsAt, placeAt, placeLabel, probePlace, type PaneRow } from '../../src/renderer/src/commands/place'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { setWikilinkResolutions, wikilinkField } from '../../src/renderer/src/editor/wikilinks'

// One document with every construct a caret can be on, nested ones included.
const FIXTURE = `---
title: The long way
---

# The long way

## The wall builders [the map](https://example.org/map)

Every wall was built by hand, see [the survey](https://example.org/s) and [[Dry stone]] with a ![stone](inline.png) beside it.

![The ridge](ridge.png)

- first item
  - nested item
- [ ] buy string
- [x] sharpen the chisel

1. numbered item

> A quoted line.
> - a quoted item with [a quoted link](https://example.org/q)
> # A quoted heading

- outer item
  > quotation inside an item

| Stone | Count |
|-------|-------|
| cope  | 12    |
a line touching the table

\`\`\`js
# not a heading

const stones = 12
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

---

    indented code

Setext top
==========

Setext second
-------------

<div>html</div>

Last paragraph.
`

const editorState = (doc: string, anchor: number, head = anchor): EditorState => {
  const state = EditorState.create({ doc, selection: { anchor, head }, extensions: [markdown({ extensions: markdownDialect() }), livePreview({ assetBaseUrl: () => '' })] })
  // The parser runs ahead in the state's parse context; the next transaction publishes its tree,
  // as any selection change does in the live editor.
  ensureSyntaxTree(state, doc.length, 5_000)
  const parsed = state.update({}).state
  if (syntaxTree(parsed).length < doc.length) throw new Error('fixture not fully parsed')
  return parsed
}
/** The state with the caret `offset` characters into the first occurrence of `needle`. */
const caretIn = (needle: string, offset = 1): EditorState => {
  const index = FIXTURE.indexOf(needle)
  if (index < 0) throw new Error(`fixture has no ${needle}`)
  return editorState(FIXTURE, index + offset)
}
/** The fixture with the wikilink field on, as the live editor has it; `resolved` says whether [[Dry stone]] names a file. */
const withWikilinks = (resolved: boolean): EditorState => {
  const doc = FIXTURE
  const base = EditorState.create({ doc, selection: { anchor: doc.indexOf('Dry stone') + 2 }, extensions: [markdown({ extensions: markdownDialect() }), livePreview({ assetBaseUrl: () => '' }), wikilinkField] })
  ensureSyntaxTree(base, doc.length, 5_000)
  const parsed = base.update({}).state
  return parsed.update({ effects: setWikilinkResolutions.of(resolved ? [{ target: 'Dry stone', display: 'Dry stone', to: '/notes/dry-stone.md' }] : []) }).state
}
const placeIn = (needle: string, offset = 1): Place => placeAt(caretIn(needle, offset))

describe('placeAt: one place for every construct in the fixture', () => {
  const cases: Array<[string, Place, string, number?]> = [
    ['a level-1 heading', 'heading-top', '# The long way', 4],
    ['a level-1 heading, caret at the start of the line', 'heading-top', '# The long way', 0],
    ['a level-1 heading, caret at the end of the line', 'heading-top', '# The long way', '# The long way'.length],
    ['a level-2 heading on its plain text (state 18)', 'heading', 'The wall builders', 3],
    ['a link inside a heading: the link wins', 'link', 'the map', 2],
    ['a paragraph (state 19)', 'paragraph', 'Every wall', 3],
    ['a link inside a paragraph', 'link', 'the survey', 2],
    ['the end of a link counts as on it', 'link', '(https://example.org/s)', '(https://example.org/s)'.length],
    ['a wikilink', 'link', 'Dry stone', 2],
    ['a picture in running text belongs to its paragraph', 'paragraph', 'stone](inline', 2],
    ['a paragraph that is only a picture', 'image', 'The ridge', 2],
    ['a list item', 'list-item', 'first item', 2],
    ['a list item, caret on its marker', 'list-item', '- first item', 0],
    ['a nested list item', 'list-item', 'nested item', 2],
    ['a numbered list item', 'list-item', 'numbered item', 2],
    ['a task item', 'task-item', 'buy string', 2],
    ['a ticked task item', 'task-item', 'sharpen', 2],
    ['a quotation', 'quotation', 'A quoted line', 2],
    ['a quotation, caret on its mark', 'quotation', '> A quoted line', 0],
    ['a list item inside a quotation: the item wins', 'list-item', 'a quoted item', 2],
    ['a link inside a list item inside a quotation: the link wins', 'link', 'a quoted link', 2],
    ['a heading inside a quotation: the heading wins', 'heading-top', 'A quoted heading', 2],
    ['a quotation inside a list item: the quotation wins', 'quotation', 'quotation inside an item', 2],
    ['a table cell', 'table', 'cope', 2],
    ['a table header', 'table', 'Stone', 2],
    ['a prose line touching a table is not the table', 'paragraph', 'a line touching', 2],
    ['a code block', 'code-block', 'const stones', 2],
    ['a heading-shaped line inside a code block', 'code-block', '# not a heading', 2],
    ['a blank line inside a code block', 'code-block', '# not a heading\n', '# not a heading\n'.length],
    ['a diagram block', 'code-block', 'graph TD', 2],
    ['the metadata', 'metadata', 'title:', 2],
    ['the metadata, on its closing fence', 'metadata', '---\n\n# The long way', 3],
    ['a divider', 'paragraph', '---\n\n    indented', 1],
    ['an indented code block', 'paragraph', 'indented code', 2],
    ['a setext level-1 heading', 'heading-top', 'Setext top', 2],
    ['a setext level-2 heading', 'heading', 'Setext second', 2],
    ['an HTML block', 'paragraph', '<div>', 2],
    ['a blank line between paragraphs', 'paragraph', '\n\nLast paragraph', 1],
    ['the last paragraph', 'paragraph', 'Last paragraph', 2],
  ]
  for (const [name, place, needle, offset] of cases) test(name, () => expect(placeIn(needle, offset ?? 1)).toBe(place))

  test('the fixture covers every place the caret can be in', () => {
    const covered = new Set<Place>(cases.map(([, place]) => place))
    covered.add('selection').add('empty-document')
    expect(PLACES.filter((place) => !covered.has(place))).toEqual(['file', 'folder', 'focused-folder', 'outline-row'])
  })
})

describe('placeAt: selections, empty documents and pane rows', () => {
  const inHeading = FIXTURE.indexOf('The wall builders')

  test('a non-empty selection is its own place and wins over what it sits in', () => {
    expect(placeAt(editorState(FIXTURE, inHeading, inHeading + 8))).toBe('selection')
    expect(placeAt(editorState(FIXTURE, FIXTURE.indexOf('the survey'), FIXTURE.indexOf('the survey') + 3))).toBe('selection')
    expect(placeAt(editorState(FIXTURE, FIXTURE.indexOf('title:'), FIXTURE.indexOf('title:') + 3))).toBe('selection')
  })

  test('a document with no text is an empty document, and one with text is not', () => {
    expect(placeAt(editorState('', 0))).toBe('empty-document')
    expect(placeAt(editorState('\n \n', 1))).toBe('empty-document')
    expect(placeAt(editorState('a', 0))).toBe('paragraph')
    expect(placeAt(editorState(`${'\n'.repeat(400)}`, 3))).toBe('paragraph')
  })

  test('a focused row of the Files pane or the Outline gives the row’s place, not the editor’s', () => {
    const state = editorState(FIXTURE, inHeading + 3)
    const rows: Array<[PaneRow, Place]> = [
      [{ kind: 'file' }, 'file'],
      [{ kind: 'folder' }, 'folder'],
      [{ kind: 'folder', focused: false }, 'folder'],
      [{ kind: 'folder', focused: true }, 'focused-folder'],
      [{ kind: 'outline-row' }, 'outline-row'],
    ]
    for (const [row, place] of rows) expect(placeAt(state, row)).toBe(place)
    expect(placeAt(editorState(FIXTURE, inHeading, inHeading + 4), { kind: 'file' })).toBe('file')
    expect(placeAt(state, null)).toBe('heading')
  })

  test('an unclosed opening fence is not metadata, and nor is text after the block', () => {
    expect(placeAt(editorState('---\ntitle: x\n\nBody text', 6))).not.toBe('metadata')
    expect(placeAt(editorState('---\ntitle: x\n---\n\nBody text', 20))).toBe('paragraph')
    expect(placeAt(editorState('---\ntitle: x\n---\n\nBody text', 6))).toBe('metadata')
  })

  test('every place has a label in the drawing’s wording', () => {
    expect(placeLabel('heading')).toBe('On a heading')
    expect(placeLabel('paragraph')).toBe('In a paragraph')
    expect(placeLabel('file')).toBe('On a file')
    for (const place of PLACES) expect(PLACE_LABELS[place], place).toMatch(/^(On|In|With) (a|an|the) [a-z -]+$/)
  })
})

describe('placeAt is cheap: it walks the caret’s ancestors, never the tree', () => {
  const block = '## Section\n\nA paragraph with [a link](https://example.org) in it.\n\n- an item\n  - a nested item\n\n> - a quoted item\n\n```\ncode\n```\n\n'
  const long = block.repeat(Math.ceil(5_000 / (block.split('\n').length - 1)) + 1)

  test('on a 5,000-line document every caret costs a handful of nodes, the same at the end as at the start', () => {
    expect(long.split('\n').length).toBeGreaterThan(5_000)
    const needles = ['Section', 'A paragraph', 'a link', 'an item', 'a nested item', 'a quoted item', 'code']
    let worst = 0
    for (const from of [0, Math.floor(long.length / 2), long.length - block.length]) {
      for (const needle of needles) {
        const state = editorState(long, long.indexOf(needle, from) + 2)
        const probe = probePlace(state)
        worst = Math.max(worst, probe.nodesVisited)
        expect(probe.nodesVisited, `${needle} at ${from}`).toBeLessThanOrEqual(12)
      }
    }
    expect(worst).toBeGreaterThan(0)
    // The whole tree has about ten thousand nodes; a walk of it would be caught by the bound above.
    let total = 0
    syntaxTree(editorState(long, 0)).iterate({ enter: () => { total += 1 } })
    expect(total).toBeGreaterThan(5_000)
  })

  test('the same caret gives the same place at both ends of the long document', () => {
    for (const needle of ['Section', 'A paragraph', 'a link', 'an item', 'a quoted item', 'code']) {
      const first = placeAt(editorState(long, long.indexOf(needle) + 2))
      const last = placeAt(editorState(long, long.lastIndexOf(needle) + 2))
      expect(last, needle).toBe(first)
    }
  })

  test('where the parser has not reached the caret, the line’s own text decides without parsing', () => {
    const state = EditorState.create({ doc: long, selection: { anchor: long.lastIndexOf('## Section') + 4 }, extensions: [markdown({ extensions: markdownDialect() })] })
    expect(syntaxTree(state).length).toBeLessThan(long.length)
    const probe = probePlace(state)
    expect(probe).toEqual({ place: 'heading', nodesVisited: 0 })
    const item = EditorState.create({ doc: long, selection: { anchor: long.lastIndexOf('- an item') + 4 }, extensions: [markdown({ extensions: markdownDialect() })] })
    expect(placeAt(item)).toBe('list-item')
  })
})

const ids = (place: Place, state: EditorState | null): string[] => actionsAt(place, state).map((command) => command.id)

describe('actionsAt: the drawn lists', () => {
  // HERE_HEADING, HERE_PARAGRAPH and HERE_FILE in build-mockup-onboarding-hifi-v2.mjs, plus the Insert row.
  const INSERT = 'sheet.Editing.12'
  const DRAWN_FILE = ['file.open', 'file.rename', 'file.move', 'file.duplicate', 'file.pin', 'file.export', 'file.reveal', 'file.copyPath', 'file.trash']
  /** Commands the registry has that the design's command map never listed, so the drawing could not draw them. */
  const ADDED_SINCE_THE_DRAWING = ['outline.newSubheading']

  test('state 18, on a heading: the commands the final drawing reaches (rows, split rows and Turn into targets)', () => {
    // Actions here final spec (2026-10-12): the section rows, Turn into's three targets, Comment and Read aloud.
    const listed = ids('heading', caretIn('The wall builders', 3))
    expect([...listed].sort()).toEqual([INSERT, 'fold.current', 'outline.moveSubtreeUp', 'outline.moveSubtreeDown', 'outline.deleteCurrentSection', 'heading.decrease', 'heading.increase', 'outline.makeParagraph', 'outline.newHeadingBefore', 'outline.newSubheading', 'edit.toggleComment', 'agent.askHere', 'readAloud.start'].sort())
  })

  const labels = (place: Place, state: EditorState | null): string[] => actionsAt(place, state).map((command) => `${actionGroupOf(command)}: ${command.label}`)

  test('state 18, exact order: Insert first, then the larger group', () => {
    expect(labels('heading', caretIn('The wall builders', 3))).toEqual([
      'Insert: Insert object',
      'Shape the document: Fold Current Heading',
      'Shape the document: Move this with everything under it up',
      'Shape the document: Move this with everything under it down',
      'Shape the document: Delete this section',
      'Shape the document: Raise the level of this line',
      'Shape the document: Lower the level of this line',
      'Shape the document: New heading before this section',
      'Shape the document: New subheading under this section',
      'Write: Make this a plain paragraph',
      'Write: Toggle Comment',
      'Listen: Read aloud',
      'Work with the agent: Ask the agent about this…',
    ])
  })

  test('state 19, exact order', () => {
    expect(labels('paragraph', caretIn('Every wall', 3))).toEqual([
      'Insert: Insert object',
      'Write: Bold',
      'Write: Italic',
      'Write: Link',
      'Write: Mark ==text==',
      'Write: Blockquote',
      'Write: Bullet list',
      'Write: Strikethrough',
      'Write: Toggle Comment',
      'Write: Inline code',
      'Write: Clear formatting',
      'Write: Duplicate block',
      'Write: Turn into a code block',
      'Write: Footnote',
      'Write: Numbered list',
      'Write: Turn into a task list',
      'Write: Turn into a table',
      'Write: Delete block…',
      'Shape the document: Move this block up',
      'Shape the document: Move this block down',
      'Shape the document: Make this line a heading at the surrounding level',
      'Shape the document: Make this line a heading one level deeper',
      'Listen: Read aloud',
      'Work with the agent: Ask the agent about this…',
    ])
  })

  test('state 22, exact order', () => {
    expect(labels('file', null)).toEqual([
      'Find and manage files: Open',
      'Find and manage files: Rename',
      'Find and manage files: Move to folder…',
      'Find and manage files: Duplicate',
      'Find and manage files: Pin favourite',
      'Find and manage files: Reveal in Finder',
      'Find and manage files: Copy file path',
      'Find and manage files: Move to Bin…',
      'Share and export: Export…',
    ])
  })

  test('where nothing is drawn: Insert first, larger groups first, and a command that deletes last in its group', () => {
    for (const place of PLACES) {
      const listed = actionsAt(place, null)
      const groups = [...new Set(listed.map(actionGroupOf))]
      if (listed.some((command) => command.id === INSERT)) expect(groups[0], place).toBe('Insert')
      const sizes = groups.filter((group) => group !== 'Insert').map((group) => listed.filter((command) => actionGroupOf(command) === group).length)
      expect(sizes, place).toEqual([...sizes].sort((a, b) => b - a))
      // Each group is one unbroken run.
      expect(listed.map(actionGroupOf).filter((group, index, all) => group !== all[index - 1]), place).toEqual(groups)
    }
    const lastOf = (place: Place, task: string): string => actionsAt(place, null).filter((command) => command.task === task).at(-1)!.id
    const outlineRow = actionsAt('outline-row', null).map((command) => command.id)
    expect(outlineRow).toHaveLength(18)
    expect(outlineRow.slice(-3)).toEqual(['outline.moveBlockUp', 'outline.moveBlockDown', 'outline.deleteCurrentSection'])
    expect(lastOf('outline-row', 'Shape the document')).toBe('outline.deleteCurrentSection')
    expect(lastOf('table', 'Write')).toBe('table.delete')
    expect(lastOf('folder', 'Find and manage files')).toBe('folder.trash')
    expect(lastOf('image', 'Write')).toBe('block.delete')
  })

  test('a level-1 heading cannot be raised, so its list is the heading’s without the raise row', () => {
    const top = ids('heading-top', caretIn('# The long way', 4))
    const heading = ids('heading', caretIn('The wall builders', 3))
    expect(heading.filter((id) => !top.includes(id))).toEqual(['heading.decrease'])
    expect(top.filter((id) => !heading.includes(id))).toEqual([])
  })

  test('state 19, in a paragraph: the commands the final drawing reaches (Format and Turn into children included)', () => {
    const listed = ids('paragraph', caretIn('Every wall', 3))
    expect([...listed].sort()).toEqual([INSERT, 'edit.bold', 'edit.italic', 'edit.strikethrough', 'edit.link', 'edit.mark', 'block.quote', 'list.bullet', 'list.ordered', 'outline.makeHeadingAtSurroundingLevel', 'outline.makeHeadingOneLevelDeeper', 'outline.moveBlockUp', 'outline.moveBlockDown', 'insert.footnote', 'edit.toggleComment', 'readAloud.start', 'edit.inlineCode', 'edit.clearFormatting', 'block.duplicate', 'block.delete', 'turn.taskList', 'turn.codeBlock', 'turn.table', 'agent.askHere'].sort())
    expect(listed).toHaveLength(24)
  })

  test('state 22, on a file row: exactly the drawn 9 rows, with no document needed', () => {
    expect([...ids('file', null)].sort()).toEqual([...DRAWN_FILE].sort())
    expect(ids('file', null)).toHaveLength(9)
    expect(ids('file', caretIn('Every wall'))).toEqual(ids('file', null))
  })

  test('a paragraph and a heading differ, as the drawing says', () => {
    const heading = ids('heading', caretIn('The wall builders', 3))
    const paragraph = ids('paragraph', caretIn('Every wall', 3))
    expect(heading).toContain('fold.current')
    expect(paragraph).not.toContain('fold.current')
    expect(paragraph).toContain('edit.bold')
    expect(heading).not.toContain('edit.bold')
  })

  test('the folder the pane is focused on offers Clear focus where another folder offers Focus', () => {
    expect(ids('folder', null)).toContain('folder.focus')
    expect(ids('folder', null)).not.toContain('folder.clearFocus')
    expect(ids('focused-folder', null)).toContain('folder.clearFocus')
    expect(ids('focused-folder', null)).not.toContain('folder.focus')
    expect(ids('folder', null)).toHaveLength(ids('focused-folder', null).length)
  })

  test('Insert object is offered at every place in the editor and at no row', () => {
    for (const place of PLACES) {
      const row = place === 'file' || place === 'folder' || place === 'focused-folder' || place === 'outline-row'
      expect(commandRegistry.find((command) => command.id === INSERT)!.places.includes(place), place).toBe(!row)
    }
  })
})

describe('actionsAt: order, counting and enablement', () => {
  const row = (id: string, task: 'Write' | 'Shape the document' | 'Find and manage files', subgroup: string, places: PlaceDeclaration, extra: object = {}) =>
    ({ id, task, subgroup, places, ...extra })

  test('the larger group first, equal groups in the order of the ten; inside a group sub-group order, then the order given', () => {
    const commands = [
      row('files.a', 'Find and manage files', 'Tabs', ['paragraph']),
      row('shape.a', 'Shape the document', 'Fold', ['paragraph']),
      row('write.b1', 'Write', 'Format text', ['paragraph']),
      row('write.a1', 'Write', 'Edit lines', ['paragraph']),
      row('write.b2', 'Write', 'Format text', ['paragraph']),
      row('write.a2', 'Write', 'Edit lines', ['paragraph']),
    ]
    expect(actionsAmong(commands, 'paragraph', null).map((command) => command.id)).toEqual(['write.b1', 'write.b2', 'write.a1', 'write.a2', 'shape.a', 'files.a'])
  })

  test('the three kinds of declaration: listed places, everywhere, and not offered by place', () => {
    const commands = [
      row('here', 'Write', 'x', ['heading']),
      row('all', 'Write', 'x', EVERYWHERE),
      row('palette-only', 'Write', 'x', NOT_BY_PLACE),
    ]
    expect(actionsAmong(commands, 'heading', null).map((command) => command.id)).toEqual(['here', 'all'])
    for (const place of PLACES) expect(actionsAmong(commands, place, null).map((command) => command.id), place).toContain('all')
    expect(PLACES.flatMap((place) => actionsAmong(commands, place, null)).some((command) => command.id === 'palette-only')).toBe(false)
  })

  test('a sheet row that mirrors a command is not counted beside it, and a row not built yet is not counted', () => {
    const commands = [
      row('edit.bold', 'Write', 'x', ['paragraph']),
      row('sheet.Editing.1', 'Write', 'x', ['paragraph'], { sheetSource: { kind: 'command', commandId: 'edit.bold' } }),
      row('sheet.Editing.12', 'Write', 'x', ['paragraph'], { sheetSource: { kind: 'literal' } }),
      row('later', 'Write', 'x', ['paragraph'], { future: 'ship2' }),
    ]
    expect(actionsAmong(commands, 'paragraph', null).map((command) => command.id)).toEqual(['sheet.Editing.12', 'edit.bold'])
  })

  test('in the registry no place lists a mirror row or the same command twice', () => {
    for (const place of PLACES) {
      const listed = actionsAt(place, caretIn('Every wall'))
      expect(listed.filter((command) => command.sheetSource?.kind === 'command'), place).toEqual([])
      expect(new Set(listed.map((command) => command.id)).size, place).toBe(listed.length)
    }
  })

  test('a command with a `when` is offered only while it holds, and never without a document', () => {
    const commands = [row('picky', 'Write', 'x', ['paragraph'], { when: (state: EditorState) => state.doc.length > 3 })]
    expect(actionsAmong(commands, 'paragraph', editorState('long enough', 0))).toHaveLength(1)
    expect(actionsAmong(commands, 'paragraph', editorState('no', 0))).toHaveLength(0)
    expect(actionsAmong(commands, 'paragraph', null)).toHaveLength(0)
  })

  // The six commands that carry a `when`: each is enabled at a place it declares, on the construct it is for.
  const WHEN_COMMANDS: Array<[string, Place, () => EditorState]> = [
    ['block.toText', 'table', () => caretIn('cope', 2)],
    ['block.toText', 'image', () => caretIn('The ridge', 2)],
    ['block.toText', 'code-block', () => caretIn('graph TD', 2)],
    ['block.toCode', 'table', () => caretIn('cope', 2)],
    ['block.toCode', 'image', () => caretIn('The ridge', 2)],
    ['block.toCode', 'code-block', () => caretIn('graph TD', 2)],
    ['block.toMermaid', 'code-block', () => editorState('```mermaid code\ngraph TD\n  A --> B\n```\n', 18)],
    ['block.toMarkmap', 'code-block', () => editorState('```\n- Root\n  - Child\n```\n', 8)],
    ['block.toTable', 'code-block', () => editorState('```markdown\n| A | B |\n| --- | --- |\n```\n', 16)],
    ['idea.materialise', 'link', () => withWikilinks(false)],
    ['outline.toMindMap', 'list-item', () => caretIn('first item', 2)],
    ['outline.toMindMap', 'task-item', () => caretIn('buy string', 2)],
    ['outline.toMindMap', 'selection', () => editorState(FIXTURE, FIXTURE.indexOf('- first item'), FIXTURE.indexOf('nested item') + 6)],
  ]

  test('the registry’s `when` commands are exactly the seven the table below covers', () => {
    expect(commandRegistry.filter((command) => command.when).map((command) => command.id).sort()).toEqual([...new Set(WHEN_COMMANDS.map(([id]) => id))].sort())
  })

  for (const [id, place, build] of WHEN_COMMANDS) {
    test(`${id} is enabled at ${place}, where it is listed`, () => {
      const state = build()
      const command = commandRegistry.find((entry) => entry.id === id)!
      expect(placeAt(state)).toBe(place)
      expect(command.places, 'declares the place').toContain(place)
      expect(command.when!(state), 'its `when` holds there').toBe(true)
      expect(ids(place, state)).toContain(id)
    })
  }

  test('every place a `when` command declares is one of the cases above', () => {
    for (const command of commandRegistry.filter((entry) => entry.when)) {
      const tested = WHEN_COMMANDS.filter(([id]) => id === command.id).map(([, place]) => place).sort()
      expect([...(command.places as readonly Place[])].sort(), command.id).toEqual(tested)
    }
  })

  test('Create this note is offered only at a wikilink whose target does not exist', () => {
    const dead = withWikilinks(false)
    const live = withWikilinks(true)
    expect(placeAt(dead)).toBe('link')
    expect(placeAt(live)).toBe('link')
    expect(ids('link', dead)).toContain('idea.materialise')
    expect(ids('link', live)).not.toContain('idea.materialise')
    expect(ids('link', live)).toContain('navigation.followWikilink')
    // An ordinary web link is a link place too, and has no note to create; so is a state without the wikilink field.
    const web = caretIn('the survey', 2)
    expect(placeAt(web)).toBe('link')
    expect(ids('link', web)).not.toContain('idea.materialise')
  })

  test('a `when` command drops out of the list, and the count, where it does not hold', () => {
    const plainCode = caretIn('const stones', 2)
    expect(placeAt(plainCode)).toBe('code-block')
    expect(ids('code-block', plainCode)).not.toContain('block.toMermaid')
    expect(ids('code-block', plainCode)).not.toContain('block.toCode')
    const diagram = caretIn('graph TD', 2)
    expect(ids('code-block', diagram).length).toBeGreaterThan(ids('code-block', plainCode).length - 1)
    expect(ids('code-block', diagram)).toContain('block.toCode')
  })
})
