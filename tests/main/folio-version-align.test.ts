/**
 * Ticket 17 of Folio versions (ADR-0052 § Decision 1; journey J3): the three-way paragraph alignment. Pure, so every test here is lists of
 * strings in and rows out. Named cases of the ticket: only-mine, only-hers, both-different, both-same, her deletion, her insertion; then the
 * edges (touching changes stay two rows, overlapping ones are one, two insertions at one place, empty lists, too long to compare) and the
 * UnityBC-shaped part (the four row kinds of the locked mockup in one part).
 */
import { describe, expect, test } from 'bun:test'
import { ALIGN_MAX_CELLS, alignThreeWay, needsDecision, squashParagraph, whoChanged, type AlignRow } from '../../src/shared/folio-version-align'

const kinds = (rows: AlignRow[] | null): string[] => (rows ?? []).map((row) => row.kind)
const rowsOf = (sent: string[], hers: string[], yours: string[]): AlignRow[] => {
  const rows = alignThreeWay(sent, hers, yours)
  if (rows === null) throw new Error('too long')
  return rows
}
/** The invariant every alignment keeps: the rows cover each list completely, in order, with no gap and no overlap. */
function expectCovers(sent: string[], hers: string[], yours: string[], rows: AlignRow[]): void {
  for (const [list, pick] of [[sent, (row: AlignRow) => row.sent], [hers, (row: AlignRow) => row.hers], [yours, (row: AlignRow) => row.yours]] as const) {
    let at = 0
    for (const row of rows) { expect(pick(row).from).toBe(at); at = pick(row).to }
    expect(at).toBe(list.length)
  }
}

describe('alignThreeWay: the named cases', () => {
  test('nobody changed anything: one stretch, unchanged', () => {
    const rows = rowsOf(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c'])
    expect(kinds(rows)).toEqual(['same'])
    expect(rows[0]!.sent).toEqual({ from: 0, to: 3 })
    expect(whoChanged(rows)).toEqual({ hers: false, yours: false })
  })

  test('only mine: the writer changed paragraph 2, her text is the sent text', () => {
    const rows = rowsOf(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'B edited', 'c'])
    expect(kinds(rows)).toEqual(['same', 'only-mine', 'same'])
    expect(rows[1]).toMatchObject({ herChange: 'none', yourChange: 'replace', sent: { from: 1, to: 2 }, hers: { from: 1, to: 2 }, yours: { from: 1, to: 2 } })
    expect(needsDecision(rows[1]!)).toBe(false)
  })

  test('only hers: she changed paragraph 2, the writer left it as sent', () => {
    const rows = rowsOf(['a', 'b', 'c'], ['a', 'B hers', 'c'], ['a', 'b', 'c'])
    expect(kinds(rows)).toEqual(['same', 'only-hers', 'same'])
    expect(rows[1]).toMatchObject({ herChange: 'replace', yourChange: 'none' })
    expect(needsDecision(rows[1]!)).toBe(true)
  })

  test('both different: each changed paragraph 2 to other words', () => {
    const rows = rowsOf(['a', 'b', 'c'], ['a', 'B hers', 'c'], ['a', 'B mine', 'c'])
    expect(kinds(rows)).toEqual(['same', 'both-different', 'same'])
    expect(rows[1]).toMatchObject({ herChange: 'replace', yourChange: 'replace' })
    expect(needsDecision(rows[1]!)).toBe(true)
    expect(whoChanged(rows)).toEqual({ hers: true, yours: true })
  })

  test('both same: each changed paragraph 2 to the same words (white space aside)', () => {
    const rows = rowsOf(['a', 'b', 'c'], ['a', 'B  both', 'c'], ['a', 'B both', 'c'])
    expect(kinds(rows)).toEqual(['same', 'both-same', 'same'])
    expect(needsDecision(rows[1]!)).toBe(false)
  })

  test('her deletion: she took paragraph 2 out, the writer left it', () => {
    const rows = rowsOf(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c'])
    expect(kinds(rows)).toEqual(['same', 'only-hers', 'same'])
    expect(rows[1]).toMatchObject({ herChange: 'delete', hers: { from: 1, to: 1 }, yours: { from: 1, to: 2 }, sent: { from: 1, to: 2 } })
  })

  test('her insertion: she added a paragraph after 1, the writer did not', () => {
    const rows = rowsOf(['a', 'b'], ['a', 'NEW', 'b'], ['a', 'b'])
    expect(kinds(rows)).toEqual(['same', 'only-hers', 'same'])
    expect(rows[1]).toMatchObject({ herChange: 'insert', sent: { from: 1, to: 1 }, hers: { from: 1, to: 2 }, yours: { from: 1, to: 1 } })
  })

  test('my insertion and my deletion decide themselves', () => {
    expect(kinds(rowsOf(['a', 'b'], ['a', 'b'], ['a', 'NEW', 'b']))).toEqual(['same', 'only-mine', 'same'])
    const gone = rowsOf(['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'c'])
    expect(kinds(gone)).toEqual(['same', 'only-mine', 'same'])
    expect(gone[1]!.yourChange).toBe('delete')
  })
})

describe('alignThreeWay: where two changes meet', () => {
  test('she deleted a paragraph, the writer edited it: both different, her side empty', () => {
    const rows = rowsOf(['a', 'b', 'c'], ['a', 'c'], ['a', 'b edited', 'c'])
    expect(kinds(rows)).toEqual(['same', 'both-different', 'same'])
    expect(rows[1]).toMatchObject({ herChange: 'delete', yourChange: 'replace' })
  })

  test('both deleted the same paragraph: both same', () => {
    expect(kinds(rowsOf(['a', 'b', 'c'], ['a', 'c'], ['a', 'c']))).toEqual(['same', 'both-same', 'same'])
  })

  test('changes in neighbouring paragraphs stay two rows, so two decisions, not one', () => {
    const rows = rowsOf(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd'], ['a', 'b', 'C', 'd'])
    expect(kinds(rows)).toEqual(['same', 'only-hers', 'only-mine', 'same'])
    expectCovers(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd'], ['a', 'b', 'C', 'd'], rows)
  })

  test('her change inside a stretch the writer rewrote makes one row of the whole stretch', () => {
    const sent = ['a', 'b', 'c', 'd', 'e']
    const hers = ['a', 'b', 'C', 'd', 'e']
    const yours = ['a', 'X', 'Y', 'Z', 'e']
    const rows = rowsOf(sent, hers, yours)
    expect(kinds(rows)).toEqual(['same', 'both-different', 'same'])
    expect(rows[1]).toMatchObject({ sent: { from: 1, to: 4 }, hers: { from: 1, to: 4 }, yours: { from: 1, to: 4 } })
    expectCovers(sent, hers, yours, rows)
  })

  test('two insertions at one place: different words is one conflict, the same words is agreement', () => {
    expect(kinds(rowsOf(['a', 'b'], ['a', 'H', 'b'], ['a', 'Y', 'b']))).toEqual(['same', 'both-different', 'same'])
    expect(kinds(rowsOf(['a', 'b'], ['a', 'N', 'b'], ['a', 'N', 'b']))).toEqual(['same', 'both-same', 'same'])
  })

  test('an insertion at the start and at the end', () => {
    const rows = rowsOf(['a'], ['H', 'a', 'T'], ['a'])
    expect(kinds(rows)).toEqual(['only-hers', 'same', 'only-hers'])
    expect(rows[0]).toMatchObject({ hers: { from: 0, to: 1 }, sent: { from: 0, to: 0 } })
    expect(rows[2]).toMatchObject({ hers: { from: 2, to: 3 }, sent: { from: 1, to: 1 } })
  })

  test('her insertion beside my change of the paragraph after it stays two rows', () => {
    const rows = rowsOf(['a', 'b'], ['a', 'NEW', 'b'], ['a', 'B'])
    expect(kinds(rows)).toEqual(['same', 'only-hers', 'only-mine'])
  })
})

describe('alignThreeWay: edges', () => {
  test('empty lists align to nothing, and an empty part she filled is all hers', () => {
    expect(alignThreeWay([], [], [])).toEqual([])
    const rows = rowsOf([], ['x', 'y'], [])
    expect(kinds(rows)).toEqual(['only-hers'])
    expect(rows[0]!.herChange).toBe('insert')
  })

  test('the ranges index the lists as given, and cover them', () => {
    const sent = ['one', 'two', 'three', 'four', 'five', 'six']
    const hers = ['one', 'TWO', 'three', 'four', 'six', 'seven']
    const yours = ['intro', 'one', 'two', 'THREE', 'four', 'five']
    const rows = rowsOf(sent, hers, yours)
    expectCovers(sent, hers, yours, rows)
    expect(whoChanged(rows)).toEqual({ hers: true, yours: true })
  })

  test('paragraphs are the same when their words are, however white space falls or the text is normalised', () => {
    expect(squashParagraph(' a \n b\t c ')).toBe('a b c')
    expect(kinds(rowsOf(['Hello  world'], ['Hello world'], ['Hello\nworld']))).toEqual(['same'])
  })

  test('a correction that only changes how a character is written is her change: x2 to x², a ligature, full-width letters, a vulgar fraction', () => {
    for (const [plain, fancy] of [['x2', 'x²'], ['fine', 'ﬁne'], ['ABC 12', 'ＡＢＣ 12'], ['1/2 a cup', '½ a cup'], ['H2O', 'H₂O']] as const) {
      expect(squashParagraph(plain)).not.toBe(squashParagraph(fancy))
      const rows = rowsOf([plain], [fancy], [plain])
      expect(kinds(rows)).toEqual(['only-hers'])
      expect(rows[0]!.herChange).toBe('replace')
      // And a writer who made the same correction the same way agrees with her.
      expect(kinds(rowsOf([plain], [fancy], [fancy]))).toEqual(['both-same'])
      expect(kinds(rowsOf([plain], [fancy], ['changed by the writer']))).toEqual(['both-different'])
    }
  })

  test('the same character written composed or decomposed is the same word', () => {
    expect(squashParagraph('caf\u00e9')).toBe(squashParagraph('cafe\u0301'))
    expect(kinds(rowsOf(['caf\u00e9'], ['cafe\u0301'], ['caf\u00e9']))).toEqual(['same'])
  })

  test('too long to compare: null, never a guess', () => {
    const long = Array.from({ length: Math.ceil(Math.sqrt(ALIGN_MAX_CELLS)) + 1 }, (_, i) => `p${i}`)
    expect(alignThreeWay(long, long, long)).toBeNull()
  })

  test('1,200 words and 60 changes align in a blink', () => {
    const sent = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} ${'word '.repeat(9)}`.trim())
    const hers = sent.map((text, i) => (i % 4 === 0 ? `${text} hers` : text))
    const yours = sent.map((text, i) => (i % 4 === 2 ? `${text} mine` : i % 8 === 0 ? `${text} mine too` : text))
    const started = performance.now()
    const rows = rowsOf(sent, hers, yours)
    expect(performance.now() - started).toBeLessThan(500)
    expectCovers(sent, hers, yours, rows)
    expect(rows.filter((row) => row.kind !== 'same').length).toBeGreaterThanOrEqual(60)
  })
})

describe('alignThreeWay: the UnityBC-shaped part', () => {
  // The synthetic part 4 of the mockup, with the unchanged paragraphs the real part has between the changes: the writer added a clause to
  // paragraph 1; both edited the last sentence of 3; she deleted 5; she added a new paragraph after 6.
  const P = (n: number): string => `Unchanged paragraph ${n} of the part, with enough words in it to read as a sentence of the paper.`
  const sent = [
    'Most disagreements between the judges were small: scores were within one point of each other in 71% of passages.',
    P(2),
    'The remaining 29% were opposing judgements: one judge preferred translation A and the other preferred translation B. We read all of these passages ourselves.',
    P(4),
    'Opposing judgements clustered in passages with idioms and with numbers written out in words.',
    P(6),
    P(7),
  ]
  const hers = [
    sent[0]!,
    sent[1]!,
    'The remaining 29% were opposing judgements: one judge preferred translation A and the other preferred translation B. We read a sample of these passages ourselves.',
    sent[3]!,
    sent[5]!,
    'We added a note on how the opposing passages were chosen.',
    sent[6]!,
  ]
  const yours = [
    'Most disagreements between the judges were small: scores were within one point of each other in 71% of passages, the range we treat as agreement.',
    sent[1]!,
    'The remaining 29% were opposing judgements: one judge preferred translation A and the other preferred translation B. We read all 38 of these passages ourselves, twice.',
    sent[3]!,
    sent[4]!,
    sent[5]!,
    sent[6]!,
  ]
  const rows = rowsOf(sent, hers, yours)
  const changed = rows.filter((row) => row.kind !== 'same')

  test('gives the four kinds of the mockup: only mine, both changed, her deletion, her insertion', () => {
    expect(kinds(changed)).toEqual(['only-mine', 'both-different', 'only-hers', 'only-hers'])
    expect(changed.map((row) => `${row.herChange}/${row.yourChange}`)).toEqual(['none/replace', 'replace/replace', 'delete/none', 'insert/none'])
    expectCovers(sent, hers, yours, rows)
  })

  test('her deletion is her paragraph taken out of the sent text, which the writer still has as sent', () => {
    const row = changed[2]!
    expect(sent.slice(row.sent.from, row.sent.to)).toEqual([sent[4]])
    expect(yours.slice(row.yours.from, row.yours.to)).toEqual([sent[4]])
    expect(hers.slice(row.hers.from, row.hers.to)).toEqual([])
  })

  test('her insertion is a paragraph of hers that the sent text and the writer’s text lack', () => {
    const row = changed[3]!
    expect(sent.slice(row.sent.from, row.sent.to)).toEqual([])
    expect(yours.slice(row.yours.from, row.yours.to)).toEqual([])
    expect(hers.slice(row.hers.from, row.hers.to)).toEqual([hers[5]])
  })

  test('the row both changed holds the three texts side by side', () => {
    const row = changed[1]!
    expect(sent.slice(row.sent.from, row.sent.to)).toEqual([sent[2]])
    expect(hers.slice(row.hers.from, row.hers.to)).toEqual([hers[2]])
    expect(yours.slice(row.yours.from, row.yours.to)).toEqual([yours[2]])
  })
})
