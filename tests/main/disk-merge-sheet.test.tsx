import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiskMergeSheet, diskMergeSummary, diskMergeTabTarget } from '../../src/renderer/src/components/DiskMergeSheet'
import { threeWayMerge } from '../../src/shared/three-way-merge'

const doc = (...paras: string[]): string => `${paras.join('\n\n')}\n`
const noop = (): void => {}

test('the summary says how the versions combine and what is asked', () => {
  const base = doc('A.', 'B.', 'C.')
  expect(diskMergeSummary(threeWayMerge(base, doc('A!', 'B.', 'C.'), doc('A.', 'B.', 'C!'))))
    .toBe('1 change from the disk and 1 of yours combine on their own. Nothing overlaps.')
  expect(diskMergeSummary(threeWayMerge(base, base, doc('A!', 'B.', 'C!'))))
    .toBe('2 changes from the disk combine on their own. Nothing overlaps.')
  expect(diskMergeSummary(threeWayMerge(base, doc('A.', 'B mine.', 'C.'), doc('A.', 'B disk.', 'C.'))))
    .toBe('1 place was changed in both: choose what to keep.')
  expect(diskMergeSummary(threeWayMerge(base, doc('A1', 'B.', 'C1'), doc('A2', 'B.', 'C2'))))
    .toBe('2 places were changed in both: choose what to keep in each.')
  expect(diskMergeSummary(threeWayMerge(base, base, base))).toBe('The two versions say the same thing. Merging keeps your text.')
})

test('the sheet shows each place both changed with its three choices, and Merge waits for them', () => {
  const merge = threeWayMerge(doc('Intro.', 'The cat sat.'), doc('Intro.', 'The cat sat down.'), doc('Intro.', 'The dog sat.'))
  const html = renderToStaticMarkup(<DiskMergeSheet fileName="note.md" merge={merge} busy={false} onMerge={noop} onCancel={noop} />)
  expect(html).toContain('Merge with the version on disk')
  expect(html).toContain('data-testid="disk-merge-conflict"')
  for (const label of ['Keep mine', 'Take disk', 'Keep both']) expect(html).toContain(label)
  expect(html).toMatch(/<button[^>]*class="btn primary dm-merge"[^>]*disabled/)
  expect(html).toContain('Choose for 1 more place to merge.')
})

test('with nothing overlapping, Merge is ready at once', () => {
  const merge = threeWayMerge(doc('A.', 'B.'), doc('A mine.', 'B.'), doc('A.', 'B disk.'))
  const html = renderToStaticMarkup(<DiskMergeSheet fileName="note.md" merge={merge} busy={false} onMerge={noop} onCancel={noop} />)
  expect(html).not.toContain('disk-merge-conflict')
  expect(html).not.toMatch(/<button[^>]*class="btn primary dm-merge"[^>]*disabled/)
  expect(html).toContain('Both versions are kept in History before the merge is saved.')
})

test('while a clean merge is written nothing is enabled, and Tab stays on the dialog itself', () => {
  const merge = threeWayMerge(doc('A.', 'B.'), doc('A mine.', 'B.'), doc('A.', 'B disk.'))
  const html = renderToStaticMarkup(<DiskMergeSheet fileName="note.md" merge={merge} busy={true} onMerge={noop} onCancel={noop} />)
  // Both buttons disabled and no choices: the dialog is the one thing that can hold focus.
  expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>/)
  expect(html).not.toContain('type="radio"')
  expect(html).toMatch(/role="dialog"[^>]*tabindex="-1"/i)
  expect(diskMergeTabTarget(0, -1, false)).toBe('dialog')
  expect(diskMergeTabTarget(0, -1, true)).toBe('dialog')
  // With controls, Tab cycles through them and never leaves.
  expect(diskMergeTabTarget(2, 1, false)).toBe(0)
  expect(diskMergeTabTarget(2, 0, true)).toBe(1)
  expect(diskMergeTabTarget(2, -1, false)).toBe(0)
})
