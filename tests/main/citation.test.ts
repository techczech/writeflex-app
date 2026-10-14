import { describe, expect, test } from 'bun:test'
import {
  chipLabel,
  citationChip,
  citationForReaderText,
  quotedCitation,
  unwrapReaderQuotes,
} from '../../src/renderer/src/editor/citation'

const source = {
  authorYear: 'Lea and Street 1998',
  link: 'zotero://open-pdf/library/items/ABCD1234?annotation=ANN1',
  pageLabel: '157',
}

describe('the chip a reader sees', () => {
  test('names the work and the page', () => {
    expect(chipLabel(source)).toBe('⟨Lea and Street 1998, p. 157⟩')
  })

  test('drops the page when the citation is to the whole work', () => {
    expect(chipLabel({ ...source, pageLabel: null })).toBe('⟨Lea and Street 1998⟩')
    expect(chipLabel({ ...source, pageLabel: '  ' })).toBe('⟨Lea and Street 1998⟩')
  })

  test('never renders an empty chip', () => {
    expect(chipLabel({ ...source, authorYear: '', pageLabel: null })).toBe('⟨Reference⟩')
  })
})

describe('what lands in the Markdown', () => {
  test('an ordinary link another editor can follow', () => {
    expect(citationChip(source)).toBe(
      '[⟨Lea and Street 1998, p. 157⟩](zotero://open-pdf/library/items/ABCD1234?annotation=ANN1)',
    )
  })

  test('a group-library target is just as ordinary', () => {
    expect(citationChip({ ...source, link: 'zotero://select/groups/2857617/items/XY' }))
      .toContain('(zotero://select/groups/2857617/items/XY)')
  })

  test('brackets in a name cannot break the link', () => {
    const chip = citationChip({ ...source, authorYear: 'Smith [ed.] 2001' })
    expect(chip).toContain('\\[ed.\\]')
    expect(chip.endsWith(')')).toBe(true)
  })

  test('a URL containing a bracket is wrapped so the link still parses', () => {
    expect(citationChip({ ...source, link: 'zotero://select/library/items/A(B' }))
      .toContain('(<zotero://select/library/items/A(B>)')
  })
})

describe('a pulled quote', () => {
  test('is a blockquote with the chip beneath, by default', () => {
    expect(quotedCitation('the implicit models that have been used', source)).toBe(
      '> “the implicit models that have been used”\n>\n> [⟨Lea and Street 1998, p. 157⟩](zotero://open-pdf/library/items/ABCD1234?annotation=ANN1)',
    )
  })

  test('can sit inline in a sentence instead', () => {
    expect(quotedCitation('a phrase', source, 'inline')).toBe(
      '“a phrase” [⟨Lea and Street 1998, p. 157⟩](zotero://open-pdf/library/items/ABCD1234?annotation=ANN1)',
    )
  })

  test('collapses the line breaks a PDF selection carries', () => {
    expect(quotedCitation('a broken\n  line   of words', source, 'inline'))
      .toContain('“a broken line of words”')
  })

  test('with no words is just the chip — the reference-only case', () => {
    expect(quotedCitation('   ', source)).toBe(citationChip(source))
  })
})

describe('words arriving from the reader', () => {
  const quote = {
    authorYear: 'Lea and Street 1998',
    pageLabel: '157',
    text: 'the implicit models that have been used',
  }
  const link = 'zotero://open-pdf/library/items/ABCD1234?page=157'

  test('a copied passage arrives bare and becomes a quote with its chip', () => {
    const citation = citationForReaderText(quote.text, quote, link)
    expect(citation).toBe(
      '> “the implicit models that have been used”\n>\n> [⟨Lea and Street 1998, p. 157⟩](zotero://open-pdf/library/items/ABCD1234?page=157)',
    )
  })

  test('a dragged passage arrives inside the reader’s quotes and still matches', () => {
    expect(citationForReaderText(`“${quote.text}”`, quote, link)).toBe(
      citationForReaderText(quote.text, quote, link),
    )
  })

  test('a dragged passage is not quoted twice', () => {
    expect(citationForReaderText(`“${quote.text}”`, quote, link))
      .toContain('> “the implicit models that have been used”')
  })

  test('the whitespace a PDF selection breaks across lines does not stop the match', () => {
    expect(citationForReaderText('“the implicit models\n  that have  been used”', quote, link))
      .not.toBeNull()
  })

  test('ordinary pasted prose is not mistaken for a citation', () => {
    expect(citationForReaderText('something he typed himself', quote, link)).toBeNull()
  })

  test('a passage that only shares its opening words does not match', () => {
    expect(citationForReaderText('“the implicit models”', quote, link)).toBeNull()
  })

  test('nothing came out of the reader, so nothing is attributed', () => {
    expect(citationForReaderText('“the implicit models that have been used”', null, link)).toBeNull()
  })

  test('a link that has not resolved yet leaves the words unattributed', () => {
    expect(citationForReaderText(quote.text, quote, '')).toBeNull()
  })
})

describe('the reader’s quote wrapping', () => {
  test('a matched outer pair is removed', () => {
    expect(unwrapReaderQuotes('“a passage”')).toBe('a passage')
  })

  test('quotes inside the passage survive', () => {
    expect(unwrapReaderQuotes('“he called it “models” himself”')).toBe('he called it “models” himself')
  })

  test('an unwrapped passage is returned as it came', () => {
    expect(unwrapReaderQuotes('a passage')).toBe('a passage')
  })

  test('a half pair is not a wrapping', () => {
    expect(unwrapReaderQuotes('“a passage')).toBe('“a passage')
    expect(unwrapReaderQuotes('a passage”')).toBe('a passage”')
  })

  test('a passage that is only quotes is left alone rather than emptied', () => {
    expect(unwrapReaderQuotes('“”')).toBe('“”')
  })
})
