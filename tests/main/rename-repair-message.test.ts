import { expect, test } from 'bun:test'
import { formatRenameRepairMessage, type RenameRepairDisplay } from '../../src/shared/rename-repair-message'

function repair(overrides: Partial<RenameRepairDisplay> = {}): RenameRepairDisplay {
  return { writtenPaths: [], issues: [], ...overrides }
}

test('formats every rename-repair issue kind in one user-facing account', () => {
  const message = formatRenameRepairMessage('Renamed to new.md', repair({
    issues: [
      { kind: 'reference', text: 'ref.md: [[old]]' },
      { kind: 'file', text: 'ref.md' },
      { kind: 'reason', text: 'The repair write failed.' },
      { kind: 'outcome', text: 'This now fulfils [[new]] in waiting.md.' },
      { kind: 'preserved', text: 'report/_report_INDEX.md: [[old]] was left unchanged because the renamed file left this report.' },
      { kind: 'available', text: 'report/new.md now matches planned part [[new]] in report/_report_INDEX.md; you can adopt it when you want to.' },
    ],
  }))

  expect(message).toBe(
    'Renamed to new.md. Warning: the rename succeeded, but WriteFlex could not repair 1 reference: ref.md: [[old]]. '
    + 'Repair details: ref.md; The repair write failed. '
    + 'Completed repair action: This now fulfils [[new]] in waiting.md. '
    + 'Preserved plan line: report/_report_INDEX.md: [[old]] was left unchanged because the renamed file left this report. '
    + 'Available action: report/new.md now matches planned part [[new]] in report/_report_INDEX.md; you can adopt it when you want to.',
  )
})

test('a preserved plan line is named without counting it as a failed repair', () => {
  const message = formatRenameRepairMessage('Moved to archive', repair({
    issues: [{
      kind: 'preserved',
      text: 'report/_report_INDEX.md: [[part]] was left unchanged because the renamed file left this report.',
    }],
  }))

  expect(message).toBe(
    'Moved to archive. Preserved plan line: '
    + 'report/_report_INDEX.md: [[part]] was left unchanged because the renamed file left this report.',
  )
  expect(message).not.toContain('could not repair')
  expect(message).not.toContain('Warning')
})

test('an available adoption is not presented as a completed repair action', () => {
  const message = formatRenameRepairMessage('Renamed to adopted.md', repair({
    issues: [{
      kind: 'available',
      text: 'report/adopted.md now matches planned part [[adopted]] in report/_report_INDEX.md; you can adopt it when you want to.',
    }],
  }))

  expect(message).toBe(
    'Renamed to adopted.md. Available action: '
    + 'report/adopted.md now matches planned part [[adopted]] in report/_report_INDEX.md; you can adopt it when you want to.',
  )
  expect(message).not.toContain('Completed repair')
})

test('counts repeated unrepaired references without repeating their text', () => {
  const message = formatRenameRepairMessage('Renamed to new.md', repair({
    issues: Array.from({ length: 3 }, () => ({ kind: 'reference' as const, text: 'ref.md: [[old]]' })),
  }))

  expect(message).toContain('could not repair 3 references: ref.md: [[old]] (×3)')
  expect(message.match(/ref\.md: \[\[old\]\]/g)).toHaveLength(1)
})

test('names the stale file when an applied repair could not be undone', () => {
  const message = formatRenameRepairMessage('Renamed to new.md', repair({
    writtenPaths: ['a-ref.md'],
    issues: [
      { kind: 'reference', text: 'b-ref.md: [[old]]' },
      { kind: 'file', text: 'b-ref.md' },
      { kind: 'reason', text: 'Rollback also failed for a-ref.md: disk refused the write.' },
    ],
  }))

  expect(message).toContain(
    'The repair to a-ref.md was applied and could not be undone, so the workspace is part-way through an abandoned change. '
    + 'The stale file is b-ref.md.',
  )
})

test('formats an outcome-only repair without calling it a failure', () => {
  const message = formatRenameRepairMessage('Renamed to outside/new.md', repair({
    issues: [{
      kind: 'outcome',
      text: 'report/_report-structure.json: old.md was removed because outside/new.md left the report folder.',
    }],
  }))

  expect(message).toBe(
    'Renamed to outside/new.md. Completed repair action: '
    + 'report/_report-structure.json: old.md was removed because outside/new.md left the report folder.',
  )
  expect(message).not.toContain('could not repair')
})

test('an empty result produces no message when there is no success text', () => {
  expect(formatRenameRepairMessage('', repair())).toBe('')
})
