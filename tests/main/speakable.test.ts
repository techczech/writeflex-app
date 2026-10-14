import { expect, test } from 'bun:test'
import { projectSpeakable, sourceOffsetAt } from '../../src/renderer/src/editor/speakable'

const opts = (changes: any[]) => ({ announce: 'announce' as const, changes })

test('a replacement reads the buffer text and announces the proposal over it', () => {
  const source = 'The survey shows a notable effect.'
  const from = source.indexOf('notable')
  const { text } = projectSpeakable(source, opts([{ id: 'c1', from, to: from + 7, kind: 'replace', words: 2 }]))
  expect(text).toContain('notable')
  expect(text).toContain('agent proposal, two words')
})

test('an insertion has no buffer text, so the announcement is the entire trace', () => {
  const source = 'First sentence. Second sentence.'
  const at = source.indexOf(' Second')
  const { text } = projectSpeakable(source, opts([{ id: 'c2', from: at, to: at, kind: 'insert', words: 4 }]))
  expect(text).toContain('agent proposal, four words')
})

test('a deletion reads the buffer text and announces the proposed deletion over it', () => {
  const source = 'The survey shows a notable effect.'
  const from = source.indexOf('notable')
  const { text } = projectSpeakable(source, opts([{ id: 'c4', from, to: from + 7, kind: 'delete', words: 1 }]))
  expect(text).toContain('notable')
  expect(text).toContain('agent proposal')
})

test('a held pair is announced as held, never silently resolved to one side', () => {
  const source = 'The cat sat.'
  const { text } = projectSpeakable(source, opts([{ id: 'c3', from: 4, to: 7, kind: 'held', words: 1 }]))
  expect(text).toContain('held')
})

test('silent mode emits no change announcements at all', () => {
  const source = 'The survey shows a notable effect.'
  const from = source.indexOf('notable')
  const { text } = projectSpeakable(source, { announce: 'silent', changes: [{ id: 'c1', from, to: from + 7, kind: 'replace', words: 2 }] })
  expect(text).toBe('The survey shows a notable effect.')
})

test('strips heading syntax and announces the heading by level', () => {
  const source = '## The Grammar of Attention\n\nPlain prose here.'
  const { text } = projectSpeakable(source, { announce: 'announce' })
  expect(text).toBe('Heading, level two: The Grammar of Attention. Plain prose here.')
})

test('silent mode speaks the heading text without the announcement', () => {
  const source = '## The Grammar of Attention\n\nPlain prose here.'
  const { text } = projectSpeakable(source, { announce: 'silent' })
  expect(text).toBe('The Grammar of Attention. Plain prose here.')
})

test('maps a spoken offset back to the source offset of the same word', () => {
  const source = '## Title\n\nThe cat sat.'
  const speakable = projectSpeakable(source, { announce: 'silent' })
  const spokenIndex = speakable.text.indexOf('cat')
  expect(sourceOffsetAt(speakable, spokenIndex)).toBe(source.indexOf('cat'))
})

test('skips frontmatter, fenced code and HTML comments entirely', () => {
  const source = '---\ntitle: x\n---\n\nReal prose.\n\n```js\nconst x = 1\n```\n\n<!-- note -->\n\nMore prose.'
  const { text } = projectSpeakable(source, { announce: 'silent' })
  expect(text).not.toContain('title')
  expect(text).not.toContain('const')
  expect(text).not.toContain('note')
  expect(text).toContain('Real prose.')
  expect(text).toContain('More prose.')
})

test('announce mode names a skipped code block with its line count', () => {
  const source = 'Prose.\n\n```js\na\nb\n```'
  const { text } = projectSpeakable(source, { announce: 'announce' })
  expect(text).toContain('Code block, two lines, skipped')
})

test('wikilinks read as their display text and emphasis markers are dropped', () => {
  const source = 'This is *emphatically* true, as [[metaphor-partiality|the partiality note]] argues.'
  const { text } = projectSpeakable(source, { announce: 'silent' })
  expect(text).toBe('This is emphatically true, as the partiality note argues.')
})

test('segments sentences after hidden inline Markdown has been projected out', () => {
  const source = 'Before <!-- Hidden. Still hidden. --> after, with [[target.with.stop|display text]] intact.'
  const { text } = projectSpeakable(source, { announce: 'silent' })
  expect(text).toBe('Before after, with display text intact.')
})

test('keeps comment-separation whitespace outside the source offset map', () => {
  const source = 'foo<!-- hidden -->bar.'
  const speakable = projectSpeakable(source, { announce: 'silent' })
  expect(sourceOffsetAt(speakable, speakable.text.indexOf(' '))).toBeNull()
  expect(sourceOffsetAt(speakable, speakable.text.indexOf('bar'))).toBe(source.indexOf('bar'))
})

test('keeps source piece coordinates monotonic across spoken sentences', () => {
  const speakable = projectSpeakable('First sentence. Second sentence.', { announce: 'silent' })
  let sourceFloor = 0
  for (const piece of speakable.pieces) {
    expect(piece.sourceFrom).toBeGreaterThanOrEqual(sourceFloor)
    sourceFloor = Math.max(sourceFloor, piece.sourceTo)
  }
})

test('does not mistake prose between thematic breaks for frontmatter', () => {
  const source = '---\n\nSome real prose paragraph.\n\n---\n\nMore.'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe(
    'Some real prose paragraph. More.',
  )
})

test('skips declared frontmatter after a leading BOM', () => {
  const source = '\uFEFF---\ntitle: A real title\n---\n\nBody prose.'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe('Body prose.')
})

test('an unterminated block comment ends at its source line', () => {
  const source = 'Before.\n\n<!-- unfinished comment\nAfter.'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe('Before. After.')
})

test('an unterminated inline comment ends at its source line', () => {
  const source = 'Before <!-- unfinished comment\nAfter.'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe('Before After.')
})

test('standard Markdown links read as their link text only', () => {
  const source = 'See [the note](https://example.com/x?y=1) for more.'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe(
    'See the note for more.',
  )
})

test('list and task markers are dropped while item text is spoken', () => {
  const source = '- first item\n1. second item\n- [x] finished item'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe(
    'first item. second item. finished item.',
  )
})

test('an unpunctuated list item is a complete speech segment but unpunctuated prose is unchanged', () => {
  expect(projectSpeakable('- buy milk', { announce: 'silent' }).text).toBe('buy milk.')
  expect(projectSpeakable('buy milk', { announce: 'silent' }).text).toBe('buy milk')
})

test('blockquote markers are dropped while quote text is spoken', () => {
  expect(projectSpeakable('> quoted line here.', { announce: 'silent' }).text).toBe(
    'quoted line here.',
  )
})

test('setext heading underlines are not spoken', () => {
  expect(projectSpeakable('Title\n=====', { announce: 'silent' }).text).toBe('Title.')
})

test('indented code blocks are skipped', () => {
  const source = 'A.\n\n    const x = 1\n    return x\n\nB.'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe('A. B.')
})

test('tables are skipped instead of speaking their delimiters and cells', () => {
  const source = 'A.\n\n| a | b |\n| - | - |\n| x | y |\n\nB.'
  expect(projectSpeakable(source, { announce: 'silent' }).text).toBe('A. B.')
})

test('every mapped spoken character round-trips to the same source character', () => {
  const source = [
    '\uFEFF---\r\n',
    'title: Round trip\r\n',
    '---\r\n',
    '\r\n',
    '# Héllo 😀 世界\r\n',
    '\r\n',
    '- See [the note](https://example.com/x?y=1) and **bold** text.\r\n',
    '- Second item <!-- unfinished comment\r\n',
    'still audible 中文.\r\n',
    '\r\n',
    '| a | b |\r\n',
    '| - | - |\r\n',
    '| x | y |\r\n',
    '\r\n',
    '> Quoted emoji 🚀.\r\n',
  ].join('')
  const speakable = projectSpeakable(source, { announce: 'announce' })

  let spokenCursor = 0
  for (const piece of speakable.pieces) {
    expect(piece.spokenFrom).toBe(spokenCursor)
    if (piece.sourceFrom !== piece.sourceTo) {
      expect(piece.spokenTo - piece.spokenFrom).toBe(piece.sourceTo - piece.sourceFrom)
    } else {
      for (let spokenIndex = piece.spokenFrom; spokenIndex < piece.spokenTo; spokenIndex++) {
        expect(sourceOffsetAt(speakable, spokenIndex)).toBeNull()
      }
    }
    spokenCursor = piece.spokenTo
  }
  expect(spokenCursor).toBe(speakable.text.length)

  for (let spokenIndex = 0; spokenIndex < speakable.text.length; spokenIndex++) {
    const sourceOffset = sourceOffsetAt(speakable, spokenIndex)
    if (sourceOffset !== null) {
      expect(source[sourceOffset]).toBe(speakable.text[spokenIndex])
    }
  }
})
