import { expect, test } from 'bun:test'
import { collectionMaterial, collectionOffcuts, collectionSourceUse, firstWords, ideaNameFrom, isResearchNotePath, listedSourceEntry, scrapCutOn, type MaterialFact } from '../../src/main/piece-material'

const fact = (path: string, input: Partial<MaterialFact> = {}): MaterialFact => ({
  path,
  title: input.title ?? path.split('/').pop()!.replace(/\.md$/, ''),
  linkTitle: input.linkTitle ?? input.title ?? path.split('/').pop()!.replace(/\.md$/, ''),
  aliases: [],
  frontmatterSources: [],
  wikilinks: [],
  ...input,
})

test('scraps belong to the piece their scraps file names as origin, per folder', () => {
  const material = collectionMaterial('c', [
    fact('c/a.md'),
    fact('c/sub/a.md'),
    fact('c/scraps/a-SCRAPS.md', { scraps: [{ id: 's_1', text: 'one' }, { id: 's_2', text: 'two' }] }),
    fact('c/sub/scraps/a-SCRAPS.md', { scraps: [{ id: 's_3', text: 'three' }] }),
  ])

  expect(material.get('c/a.md')?.scrapCount).toBe(2)
  expect(material.get('c/sub/a.md')?.scrapCount).toBe(1)
  expect(material.get('c/sub/a.md')?.drawer?.scraps.map((scrap) => scrap.id)).toEqual(['s_3'])
})

test('sources merge the frontmatter list with wikilinked research notes, once each, in that order', () => {
  const material = collectionMaterial('c', [
    fact('c/piece.md', {
      frontmatterSources: ['research/b.md', '[[A notes]]', 'Beyond Culture', 'research/scan.pdf'],
      wikilinks: ['a-notes', 'c', 'other', 'Beyond Culture'],
    }),
    fact('c/other.md', { title: 'Other piece' }),
    fact('c/research/a-notes.md', { title: 'A notes' }),
    fact('c/research/b.md', { title: 'B, Remembering' }),
    fact('c/research/deep/c.md', { title: 'C deep' }),
  ])

  const piece = material.get('c/piece.md')
  // Listed: B, A (by title), "Beyond Culture" (no file), scan.pdf (no Markdown file). Cited: A (dup),
  // C (research), "other" (not research), "Beyond Culture" (no file, not research).
  expect(piece?.sourceCount).toBe(5)
  expect(piece?.drawer?.sources).toEqual([
    { title: 'B, Remembering', path: 'c/research/b.md' },
    { title: 'A notes', path: 'c/research/a-notes.md' },
  ])
  expect(piece?.drawer?.moreSources).toBe(3)
})

test('a piece with neither scraps nor sources has zero counts and no drawer', () => {
  const material = collectionMaterial('', [fact('lone.md', { wikilinks: ['nowhere'] })])
  expect(material.get('lone.md')).toEqual({ scrapCount: 0, sourceCount: 0, drawer: null })
})

test('the drawer lists two of each kind and counts the rest', () => {
  const scraps = Array.from({ length: 5 }, (_, index) => ({ id: `s_${index}`, text: `scrap ${index}` }))
  const drawer = collectionMaterial('', [fact('a.md'), fact('scraps/a-SCRAPS.md', { scraps })]).get('a.md')?.drawer
  expect(drawer?.scraps.map((scrap) => scrap.text)).toEqual(['scrap 0', 'scrap 1'])
  expect(drawer?.moreScraps).toBe(3)
  expect(drawer?.sources).toEqual([])
  expect(drawer?.moreSources).toBe(0)
})

test('research notes are files inside a research folder of the Collection', () => {
  expect(isResearchNotePath('c/research/a.md', 'c')).toBe(true)
  expect(isResearchNotePath('c/part/research/a.md', 'c')).toBe(true)
  expect(isResearchNotePath('c/research.md', 'c')).toBe(false)
  expect(isResearchNotePath('research/a.md', '')).toBe(true)
})

test('a scrap shows its first words, cut at a word', () => {
  expect(firstWords('A list is a promise about order.')).toBe('A list is a promise about order.')
  expect(firstWords("Hall's high and low context cultures: every culture has high and low areas")).toBe("Hall's high and low context cultures…")
  expect(firstWords('> quoted\n\nline   two')).toBe('quoted line two')
})

test('an offcut is dated by its store id, else by its scraps file, and suggests a name from its first words', () => {
  const stamp = Date.UTC(2026, 7, 3, 12)
  const id = `s_${stamp.toString(36)}0abc`
  expect(scrapCutOn(id, Date.UTC(2026, 8, 1))).toBe('2026-08-03')
  expect(scrapCutOn('s_one', Date.UTC(2026, 8, 1))).toBe('2026-09-01')
  expect(scrapCutOn('s_one')).toBeNull()
  expect(ideaNameFrom("hall's high and low context cultures: every culture has both.")).toBe("Hall's high and low context cultures")
  expect(ideaNameFrom('- A list is a promise.')).toBe('A list is a promise')

  const offcuts = collectionOffcuts([
    fact('c/a.md', { title: 'Alpha' }),
    fact('c/scraps/a-SCRAPS.md', { scraps: [{ id, text: 'one', done: true }], mtime: Date.UTC(2026, 8, 1) }),
    fact('c/scraps/gone-SCRAPS.md', { scraps: [{ id: 's_x', text: 'two' }] }),
  ])
  expect(offcuts.get('c/scraps/a-SCRAPS.md')).toEqual([{
    id, text: 'one', firstWords: 'one', suggestedName: 'One', done: true,
    scrapsPath: 'c/scraps/a-SCRAPS.md', origin: 'c/a.md', originTitle: 'Alpha', cutOn: '2026-08-03',
  }])
  // A scraps file whose origin is not in the Collection names it by file.
  expect(offcuts.get('c/scraps/gone-SCRAPS.md')?.[0]).toMatchObject({ originTitle: 'gone', cutOn: null })
})

test('the Sources rail names, for every research note, the pieces that list it or link to it', () => {
  const facts = [
    fact('c/tools.md', { title: 'Tools of reason', frontmatterSources: ['research/bartlett.md', 'research/kahneman.md'] }),
    fact('c/hall.md', { title: 'How humans hallucinate', frontmatterSources: ['[[Hall 1976 notes]]'], wikilinks: ['bartlett'] }),
    fact('c/research/hall.md', { title: 'Hall 1976 notes' }),
    fact('c/research/bartlett.md', { title: 'Bartlett, Remembering' }),
    fact('c/research/kahneman.md', { title: 'Kahneman' }),
    fact('c/research/minsky.md', { title: 'Minsky, Frames', wikilinks: ['bartlett'] }),
    fact('c/agent-notes/review.md', { wikilinks: ['minsky'] }),
    fact('c/scraps/tools-SCRAPS.md', { wikilinks: ['minsky'], scraps: [] }),
  ]
  const use = collectionSourceUse('c', facts)
  expect([...use.keys()].sort()).toEqual(['c/research/bartlett.md', 'c/research/hall.md', 'c/research/kahneman.md', 'c/research/minsky.md'])
  expect(use.get('c/research/bartlett.md')).toEqual([
    { path: 'c/hall.md', title: 'How humans hallucinate' },
    { path: 'c/tools.md', title: 'Tools of reason' },
  ])
  expect(use.get('c/research/hall.md')).toEqual([{ path: 'c/hall.md', title: 'How humans hallucinate' }])
  // Only pieces use a source: a research note, an agent note and a scraps file linking to it do not.
  expect(use.get('c/research/minsky.md')).toEqual([])
})

test('a source counts as listed in any form the list names it, and a text link does not list it', () => {
  const facts = [
    fact('c/essays/tools.md'),
    fact('c/research/bartlett.md', { title: 'Bartlett, Remembering' }),
  ]
  for (const entry of ['../research/bartlett.md', 'research/bartlett.md', '[[Bartlett, Remembering]]', 'Bartlett, Remembering', 'c/research/bartlett.md']) {
    expect(listedSourceEntry('c', facts, 'c/essays/tools.md', ['other.md', entry], 'c/research/bartlett.md')).toBe(entry)
  }
  expect(listedSourceEntry('c', facts, 'c/essays/tools.md', ['other.md'], 'c/research/bartlett.md')).toBeNull()
})
