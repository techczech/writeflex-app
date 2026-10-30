import { expect, test } from 'bun:test'
import { parseEvidence, applyEvidenceOps, undoEvidenceOps, evidenceKey, EVIDENCE_LEAD, repointEvidenceLine } from '../../src/shared/folio-evidence'

const item = '- [study.md](research/study.md)\n  - “A supported claim.”\n'
const source = 'Foreign lead\r\n\r\n## [[Intro]]\r\n\r\n### Evidence\r\n' + item.replace(/\n/g, '\r\n') + '\r\nForeign paragraph\r\n\r\n### Notes\r\nAn original note.\r\n\r\n## [[Orphan]]\r\nKeep this foreign section.\r\n'

test('evidence parser finds item subtrees, notes and duplicates without treating fenced headings as sections', () => {
  const read = parseEvidence(source + '\n```md\n## [[Fake]]\n```\n\n## [[Intro]]\n\n### Evidence\n- [[Other note]]\n')
  expect(read.sections.map(section => section.title)).toEqual(['Intro', 'Orphan', 'Intro'])
  expect(read.sections[0].items[0].raw).toBe(item.replace(/\n/g, '\r\n'))
  expect(read.sections[0].items[0].highlights[0].quote).toBe('A supported claim.')
  expect(read.sections[0].notes?.raw).toBe('An original note.\r\n\r\n')
})

test('attach and notes work for an unwritten part, create the lead once and undo by inverse operations, byte for byte', () => {
  const op = { kind: 'item' as const, part: 'Planned', key: evidenceKey('research/study.md'), expect: null, value: item }
  const attached = applyEvidenceOps('', [op])
  expect(attached.source.startsWith(EVIDENCE_LEAD)).toBe(true)
  expect(parseEvidence(attached.source).sections[0].items[0].raw).toBe(item)
  expect(applyEvidenceOps(attached.source, [op]).refused).toHaveLength(1)
  const note = applyEvidenceOps(attached.source, [{ kind: 'notes', part: 'Planned', expect: null, value: 'Make this argument.\n' }])
  const undone = undoEvidenceOps(note.source, note.inverse)
  expect(undone.refused).toEqual([])
  expect(parseEvidence(undone.source).sections[0].notes).toBeNull()
  expect(undone.source).toBe(attached.source)
  // The Undo of the first attach gives back the file as it was: empty, lead and all gone.
  const empty = undoEvidenceOps(undone.source, attached.inverse)
  expect(empty.refused).toEqual([])
  expect(empty.source).toBe('')
  // S7-1 (r7): with text added since at the end of the appended section, the restore is refused, nothing changed.
  for (const added of ['Hand prose.\n', '\n### Notes\nHand notes.\n']) {
    const later = undoEvidenceOps(undone.source + added, attached.inverse)
    expect(later.refused).toHaveLength(1)
    expect(later.source).toBe(undone.source + added)
  }
})

test('disjoint changes rebase; same-item and same-notes changes refuse without deleting the external version', () => {
  const read = parseEvidence(source).sections[0]
  const changed = source.replace('A supported claim.', 'A newer chosen highlight.').replace('An original note.', 'External notes.')
  const result = applyEvidenceOps(changed, [
    { kind: 'item', part: 'Intro', key: read.items[0].key, expect: read.items[0].raw, value: null },
    { kind: 'notes', part: 'Intro', expect: read.notes!.raw, value: 'My notes.\r\n' },
    { kind: 'item', part: 'Intro', key: evidenceKey('Another note', 'note'), expect: null, value: '- [[Another note]]\r\n' },
  ])
  expect(result.refused).toHaveLength(2)
  expect(result.applied).toHaveLength(1)
  expect(result.source).toContain('A newer chosen highlight.')
  expect(result.source).toContain('External notes.')
  expect(result.source).toContain('- [[Another note]]')
  expect(result.source.endsWith('## [[Orphan]]\r\nKeep this foreign section.\r\n')).toBe(true)
})

test('line-only Keep retains highlights and every foreign byte; removing an item keeps foreign paragraphs', () => {
  const read = parseEvidence(source).sections[0].items[0]
  const nextLine = '- [study.md](research/study.md) <!--wf:sha1-16=0123456789abcdef-->\r\n'
  const kept = applyEvidenceOps(source, [{ kind: 'line', part: 'Intro', key: read.key, expect: read.line, value: nextLine }])
  expect(kept.source).toBe(source.replace(read.line, nextLine))
  expect(undoEvidenceOps(kept.source, kept.inverse).source).toBe(source)
  const removed = applyEvidenceOps(source, [{ kind: 'item', part: 'Intro', key: read.key, expect: read.raw, value: null }])
  expect(removed.source).toContain('Foreign paragraph\r\n\r\n### Notes\r\nAn original note.')
})

test('a duplicate section is read but an attachment already there cannot be attached a second time', () => {
  const duplicate = source + '\n## [[Intro]]\n\n### Evidence\n- [[Elsewhere]]\n'
  const result = applyEvidenceOps(duplicate, [{ kind: 'item', part: 'Intro', key: evidenceKey('Elsewhere', 'note'), expect: null, value: '- [[Elsewhere]]\n' }])
  expect(result.refused).toHaveLength(1)
  expect(result.source).toBe(duplicate)
})


test('attaching alongside a notes edit does not change the notes expectation through inserted spacing', () => {
  const before = 'Lead\n\n## [[Intro]]\n\n### Notes\nOld.\n'
  const result = applyEvidenceOps(before, [
    { kind: 'item', part: 'Intro', key: evidenceKey('research/study.md'), expect: null, value: item },
    { kind: 'notes', part: 'Intro', expect: 'Old.\n', value: 'New.\n' },
  ])
  expect(result.refused).toEqual([])
  expect(result.applied).toHaveLength(2)
  expect(parseEvidence(result.source).sections[0].notes?.raw).toBe('New.\n')
})

test('list items inside a fenced example under Evidence stay foreign', () => {
  const before = '## [[Intro]]\n\n### Evidence\n```md\n- [Example](example.md)\n```\n'
  expect(parseEvidence(before).sections[0].items).toEqual([])
})


test('a line-only edit refuses a multiline replacement and a BOM is kept when clearing the first section', () => {
  expect(() => applyEvidenceOps(source, [{ kind: 'line', part: 'Intro', key: evidenceKey('research/study.md'), expect: parseEvidence(source).sections[0].items[0].line, value: '- [other](other.md)\n- [extra](extra.md)\n' }])).toThrow()
  const bom = '\ufeff## [[Intro]]\r\n\r\n### Notes\r\nOld.\r\n'
  const read = parseEvidence(bom)
  expect(read.sections).toHaveLength(1)
  const cleared = applyEvidenceOps(bom, [{ kind: 'notes', part: 'Intro', expect: 'Old.\r\n', value: null }])
  expect(cleared.source).toBe('\ufeff')
})


test('Find again refuses a destination that is already attached, so Undo cannot switch ownership', () => {
  const before = '## [[Intro]]\n### Evidence\n- [B](b.md)\n  - “B quote”\n- [A](a.md)\n  - “A quote”\n'
  const item = parseEvidence(before).sections[0].items[1]
  const repair = applyEvidenceOps(before, [{ kind: 'line', part: 'Intro', key: item.key, expect: item.line, value: '- [B](b.md)\n' }])
  expect(repair.refused).toHaveLength(1)
  expect(repair.source).toBe(before)
})

test('repointing a source changes its destination while keeping provenance, label and foreign comments', () => {
  expect(repointEvidenceLine('- [old.md](old.md) — provenance <!--custom:keep-->\r\n', 'research/new.md')).toBe('- [old.md](research/new.md) — provenance <!--custom:keep-->\r\n')
})

test('attach after an unterminated item creates a real item and has a usable inverse', () => {
  const before = '## [[Intro]]\n### Evidence\n- [[Existing]]'
  const added = applyEvidenceOps(before, [{ kind: 'item', part: 'Intro', key: evidenceKey('New', 'note'), expect: null, value: '- [[New]]\n' }])
  expect(parseEvidence(added.source).sections[0].items.map(item => item.target)).toEqual(['Existing', 'New'])
  const undone = undoEvidenceOps(added.source, added.inverse)
  expect(undone.refused).toEqual([])
  expect(undone.source).toBe(before)
})

test('a fence with trailing info does not close an open code fence', () => {
  const before = '```md\n```not-a-closing-fence\n## [[Intro]]\n### Evidence\n- [[Example]]\n```\n'
  expect(parseEvidence(before).sections).toEqual([])
})
