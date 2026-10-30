import { expect, test } from 'bun:test'
import { evidenceAttachment, parseEvidenceTransfer } from '../../src/shared/folio-evidence-transfer'
import { parseEvidence } from '../../src/shared/folio-evidence'

const item = 'zotero://select/library/items/ABCD1234'
const annotation = 'zotero://open-pdf/library/items/EFGH5678?annotation=IJKL9012'

test('dropping a confirmed Zotero highlight attaches its item and chooses the highlight as one operation without storing quote text', () => {
  const answer = evidenceAttachment('Intro', 'paper', { kind: 'zotero', label: 'Smith 2025', itemTarget: item, annotation: { target: annotation, label: 'Smith 2025, p. 4' } }, [])
  expect(answer.op?.expect).toBeNull()
  const parsed = parseEvidence('## [[Intro]]\n### Evidence\n' + answer.op!.value!).sections[0].items[0]
  expect(parsed.target).toBe(item)
  expect(parsed.highlights[0].target).toBe(annotation)
  expect(answer.op?.value).not.toContain('Quote words')
})

test('choosing a highlight expects the whole parent subtree and a pending mark attaches only its item', () => {
  const first = evidenceAttachment('Intro', 'paper', { kind: 'zotero', label: 'Smith 2025', itemTarget: item }, [])
  const parsed = parseEvidence('## [[Intro]]\n### Evidence\n' + first.op!.value!).sections[0].items
  const chosen = evidenceAttachment('Intro', 'paper', { kind: 'zotero', label: 'Smith 2025', itemTarget: item, annotation: { target: annotation, label: 'Smith 2025, p. 4' } }, parsed)
  expect(chosen.op?.expect).toBe(parsed[0].raw)
  const pending = evidenceAttachment('Intro', 'paper', { kind: 'zotero', label: 'Smith 2025', itemTarget: item, pending: true, annotation: { target: annotation, label: 'Pending' } }, [])
  expect(pending.op!.value).not.toContain('annotation=')
  expect(pending.message).toContain('not in Zotero yet')
})

test('file passages use normalised quote identity; archive links retain their native URI without storing quote selection', () => {
  const file = evidenceAttachment('Planned', 'paper', { kind: 'file', path: 'paper/research/source.md', quote: 'A  chosen\npassage.' }, [])
  expect(file.op!.value).toContain('  - “A chosen passage.”')
  const archive = evidenceAttachment('Intro', 'paper', { kind: 'archive', title: 'Saved writing', url: 'writeflex://open?path=note.md&line=5' }, [])
  expect(archive.op!.value).toContain('writeflex://open?path=note.md&line=5')
  expect(() => evidenceAttachment('Intro', 'paper', { kind: 'archive', title: 'Bad', url: 'javascript:alert(1)' }, [])).toThrow()
  expect(parseEvidenceTransfer('{"kind":"zotero","label":"Bad","itemTarget":"javascript:bad"}')).toBeNull()
})
