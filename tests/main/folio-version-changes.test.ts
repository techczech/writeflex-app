/**
 * Ticket 06 of Folio versions (ADR-0052): the pure function "which parts and inserted files changed since version V" and the
 * sentences the cues use. Synthetic members only.
 */
import { expect, test } from 'bun:test'
import {
  cellsDiffering, changedSinceVersion, changesSentence, countChanges, cueChipText, cueTotal, cuesFrom, dotLabel, embedOnLine, insertedStateSentence, partHistory, partSentence, usesSentence,
  type SavedMember, type WorkingMember,
} from '../../src/shared/folio-version-changes'

const saved = (role: SavedMember['role'], path: string, hash: string | null = path): SavedMember => ({ role, path, hash })
const work = (role: WorkingMember['role'], path: string, hash: string | null = path, insertedBy?: string[]): WorkingMember => ({ role, path, hash, ...(insertedBy ? { insertedBy } : {}) })

const SAVED: SavedMember[] = [saved('index', 'f/index.md'), saved('part', 'f/a.md'), saved('part', 'f/b.md'), saved('part', 'f/c.md'), saved('unlisted', 'f/loose.md'), saved('inserted', 'f/data/t.csv')]

test('nothing differs: no parts, no inserted files, no dots', () => {
  const change = changedSinceVersion(SAVED, SAVED.map((m) => work(m.role, m.path, m.hash, m.role === 'inserted' ? ['f/b.md'] : undefined)))
  expect(change).toEqual({ changedParts: [], changedUnlisted: [], indexChanged: false, changedInserted: [], dotted: [], otherFiles: 0 })
})

test('one part edited and one inserted table edited: exactly those two parts carry a dot, and the table names the part that inserts it', () => {
  const change = changedSinceVersion(SAVED, [
    work('index', 'f/index.md'), work('part', 'f/a.md', 'a-changed'), work('part', 'f/b.md'), work('part', 'f/c.md'), work('unlisted', 'f/loose.md'),
    work('inserted', 'f/data/t.csv', 'csv-changed', ['f/c.md']),
  ])
  expect(change.changedParts).toEqual(['f/a.md'])
  expect(change.changedInserted).toEqual([{ path: 'f/data/t.csv', by: ['f/c.md'] }])
  expect(change.dotted).toEqual(['f/a.md', 'f/c.md'])
  expect(change.otherFiles).toBe(0)
})

test('a table inserted by the part that was edited too gives that part one dot, not two', () => {
  const change = changedSinceVersion(SAVED, [work('part', 'f/a.md', 'x'), work('inserted', 'f/data/t.csv', 'y', ['f/a.md'])])
  expect(change.dotted).toEqual(['f/a.md'])
})

test('a part the version did not hold is a change; one that is gone is not reported', () => {
  const change = changedSinceVersion(SAVED, [work('part', 'f/a.md'), work('part', 'f/new.md', 'n')])
  expect(change.changedParts).toEqual(['f/new.md'])
  expect(change.dotted).toEqual(['f/new.md'])
})

test('the Index Note and a file not in the outline are changes without a dot, and are counted as files', () => {
  const change = changedSinceVersion(SAVED, [work('index', 'f/index.md', 'i2'), work('part', 'f/a.md'), work('unlisted', 'f/loose.md', 'l2')])
  expect(change.dotted).toEqual([])
  expect(change).toMatchObject({ indexChanged: true, changedUnlisted: ['f/loose.md'], otherFiles: 2 })
})

test('a saved copy that cannot be read, or a file too large to compare, is never reported as changed', () => {
  expect(changedSinceVersion([saved('part', 'f/a.md', null)], [work('part', 'f/a.md', 'x')]).dotted).toEqual([])
  expect(changedSinceVersion([saved('part', 'f/a.md', 'x')], [work('part', 'f/a.md', null)]).dotted).toEqual([])
})

test('an inserted file only a file not in the outline inserts is counted as a file, not given a dot', () => {
  const change = changedSinceVersion(SAVED, [work('part', 'f/a.md'), work('unlisted', 'f/loose.md'), work('inserted', 'f/data/t.csv', 'y', ['f/loose.md'])])
  expect(change.dotted).toEqual([])
  expect(change.otherFiles).toBe(1)
})

test('the chip: counts parts, then files, and says so plainly when nothing changed', () => {
  const since = { id: 'fv_1', name: 'After pilot numbers', ts: 1 }
  const ready = (change: Parameters<typeof cuesFrom>[2]) => cuesFrom('f', since, change) as Extract<ReturnType<typeof cuesFrom>, { state: 'ready' }>
  const base = changedSinceVersion(SAVED, SAVED.map((m) => work(m.role, m.path, m.hash)))
  expect(cueChipText(ready(base))).toBe('No changes since “After pilot numbers”')
  expect(cueTotal(ready(base))).toBe(0)
  const two = ready(changedSinceVersion(SAVED, [work('part', 'f/a.md', 'x'), work('part', 'f/b.md', 'y')]))
  expect(cueChipText(two)).toBe('2 parts changed since “After pilot numbers”')
  const one = ready(changedSinceVersion(SAVED, [work('part', 'f/a.md', 'x')]))
  expect(cueChipText(one)).toBe('1 part changed since “After pilot numbers”')
  const mixed = ready(changedSinceVersion(SAVED, [work('part', 'f/a.md', 'x'), work('unlisted', 'f/loose.md', 'z')]))
  expect(cueChipText(mixed)).toBe('1 part and 1 file changed since “After pilot numbers”')
  const files = ready(changedSinceVersion(SAVED, [work('unlisted', 'f/loose.md', 'z')]))
  expect(cueChipText(files)).toBe('1 file changed since “After pilot numbers”')
})

test('the dot has words for a screen reader: what changed in that part', () => {
  const cues = cuesFrom('f', { id: 'fv_1', name: 'V1', ts: 1 }, changedSinceVersion(SAVED, [work('part', 'f/a.md', 'x'), work('part', 'f/c.md'), work('inserted', 'f/data/t.csv', 'y', ['f/c.md', 'f/a.md'])])) as Extract<ReturnType<typeof cuesFrom>, { state: 'ready' }>
  expect(dotLabel(cues, 'f/a.md')).toBe('Changed since “V1”: its text and t.csv changed')
  expect(dotLabel(cues, 'f/c.md')).toBe('Changed since “V1”: t.csv changed')
})

test('part history: how many versions held a part, and the newest in which its text differed from the one before', () => {
  const entry = (id: string, ts: number, fileVersionId: string) => ({ id, name: `V ${id}`, ts, fileVersionId })
  // Newest first: v4 and v3 hold the same text as v2 (reused), v2 changed it, v1 first held it.
  const result = partHistory([entry('4', 4, 'x2'), entry('3', 3, 'x2'), entry('2', 2, 'x2'), entry('1', 1, 'x1')])
  expect(result.count).toBe(4)
  expect(result.lastChanged).toEqual({ id: '2', name: 'V 2', ts: 2 })
  expect(partHistory([entry('1', 1, 'x1')]).lastChanged?.id).toBe('1')
  expect(partHistory([])).toEqual({ count: 0, lastChanged: null })
  expect(partSentence({ versionCount: 4, lastChanged: { name: 'After pilot numbers', ts: 0 } }, () => '19 Oct')).toBe('In 4 Folio versions, last changed 19 Oct (“After pilot numbers”).')
  expect(partSentence({ versionCount: 1, lastChanged: null }, () => '')).toBe('In 1 Folio version.')
  expect(partSentence({ versionCount: 0, lastChanged: null }, () => '')).toBe('Not in any Folio version yet.')
})

test('counting changes in a part: each run of added, removed or reworded paragraphs is one', () => {
  const base = 'One.\n\nTwo.\n\nThree.\n\nFour.\n'
  expect(countChanges(base, base)).toBe(0)
  expect(countChanges(base, 'One.\n\nTwo changed.\n\nThree.\n\nFour.\n')).toBe(1)
  expect(countChanges(base, 'One changed.\n\nTwo.\n\nThree.\n\nFour changed.\n')).toBe(2)
  expect(countChanges(base, 'One.\n\nTwo.\n\nNew line.\n\nThree.\n\nFour.\n')).toBe(1)
  expect(countChanges(base, 'One.\n\nTwo.\n\nThree.\n')).toBe(1)
  // Spacing inside a paragraph is not a change.
  expect(countChanges('A  b\nc.\n', 'A b c.\n')).toBe(0)
  expect(changesSentence({ changesSince: 2 })).toBe('2 changes since that version.')
  expect(changesSentence({ changesSince: 1 })).toBe('1 change since that version.')
  expect(changesSentence({ changesSince: 0 })).toBe('No changes since that version.')
  expect(changesSentence({ changesSince: null })).toBe('New since that version.')
})

test('cells differing in a table, with quoted cells and added rows', () => {
  expect(cellsDiffering('a,b\n1,2\n3,4\n', 'a,b\n1,2\n3,4\n', 't.csv')).toBe(0)
  expect(cellsDiffering('a,b\n1,2\n3,4\n', 'a,b\n1,9\n3,4\n', 't.csv')).toBe(1)
  expect(cellsDiffering('a,b\n1,2\n', 'a,b\n1,2\n5,6\n', 't.csv')).toBe(2)
  expect(cellsDiffering('a,"b,c"\n1,2\n', 'a,"b,c"\n1,2\n', 't.csv')).toBe(0)
  expect(cellsDiffering('a\tb\n1\t2\n', 'a\tb\n1\t3\n', 't.tsv')).toBe(1)
  expect(cellsDiffering('a,b\r\n1,2\r\n', 'a,b\n1,2\n', 't.csv')).toBe(0)
})

test('the file the cursor is on: an image or embed, or a widget line; a blank line beside one; nothing on any other line', () => {
  const text = 'Some text.\n\n![Scores by judge](data/scores-3.csv)\n\n[Simulation: assets/chart.html]\n\nPlain [link](other.csv) line.\n'
  const at = (needle: string): number => text.indexOf(needle) + 2
  expect(embedOnLine(text, at('Scores'))).toBe('data/scores-3.csv')
  expect(embedOnLine(text, at('Simulation'))).toBe('assets/chart.html')
  expect(embedOnLine(text, at('Some text'))).toBeNull()
  expect(embedOnLine(text, at('Plain'))).toBeNull()
  // The edge of the block: the blank line before or after it. A blank line between two embeds takes the one after it.
  const before = text.indexOf('![') - 1
  expect(embedOnLine(text, before)).toBe('data/scores-3.csv')
  expect(embedOnLine(text, text.indexOf('[Simulation') - 1)).toBe('assets/chart.html')
  expect(embedOnLine(text, text.indexOf('\n\n[Simulation') + 1)).toBe('assets/chart.html')
  // The end of the text, on the empty line after the last line, beside the last paragraph: not an embed.
  expect(embedOnLine(text, text.length)).toBeNull()
  expect(embedOnLine('![x](a.png "title")', 3)).toBe('a.png')
  expect(embedOnLine('Words.\n\n![x](a.png)\n', 'Words.\n\n![x](a.png)\n'.length)).toBe('a.png')
  expect(embedOnLine('', 0)).toBeNull()
})

test('the sentences for an inserted file', () => {
  const file = { path: 'f/data/t.csv', kind: 'table' as const, latest: { number: 2, name: 'Outliers removed', id: 'x' }, uses: [{ number: 2, name: 'n', ts: 2, usedBy: [{ id: 'a', name: 'After pilot numbers' }] }, { number: 1, name: 'm', ts: 1, usedBy: [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }] }] }
  expect(insertedStateSentence({ ...file, state: 'changed', cellsChanged: 3 })).toBe('Working copy has 3 cells changed since v2.')
  expect(insertedStateSentence({ ...file, state: 'changed', cellsChanged: 1 })).toBe('Working copy has 1 cell changed since v2.')
  expect(insertedStateSentence({ ...file, state: 'unchanged', cellsChanged: 0 })).toBe('Working copy is the same as v2.')
  expect(insertedStateSentence({ ...file, state: 'new', cellsChanged: null })).toBe('Not in the last Folio version.')
  expect(usesSentence(file.uses)).toBe('v2 used by “After pilot numbers” · v1 used by 3 versions')
})
