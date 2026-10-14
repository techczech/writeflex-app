import { expect, test } from 'bun:test'
import { goalPercent, isOverdue, parseFrontmatter, parseGoal } from '../../src/main/frontmatter'
import { removeFrontmatterKeys, setFrontmatterKeys } from '../../src/main/capabilities'

// Round A Task 5: frontmatter goals (ADR-0002 zero-token instrumentation; ADR-0019 the file is the
// truth; ADR-0028 the Goal Gauge upgrades the count cell in place). parseGoal is the ONE reading of
// `goal:`/`due:`; malformed frontmatter reads as null — plain count, never error chrome.

const goalOf = (text: string): ReturnType<typeof parseGoal> => parseGoal(parseFrontmatter(text))

test('parseGoal reads goal and due from ordinary frontmatter', () => {
  expect(goalOf('---\ntitle: Piece\ngoal: 5000\ndue: 2026-08-15\n---\n\nBody.\n')).toEqual({
    target: 5000,
    due: '2026-08-15',
  })
  expect(goalOf('---\ngoal: 50\n---\n\nBody.\n')).toEqual({ target: 50, due: null })
})

test('malformed goal values read as null — no gauge, no error chrome', () => {
  expect(goalOf('---\ngoal: soon\n---\nBody.\n')).toBeNull()
  expect(goalOf('---\ngoal: -100\n---\nBody.\n')).toBeNull()
  expect(goalOf('---\ngoal: 0\n---\nBody.\n')).toBeNull()
  expect(goalOf('---\ngoal: 3.5\n---\nBody.\n')).toBeNull()
  expect(goalOf('---\ngoal: [50, 60]\n---\nBody.\n')).toBeNull()
  expect(goalOf('---\ngoal:\n---\nBody.\n')).toBeNull()
})

test('absent goal, bare files, and null frontmatter all read as null', () => {
  expect(goalOf('---\ntitle: Piece\n---\nBody.\n')).toBeNull()
  expect(goalOf('Just prose, no frontmatter.\n')).toBeNull()
  expect(parseGoal(null)).toBeNull()
})

test('an invalid due degrades to no due while the goal survives', () => {
  expect(goalOf('---\ngoal: 100\ndue: soon\n---\nBody.\n')).toEqual({ target: 100, due: null })
  expect(goalOf('---\ngoal: 100\ndue: 2026-13-40\n---\nBody.\n')).toEqual({ target: 100, due: null })
  expect(goalOf('---\ngoal: 100\ndue: 15/08/2026\n---\nBody.\n')).toEqual({ target: 100, due: null })
})

test('goalPercent is proportional below target and caps at 100', () => {
  expect(goalPercent(0, 5000)).toBe(0)
  expect(goalPercent(3250, 5000)).toBe(65)
  expect(goalPercent(5000, 5000)).toBe(100)
  expect(goalPercent(9999, 5000)).toBe(100)
})

test('overdue boundary: due today is NOT overdue; yesterday is; no due never is', () => {
  const today = new Date(2026, 6, 24) // 24 July 2026, local
  expect(isOverdue('2026-07-24', today)).toBe(false)
  expect(isOverdue('2026-07-23', today)).toBe(true)
  expect(isOverdue('2026-07-25', today)).toBe(false)
  expect(isOverdue('2025-12-31', today)).toBe(true)
  expect(isOverdue(null, today)).toBe(false)
})

// ---- The goal:set write path (setFrontmatterKeys + removeFrontmatterKeys) ---------------------

test('setting a goal rewrites only the frontmatter — the body survives byte-for-byte', () => {
  const doc = '---\ntitle: T\n---\n\nOne line.\n\nTwo.\n'
  expect(setFrontmatterKeys(doc, { goal: '50', due: '2026-08-15' })).toBe(
    '---\ntitle: T\ngoal: 50\ndue: 2026-08-15\n---\n\nOne line.\n\nTwo.\n',
  )
})

for (const eol of ['\n', '\r\n'] as const) {
  test(`setting a goal refuses a trailing-space spelling collision (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const doc = `---${eol}goal : 500${eol}---${eol}${eol}Body stays.${eol}`
    expect(() => setFrontmatterKeys(doc, { goal: '900' }, 'goals.md'))
      .toThrow(/goals\.md.*line 2 reads .*goal : 500/)
    expect(doc).toBe(`---${eol}goal : 500${eol}---${eol}${eol}Body stays.${eol}`)
  })
}

test('removeFrontmatterKeys clears goal and due, keeping other keys and the exact body', () => {
  const doc = '---\ntitle: T\ngoal: 50\ndue: 2026-08-15\n---\n\nBody stays.\n'
  expect(removeFrontmatterKeys(doc, ['goal', 'due'])).toBe('---\ntitle: T\n---\n\nBody stays.\n')
})

test('removing the only keys removes the whole block — bare files stay bare (ADR-0008)', () => {
  expect(removeFrontmatterKeys('---\ngoal: 50\n---\n\nBody.\n', ['goal', 'due'])).toBe('Body.\n')
})

test('removeFrontmatterKeys is a no-op on bare files, missing keys, and an empty key list', () => {
  expect(removeFrontmatterKeys('Bare prose.\n', ['goal'])).toBe('Bare prose.\n')
  const doc = '---\ntitle: T\n---\nBody.\n'
  expect(removeFrontmatterKeys(doc, ['goal', 'due'])).toBe(doc)
  expect(removeFrontmatterKeys(doc, [])).toBe(doc)
})

test('goal clear refuses an unsafe unrelated entry and preserves the complete document', () => {
  const doc = '---\ngoal: 500\nauthors:\n  - name: Ada\n---\n\nBody stays.\n'
  expect(() => removeFrontmatterKeys(doc, ['goal', 'due'], 'goals.md'))
    .toThrow(/goals\.md.*cannot safely rewrite this block: line 4 reads .*name: Ada/)
  expect(doc).toBe('---\ngoal: 500\nauthors:\n  - name: Ada\n---\n\nBody stays.\n')
})
