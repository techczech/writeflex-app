import { describe, expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import { folioComments, folioCommentsCountText } from '../../src/renderer/src/app/folio-comments'
import { matchFolios, vaultFolios } from '../../src/renderer/src/vault-folios'
import type { VaultIndex } from '../../src/shared/vault-index'

let next = 0
function change(path: string, fields: Partial<Change> = {}): Change {
  next += 1
  return {
    id: `c${next}`, path, ts: 1_000 + next, provenance: 'agent', editClass: 'content', category: null, summary: '',
    oldText: 'old', newText: 'new', status: 'pending', isCorrection: false, ...fields,
  } as Change
}
const comment = (path: string, text: string, from: number, fields: Partial<Change> = {}): Change =>
  change(path, { oldText: 'words', newText: 'words', summary: text, anchor: { from, to: from + 5 }, ...fields })

const OUTLINE = {
  pieces: [
    { path: 'paper/01-intro.md', title: 'Introduction', headings: [] },
    { path: 'paper/02-methods.md', title: 'Methods', headings: [] },
    { path: 'paper/03-results.md', title: 'Results', headings: [] },
  ],
  also: [{ path: 'paper/notes.md', title: 'Notes', headings: [] }],
}

describe('All comments in this Folio', () => {
  test('groups waiting comments and edits by part in running order, by place inside a part', () => {
    const changes = [
      comment('paper/03-results.md', 'Results comment', 10),
      comment('paper/01-intro.md', 'Second in intro', 200),
      change('paper/02-methods.md', { oldText: 'n = 12', newText: 'n = 14', anchor: { from: 40, to: 46 } }),
      comment('paper/01-intro.md', 'First in intro', 5),
      comment('paper/notes.md', 'A note on the notes', 0),
      comment('elsewhere/other.md', 'Not in this Folio', 0),
    ]
    const result = folioComments(OUTLINE, changes)
    expect(result.groups.map((group) => [group.title, group.position])).toEqual([
      ['Introduction', 1], ['Methods', 2], ['Results', 3], ['Notes', null],
    ])
    expect(result.groups[0].rows.map((row) => row.text)).toEqual(['First in intro', 'Second in intro'])
    expect(result.groups[1].rows[0]).toMatchObject({ kind: 'edit', label: 'Suggested edit', quote: 'n = 12', text: 'n = 14', who: 'Agent' })
    expect(result.comments).toBe(4)
    expect(result.edits).toBe(1)
    expect(folioCommentsCountText(result)).toBe('4 comments and 1 suggested edit in 4 parts')
  })

  test('leaves out what the margin does not wait on: settled, quiet fixes and the writer\'s own edits', () => {
    const changes = [
      comment('paper/01-intro.md', 'Done already', 1, { status: 'accepted' }),
      change('paper/01-intro.md', { editClass: 'copy' }),
      change('paper/01-intro.md', { provenance: 'writer' }),
      comment('paper/01-intro.md', 'Held one', 3, { status: 'held' }),
    ]
    const result = folioComments(OUTLINE, changes)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].rows.map((row) => [row.text, row.held])).toEqual([['Held one', true]])
  })

  test("a reader's comment is named by the reader and quotes what they selected", () => {
    const reader = comment('paper/02-methods.md', '', 4, {
      outsideSource: 'reader',
      readerNote: { shareId: 's', key: 'r.1', link: 'Paper link', name: 'Kudzai', kind: 'note', text: 'Clarify this', quote: 'the sample', anchored: 'unchanged', at: 5 },
    } as Partial<Change>)
    const [row] = folioComments(OUTLINE, [reader]).groups[0].rows
    expect(row).toMatchObject({ who: 'Kudzai', quote: 'the sample', text: 'Clarify this', label: 'Comment' })
  })

  test('nothing waiting says so', () => {
    expect(folioCommentsCountText(folioComments(OUTLINE, []))).toBe('Nothing is waiting in this Folio.')
  })
})

describe('Folios by their own title', () => {
  const index: Pick<VaultIndex, 'works'> = {
    works: [
      { path: 'reports/unity', kind: 'folio', title: 'UnityBC working manuscript', status: null, mainPath: null, parts: [], sidecars: [], support: [] },
      { path: 'loose.md', kind: 'file', title: 'A loose note', status: null, mainPath: 'loose.md', parts: [], sidecars: [], support: [] },
      { path: 'papers/unity', kind: 'folio', title: 'UnityBC paper', status: null, mainPath: null, parts: [], sidecars: [], support: [] },
    ],
  }
  test('lists only Folios, sorted by title', () => {
    expect(vaultFolios(index)).toEqual([
      { path: 'papers/unity', title: 'UnityBC paper' },
      { path: 'reports/unity', title: 'UnityBC working manuscript' },
    ])
  })
  test('finds a Folio by title or by folder path', () => {
    const folios = vaultFolios(index)
    expect(matchFolios('manuscript', folios).map((row) => row.path)).toEqual(['reports/unity'])
    expect(matchFolios('papers', folios).map((row) => row.path)).toEqual(['papers/unity'])
    expect(matchFolios('', folios)).toHaveLength(2)
  })
})
