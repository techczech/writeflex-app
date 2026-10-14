import { expect, test } from 'bun:test'
import {
  ABSENT,
  displayRows,
  driftedFiles,
  planOperations,
  proposalEntries,
  resolveProposal,
  setEntriesEnabled,
  staleMessage,
  undoRefusalMessage,
  withWriterMove,
  type ProposalBasis,
} from '../../src/shared/plan-proposal'

const dir = 'notes'
const noIndex: ProposalBasis = {
  dir,
  hasIndexNote: false,
  indexPath: `${dir}/_notes_INDEX.md`,
  parts: [],
  strays: [
    { path: `${dir}/00_strategy-framework-Studio Mac.md`, title: 'Framework for Community Garden Planning', words: 629 },
    { path: `${dir}/00_strategy-framework.md`, title: 'Framework for Community Garden Planning', words: 840 },
    { path: `${dir}/01_shared-language.md`, title: 'Shared language for garden planning', words: 154 },
    { path: `${dir}/02_key-strategic-moves.md`, title: 'Key strategic moves', words: 12 },
  ],
}
const ordered: ProposalBasis = {
  dir,
  hasIndexNote: true,
  indexPath: `${dir}/_notes_INDEX.md`,
  parts: [
    { title: 'Opening', gloss: null, role: 'section', path: `${dir}/01-opening.md`, words: 100 },
    { title: 'Middle', gloss: null, role: 'section', path: `${dir}/02-middle.md`, words: 200 },
    { title: 'Unwritten close', gloss: 'the end', role: 'section', path: null, words: null },
  ],
  strays: [{ path: `${dir}/stray.md`, title: 'Stray', words: 50, role: 'appendix' }],
}

const threeAdds = proposalEntries([
  { op: 'insert', title: 'Framework for Community Garden Planning', role: 'summary' },
  { op: 'insert', title: 'Shared language for garden planning' },
  { op: 'insert', title: 'Key strategic moves' },
])

test('frame 2: three additions, the conflict copy listed outside the order, three changes counted', () => {
  const proposed = resolveProposal(noIndex, threeAdds)
  expect(proposed.errors).toEqual([])
  expect(proposed.createsIndexNote).toBe(true)
  expect(proposed.count).toBe(3)
  expect(proposed.rows.map((row) => [row.mark, row.path, row.words])).toEqual([
    ['add', `${dir}/00_strategy-framework.md`, 840],
    ['add', `${dir}/01_shared-language.md`, 154],
    ['add', `${dir}/02_key-strategic-moves.md`, 12],
  ])
  expect(proposed.rows[0]).toMatchObject({ role: 'summary', roleSet: true })
  expect(proposed.outside.map((file) => file.path)).toEqual([`${dir}/00_strategy-framework-Studio Mac.md`])
})

test('frame 3: dropping a change and dragging an added row leaves two changes, the dragged row marked moved', () => {
  let entries = setEntriesEnabled(threeAdds, ['c2'], false)
  entries = withWriterMove(entries, 'Key strategic moves', 1)
  const proposed = resolveProposal(noIndex, entries)
  expect(proposed.count).toBe(2)
  expect(proposed.rows.map((row) => [row.title, row.mark])).toEqual([
    ['Framework for Community Garden Planning', 'add'],
    ['Key strategic moves', 'move'],
  ])
  const shown = displayRows(noIndex, entries)
  expect(shown.rows.map((row) => [row.title, row.dropped])).toEqual([
    ['Framework for Community Garden Planning', false],
    ['Key strategic moves', false],
    ['Shared language for garden planning', true],
  ])
  expect(shown.rows[2].droppedIds).toEqual(['c2'])
  // ↺ restores it.
  expect(resolveProposal(noIndex, setEntriesEnabled(entries, ['c2'], true)).count).toBe(3)
})

test('a writer drag of an unchanged part is a change of its own', () => {
  const entries = withWriterMove(proposalEntries([{ op: 'setRole', title: 'Middle', role: 'appendix' }]), 'Opening', 2)
  const proposed = resolveProposal(ordered, entries)
  expect(proposed.count).toBe(2)
  expect(proposed.rows.map((row) => row.title)).toEqual(['Middle', 'Unwritten close', 'Opening'])
})

test('remove marks the part taken out; invalid changes are reported, not half-applied', () => {
  const proposed = resolveProposal(ordered, proposalEntries([
    { op: 'remove', title: 'middle' },
    { op: 'move', title: 'Nope', to: 0 },
    { op: 'materialise', title: 'Opening' },
    { op: 'setRole', title: 'Opening', role: 'opening' },
    { op: 'adopt', path: `${dir}/01-opening.md` },
  ]))
  expect(proposed.removed.map((row) => [row.title, row.mark])).toEqual([['Middle', 'out']])
  expect(proposed.count).toBe(1)
  expect(proposed.errors).toEqual([
    'move "Nope": no part with that title is in the running order',
    'write out "Opening": that part is already written',
    'set the role of "Opening": unknown role "opening"; use one of section, vignette, appendix, summary',
    `adopt ${dir}/01-opening.md: that file is already in the running order`,
  ])
})

test('the write sequence: remove, adopt, insert, reorder, set roles, then write out at the final place', () => {
  const proposed = resolveProposal(ordered, proposalEntries([
    { op: 'remove', title: 'Opening' },
    { op: 'adopt', path: `${dir}/stray.md`, at: 0 },
    { op: 'insert', title: 'New bit', at: 1, gloss: 'fresh' },
    { op: 'setRole', title: 'Middle', role: 'vignette' },
    { op: 'materialise', title: 'Unwritten close' },
  ]))
  expect(proposed.rows.map((row) => row.title)).toEqual(['Stray', 'New bit', 'Middle', 'Unwritten close'])
  expect(planOperations(ordered, proposed)).toEqual([
    { op: 'removePart', title: 'Opening' },
    { op: 'adoptPart', path: `${dir}/stray.md`, title: 'Stray' },
    { op: 'insertPart', title: 'New bit', gloss: 'fresh' },
    { op: 'movePart', title: 'Stray', to: 0 },
    { op: 'movePart', title: 'New bit', to: 1 },
    { op: 'setPartRole', title: 'Middle', role: 'vignette' },
    { op: 'materialisePart', title: 'Unwritten close', index: 3 },
  ])
})

test('no Index Note: the sequence starts by creating it', () => {
  expect(planOperations(noIndex, resolveProposal(noIndex, threeAdds))[0]).toEqual({ op: 'createIndexNote' })
})

test('fingerprints: a rename is found by content, a retitle by title, an edit of a written file by hash', () => {
  const drift = driftedFiles([
    { path: 'r/_r_INDEX.md', hash: 'i1' },
    { path: 'r/02_key.md', hash: 'k1', title: 'Key strategic moves' },
    { path: 'r/01_a.md', hash: 'a1', title: 'A' },
    { path: 'r/03-new.md', hash: ABSENT },
  ], [
    { path: 'r/_r_INDEX.md', hash: 'i2' },
    { path: 'r/02_moves.md', hash: 'k1', title: 'Key strategic moves' },
    { path: 'r/01_a.md', hash: 'a2', title: 'A renamed' },
  ])
  expect(drift).toEqual([
    { path: 'r/_r_INDEX.md', kind: 'edited' },
    { path: 'r/02_key.md', kind: 'renamed', to: 'r/02_moves.md', fromTitle: 'Key strategic moves', toTitle: 'Key strategic moves' },
    { path: 'r/01_a.md', kind: 'retitled', fromTitle: 'A', toTitle: 'A renamed' },
  ])
  // A part's prose edit alone is not drift: its title still resolves.
  expect(driftedFiles([{ path: 'r/01_a.md', hash: 'a1', title: 'A' }], [{ path: 'r/01_a.md', hash: 'zz', title: 'A' }])).toEqual([])
})

test('frame 6 and frame 5 sentences', () => {
  expect(staleMessage([{ path: 'r/02_key-strategic-moves.md', kind: 'renamed', to: 'r/x.md' }]))
    .toBe('The folder changed after this was proposed: 02_key-strategic-moves.md was renamed.')
  expect(undoRefusalMessage({
    drift: [{ path: 'r/02_key.md', kind: 'renamed', fromTitle: 'Key strategic moves', toTitle: 'Moves for 2027' }],
    laterAgentFiles: [],
  })).toBe("Can't put the order back: you have since renamed Key strategic moves to Moves for 2027, and undoing would bring back the old name in the plan. Undo the rename first, or change the order in the Plan pane.")
  expect(undoRefusalMessage({ drift: [], laterAgentFiles: ['r/draft.md'] }))
    .toBe("Can't put the order back: a later agent change to draft.md would be undone with it. Undo that turn first, or change the order in the Plan pane.")
})
