// 0.24 ticket 07: where a reader's note belongs in the piece as it stands now. One case per state of
// spec section 6.1 ("Note arrives, passage unchanged / edited since / gone"), and the ticket 06 review's
// rule: among several places, the best context match wins and a tie is flagged.
import { describe, expect, test } from 'bun:test'
import { anchorReaderNote, projectMarkdown, uniqueSpan } from '../../src/main/reader-note-anchor'

const DOC = '# What a reading list is for\n\nMost reading lists are written as if the reader will finish them. They are long, they are ordered by when the author found each item.\n\nA list owes its reader a reason for each entry. One line is enough.\n'

const at = (doc: string, r: { from: number; to: number }) => doc.slice(r.from, r.to)

describe('anchoring by quoted words', () => {
  test('passage unchanged: anchored on the words as written', () => {
    const anchor = anchorReaderNote(DOC, { quote: 'they are ordered', before: 'They are long,', after: 'by when' })
    expect(anchor.state).toBe('unchanged')
    if (anchor.state !== 'unchanged') return
    expect(at(DOC, anchor)).toBe('they are ordered')
    expect(anchor.ambiguous).toBe(false)
  })

  test('passage unchanged through Markdown markers the reader never saw', () => {
    const doc = 'A list owes its reader *a reason* for each [entry](https://example.org/x). One line.\n'
    const anchor = anchorReaderNote(doc, { quote: 'a reason for each entry', before: 'A list owes its reader', after: '. One line.' })
    expect(anchor.state).toBe('unchanged')
    if (anchor.state === 'unchanged') expect(at(doc, anchor)).toBe('a reason* for each [entry')
    expect(projectMarkdown('## Title\n\n- item *one*').text).toBe('Title item one')
  })

  test('the quote stands twice: the place whose context agrees wins, not the first', () => {
    const doc = 'The list is long. Readers stop early.\n\nThe second list is long. Readers finish it.\n'
    const anchor = anchorReaderNote(doc, { quote: 'is long', before: 'The second list', after: '. Readers finish' })
    expect(anchor.state).toBe('unchanged')
    if (anchor.state !== 'unchanged') return
    expect(anchor.from).toBe(doc.lastIndexOf('is long'))
    expect(anchor.ambiguous).toBe(false)
  })

  test('the quote stands twice with the same context: flagged ambiguous', () => {
    const doc = 'It is long. It is long.\n'
    const anchor = anchorReaderNote(doc, { quote: 'is long', before: 'It', after: '.' })
    expect(anchor).toMatchObject({ state: 'unchanged', ambiguous: true })
  })

  test('passage edited since: the nearest match between the context the reader saw', () => {
    const doc = DOC.replace('a reason for each entry', 'a reason for every entry')
    const anchor = anchorReaderNote(doc, { quote: 'a reason for each entry', before: 'A list owes its reader', after: '. One line is enough.' })
    expect(anchor.state).toBe('changed')
    if (anchor.state === 'changed') expect(at(doc, anchor)).toBe('a reason for every entry')
  })

  test('passage edited and its context too: the stretch with most of the quoted words', () => {
    const doc = 'Something new opens the piece.\n\nThe students asked the questions that matter most.\n'
    const anchor = anchorReaderNote(doc, { quote: "the students' questions", before: 'and', after: 'are the best' })
    expect(anchor.state).toBe('changed')
  })

  test('passage gone: no place', () => {
    const anchor = anchorReaderNote(DOC, { quote: 'a monograph ever on a first-week list', before: 'Is', after: '?' })
    expect(anchor).toEqual({ state: 'gone' })
  })

  test('a span that stands once is grown from words that stand twice', () => {
    const doc = 'the cat sat. the dog sat.\n'
    const from = doc.lastIndexOf('sat')
    const span = uniqueSpan(doc, from, from + 3)
    expect(span).not.toBeNull()
    const text = doc.slice(span!.from, span!.to)
    expect(text).toContain('sat')
    expect(doc.indexOf(text)).toBe(doc.lastIndexOf(text))
  })
})
