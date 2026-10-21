import { expect, test } from 'bun:test'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { headingPlainText, partTitle } from '../../src/shared/folio-part-title'
import { PART_HEADING_IS_A_CHANGE, titleConflict, titleConflictSentence, titleHeadingInsertable, withTitleFixed } from '../../src/shared/title-conflict'

// Title-conflict buttons (2026-10-19): when a document's `title:` and its heading disagree, two one-click fixes.
// Seam: shared/title-conflict.ts (the rule and the text of each fix), used by main and by the open document's bar.

const fm = (title: string, extra = ''): string => `---\ntitle: ${title}\n${extra}---\n\n`

test('the conflict rule, as a table: pieces and parts', () => {
  const cases: Array<[string, string, boolean, { title: string; heading: string } | null]> = [
    // [name, source, is a Folio part, conflict]
    ['title and heading differ', `${fm('New')}# Old\n`, false, { title: 'New', heading: 'Old' }],
    ['a letter-case difference is not a conflict', `${fm('the new title')}# The New Title\n`, false, null],
    ['spacing aside', `${fm('The  new')}#   The new  \n`, false, null],
    ['a footnote in the heading is not part of its text', `${fm('Old')}# Old[^1]\n\n[^1]: Note.\n`, false, null],
    ['a footnote in the heading, and a different title', `${fm('New')}# Old[^1]\n`, false, { title: 'New', heading: 'Old' }],
    ['heading: none never conflicts', `${fm('New', 'heading: none\n')}# Old\n`, false, null],
    ['heading: none never conflicts for a part', `${fm('New', 'heading: none\n')}# Old\n`, true, null],
    ['no title never conflicts (bare stays bare)', '# Old\n\nText.\n', false, null],
    ['an empty title never conflicts', '---\ntitle:\n---\n\n# Old\n', false, null],
    ['no heading never conflicts', `${fm('New')}Just words.\n`, false, null],
    ['a piece: the top heading at any level names it', `${fm('New')}### Old\n`, false, { title: 'New', heading: 'Old' }],
    ['a piece: a heading after a paragraph is not compared', `${fm('New')}Intro.\n\n# Old\n`, false, null],
    ['a part: a # heading after a paragraph is not compared', `${fm('New')}Intro.\n\n# Old\n`, true, null],
    ['blank lines before the top heading still count as top', `${fm('New')}\n\n\n# Old\n`, false, { title: 'New', heading: 'Old' }],
    ['a part: blank lines before the top heading still count as top', `${fm('New')}\n\n# Old\n`, true, { title: 'New', heading: 'Old' }],
    ['a piece: a setext heading names it', `${fm('New')}Old\n===\n`, false, { title: 'New', heading: 'Old' }],
    ['a piece: a heading in a code fence does not count', `${fm('New')}\`\`\`\n# Old\n\`\`\`\n`, false, null],
    ['a part: its # heading', `${fm('New')}# Old\n`, true, { title: 'New', heading: 'Old' }],
    ['a part: a lower first heading that is a subsection is not its title', `${fm('New')}## Background\n`, true, null],
    ['a part: a lower first heading that says the title, in another case', `${fm('Kapitola 4')}## KAPITOLA 4\n`, true, null],
  ]
  for (const [name, source, part, expected] of cases) {
    expect([name, titleConflict(source, 'p/03-cost.md', { part })]).toEqual([name, expected])
  }
})

test('for a part the conflict is exactly the part-title rule’s mismatch', () => {
  for (const source of [`${fm('New')}# Old\n`, `${fm('old')}# Old\n`, `${fm('New')}## Old\n`, '# Old\n', `${fm('T', 'heading: none\n')}# X\n`]) {
    expect([source, titleConflict(source, 'p.md', { part: true }) !== null]).toEqual([source, partTitle(source, 'p.md').mismatch])
  }
})

test('the warning sentence names both texts', () => {
  expect(titleConflictSentence({ title: 'New', heading: 'Old' })).toBe('The title says “New” and the heading says “Old”.')
})

const toHeading = (source: string, part = false) => withTitleFixed(source, 'p.md', 'title-to-heading', { part })
const toTitle = (source: string, part = false) => withTitleFixed(source, 'p.md', 'heading-to-title', { part })

test('use title as heading: levels 1 to 6 keep their marks, and nothing else moves', () => {
  for (let level = 1; level <= 6; level += 1) {
    const hashes = '#'.repeat(level)
    expect(toHeading(`${fm('New')}${hashes} Old\n\nBody ${hashes} stays.\n`)).toEqual({ ok: true, next: `${fm('New')}${hashes} New\n\nBody ${hashes} stays.\n` })
  }
})

test('use title as heading keeps the indent, closing hashes, an attribute block and footnote references', () => {
  expect(toHeading(`${fm('New')}  ## Old ##\n`)).toEqual({ ok: true, next: `${fm('New')}  ## New ##\n` })
  expect(toHeading(`${fm('New')}# Old {#intro .lead}\n`)).toEqual({ ok: true, next: `${fm('New')}# New {#intro .lead}\n` })
  expect(toHeading(`${fm('New')}# Old[^1] and more[^n2]\n\n[^1]: A.\n`)).toEqual({ ok: true, next: `${fm('New')}# New[^1][^n2]\n\n[^1]: A.\n` })
  expect(toHeading(`${fm('New')}# Old[^1] {#id}\n`)).toEqual({ ok: true, next: `${fm('New')}# New[^1] {#id}\n` })
})

test('use title as heading for a part rewrites its own # heading', () => {
  expect(toHeading(`${fm('New')}# Old\n\n## Section\n`, true)).toEqual({ ok: true, next: `${fm('New')}# New\n\n## Section\n` })
})

test('use title as heading on a setext heading rewrites the text line and keeps the underline', () => {
  expect(toHeading(`${fm('New')}Old\n=====\n\nBody.\n`)).toEqual({ ok: true, next: `${fm('New')}New\n=====\n\nBody.\n` })
  expect(toHeading(`${fm('New')}Old\n---\n`)).toEqual({ ok: true, next: `${fm('New')}New\n---\n` })
})

test('line endings: CRLF stays CRLF and a missing final newline stays missing', () => {
  const crlf = '---\r\ntitle: New\r\n---\r\n\r\n# Old\r\n\r\nBody\r\n'
  expect(toHeading(crlf)).toEqual({ ok: true, next: '---\r\ntitle: New\r\n---\r\n\r\n# New\r\n\r\nBody\r\n' })
  expect(toTitle(crlf)).toEqual({ ok: true, next: '---\r\ntitle: Old\r\n---\r\n\r\n# Old\r\n\r\nBody\r\n' })
  expect(toHeading(`${fm('New')}# Old`)).toEqual({ ok: true, next: `${fm('New')}# New` })
  expect(toTitle(`${fm('New')}# Old`)).toEqual({ ok: true, next: `${fm('Old')}# Old` })
})

test('use title as heading refuses what it cannot rewrite safely, and never guesses', () => {
  const refused = (result: ReturnType<typeof toHeading>): string | null => (result.ok ? null : result.message)
  expect(refused(toHeading(`${fm('New')}Old line\nand more\n===\n`))).toContain('more than one line')
  expect(refused(toHeading(`${fm('New')}# Old <span class="x">words</span>\n`))).toContain('HTML')
  expect(refused(toHeading(`${fm('"C #"')}# Old\n`))).toContain('would not read the same')
  expect(refused(toHeading(`${fm('Same')}# same\n`))).toBe('The title and the heading already match.')
})

test('use heading as title writes the heading’s plain text, quoted where YAML needs it', () => {
  expect(toTitle(`${fm('New')}# The **big** idea\n`)).toEqual({ ok: true, next: `${fm('The big idea')}# The **big** idea\n` })
  for (const heading of ['Cost: a view', 'He said "no"', 'It’s #1', '"Quoted"', '- dash first', 'Ends with space\\']) {
    const result = toTitle(`${fm('Other')}# ${heading}\n`)
    expect(result.ok).toBe(true)
    if (result.ok) expect([heading, parseFrontmatter(result.next)?.title]).toEqual([heading, heading])
  }
})

test('use heading as title keeps the other frontmatter lines and their order', () => {
  expect(toTitle('---\nstatus: draft\ntitle: New\ntags: [a, b]\n---\n\n# Old\n'))
    .toEqual({ ok: true, next: '---\nstatus: draft\ntitle: Old\ntags: [a, b]\n---\n\n# Old\n' })
})

test('use heading as title refuses a title written as a list', () => {
  for (const source of [`${fm('[A, B]')}# Old\n`, '---\ntitle:\n  - A\n---\n\n# Old\n']) {
    const result = toTitle(source)
    expect([source, result.ok]).toEqual([source, false])
  }
})

// Sol review round 1 (2026-10-19): the fixes' own scans are linear, the heading stays the same heading,
// only a one-line scalar `title:` is replaced, and closing `#`s before an attribute block are marks.

test('the fixes stay linear on adversarial headings and titles: 20k repetitions finish well under 100 ms', () => {
  const n = 20_000
  const headings = ['[^'.repeat(n), `a${' '.repeat(n)}b`, `a${' \t'.repeat(n)}## {#id}`, `${'[^'.repeat(n)} ${'#'.repeat(n)} {#a}`]
  const titles = ['New', '[^'.repeat(n), `x${' '.repeat(n)}#`]
  for (const heading of headings) {
    for (const title of titles) {
      const source = `---\ntitle: "${title}"\n---\n\n# Old ${heading}\n\nBody.\n`
      for (const part of [false, true]) {
        for (const direction of ['title-to-heading', 'heading-to-title'] as const) {
          // The best of three runs: a garbage collection or a busy machine (the full suite runs files side by side)
          // can stall one call; at 20k a quadratic scan is slow every time (the old regexes took 1.5 s at 32k).
          let took = Infinity
          for (let run = 0; run < 3 && took >= 100; run += 1) {
            const started = performance.now()
            withTitleFixed(source, 'p.md', direction, { part })
            took = Math.min(took, performance.now() - started)
          }
          expect([heading.slice(0, 4), title.slice(0, 4), part, direction, took < 100]).toEqual([heading.slice(0, 4), title.slice(0, 4), part, direction, true])
        }
      }
    }
  }
})

test('use title as heading keeps the heading a heading, or refuses: a title that would break it is never written', () => {
  const refused = (result: ReturnType<typeof toHeading>): boolean => !result.ok && result.message.includes('would no longer read as the same heading')
  const setext = (title: string) => toHeading(`${fm(title)}Old\n===\n\nBody.\n`)
  const atx = (title: string, part = false) => toHeading(`${fm(title)}# Old\n\nBody.\n`, part)
  // A setext text line that would open a fence, an HTML block, an ATX heading, a quote, a list or a rule.
  for (const title of ['"```"', '"``` js"', '"<div>"', '"# Hash"', '"> Quote"', '"- Dash"', '"1. Item"', '"---"', '"* * *"']) {
    expect([title, refused(setext(title))]).toEqual([title, true])
  }
  // An ATX heading whose new text would read as nothing (a fence's ticks, a tag, a rule's stars).
  for (const title of ['"```"', '"<div>"', '"* * *"']) {
    for (const part of [false, true]) expect([title, part, refused(atx(title, part))]).toEqual([title, part, true])
  }
  // Exact where the heading still reads as the title: these are written as they are.
  expect(atx('"# Hash"')).toEqual({ ok: true, next: `${fm('"# Hash"')}# # Hash\n\nBody.\n` })
  expect(atx('"> Quote"', true)).toEqual({ ok: true, next: `${fm('"> Quote"')}# > Quote\n\nBody.\n` })
  expect(atx('"- Dash"')).toEqual({ ok: true, next: `${fm('"- Dash"')}# - Dash\n\nBody.\n` })
  expect(atx('"= Eq"')).toEqual({ ok: true, next: `${fm('"= Eq"')}# = Eq\n\nBody.\n` })
  expect(atx('"``` js"')).toEqual({ ok: true, next: `${fm('"``` js"')}# \`\`\` js\n\nBody.\n` })
  expect(atx('"a <b"')).toEqual({ ok: true, next: `${fm('"a <b"')}# a <b\n\nBody.\n` })
  expect(atx('"Ends\\\\"')).toEqual({ ok: true, next: `${fm('"Ends\\\\"')}# Ends\\\n\nBody.\n` })
  expect(setext('"= Eq"')).toEqual({ ok: true, next: `${fm('"= Eq"')}= Eq\n===\n\nBody.\n` })
  expect(setext('"Ends\\\\"')).toEqual({ ok: true, next: `${fm('"Ends\\\\"')}Ends\\\n===\n\nBody.\n` })
})

test('use heading as title refuses a title that is not a plain or quoted one-line scalar', () => {
  const values = [
    'title: &t [A, B]', 'title: &t New', 'title: !x New', 'title: !!str New', 'title: *a', 'title: [A, B]', 'title: {a: b}',
    'title: |\n  New', 'title: >\n  New', 'title: &t |\n  New', 'title: |-\n  New', 'title: New\n  more', 'title: "New\n  more"', 'title: - A',
  ]
  for (const value of values) {
    const source = `---\n${value}\nstatus: draft\n---\n\n# Old\n`
    const result = toTitle(source)
    expect([value, result.ok ? null : result.message]).toEqual([value, 'The title is written as a list or a block, so WriteFlex will not change it. Change it in the file.'])
  }
  // A quoted or plain value on its own line is replaced, the line after it kept.
  for (const value of ["title: 'It''s'", 'title: "Say \\"no\\""', 'title: -New', 'title: New']) {
    expect([value, toTitle(`---\n${value}\nstatus: draft\n---\n\n# Old\n`)]).toEqual([value, { ok: true, next: '---\ntitle: Old\nstatus: draft\n---\n\n# Old\n' }])
  }
})

test('closing hashes before an attribute block are marks: the conflict reads past them and both fixes keep them', () => {
  for (const part of [false, true]) {
    expect([part, titleConflict(`${fm('Old')}# Old ## {#id}\n`, 'p.md', { part })]).toEqual([part, null])
    expect([part, titleConflict(`${fm('New')}# Old ## {#id}\n`, 'p.md', { part })]).toEqual([part, { title: 'New', heading: 'Old' }])
    expect([part, toHeading(`${fm('New')}# Old ## {#id}\n\nBody.\n`, part)]).toEqual([part, { ok: true, next: `${fm('New')}# New ## {#id}\n\nBody.\n` }])
    expect([part, toTitle(`${fm('New')}# Old ## {#id}\n\nBody.\n`, part)]).toEqual([part, { ok: true, next: `${fm('Old')}# Old ## {#id}\n\nBody.\n` }])
  }
  expect(toHeading(`${fm('New')}## Old #\t{.lead}\n`)).toEqual({ ok: true, next: `${fm('New')}## New #\t{.lead}\n` })
})

test('the scalar check reads every line below the key: a comment-only value or a continuation past blank lines refuses', () => {
  const LIST = 'The title is written as a list or a block, so WriteFlex will not change it. Change it in the file.'
  // Sol round 2: a comment-only value with a nested block after a blank line, and a plain value continued past a blank line.
  for (const block of [
    'title: # comment\n\n  nested: value\n',
    'title: New\n\n  more\n',
    'title:   # just a comment\nstatus: draft\n',
    'title: New\n# a comment\n  more\n',
    'title: New\n\n\n- item\n',
  ]) {
    expect([block, toTitle(`---\n${block}---\n\n# Old\n`)]).toEqual([block, { ok: false, message: LIST }])
  }
  // The scan stops at the next top-level key: an indented line under another key is that key's own.
  const nested = '---\ntitle: New\n\n# a comment\nauthor:\n  name: D\n---\n\n# Old\n'
  const fixed = toTitle(nested)
  expect(fixed).toEqual({ ok: true, next: '---\ntitle: Old\n\n# a comment\nauthor:\n  name: D\n---\n\n# Old\n' })
  // The frontmatter reader reads the result as it read the original, with only the title changed.
  if (fixed.ok) expect(parseFrontmatter(fixed.next)).toEqual({ ...parseFrontmatter(nested), title: 'Old' })
})

test('closing hashes are dropped a second time only after an attribute block: `# Old ##[^1]` reads “Old ##”', () => {
  expect(headingPlainText('Old ##[^1]')).toBe('Old ##')
  expect(headingPlainText('Old ## {#id}')).toBe('Old')
  expect(headingPlainText('Old ##')).toBe('Old')
  for (const part of [false, true]) {
    expect([part, titleConflict(`${fm('Old')}# Old ##[^1]\n`, 'p.md', { part })]).toEqual([part, { title: 'Old', heading: 'Old ##' }])
    // Use title as heading keeps the footnote; the literal `##` goes with the old words.
    expect([part, toHeading(`${fm('New')}# Old ##[^1]\n`, part)]).toEqual([part, { ok: true, next: `${fm('New')}# New[^1]\n` }])
  }
})

// Sol review round 3 (2026-10-19): the second drop of closing `#`s is decided on the raw heading text, before
// footnotes and comments are stripped; a footnote between the hashes and the attribute block keeps them literal.
test('closing hashes followed by a footnote and an attribute block stay literal: `# Old ##[^1] {#id}` reads “Old ##”', () => {
  expect(headingPlainText('Old ##[^1] {#id}')).toBe('Old ##')
  expect(headingPlainText('Old ## {#id}')).toBe('Old')
  expect(headingPlainText('Old ##')).toBe('Old')
  expect(headingPlainText('Old ##[^1]')).toBe('Old ##')
  for (const part of [false, true]) {
    expect([part, titleConflict(`${fm('Old')}# Old ##[^1] {#id}\n`, 'p.md', { part })]).toEqual([part, { title: 'Old', heading: 'Old ##' }])
    expect([part, titleConflict(`${fm('Old')}# Old ## {#id}\n`, 'p.md', { part })]).toEqual([part, null])
    expect([part, titleConflict(`${fm('Old')}# Old ##\n`, 'p.md', { part })]).toEqual([part, null])
    expect([part, titleConflict(`${fm('Old')}# Old ##[^1]\n`, 'p.md', { part })]).toEqual([part, { title: 'Old', heading: 'Old ##' }])
  }
})

// Top-of-body rule (Dominik 2026-10-21): "the title=heading should only work for when the heading is the first
// line in the doc - and when there's no heading there, it should insert the title as # at the very top".
const TITLE = 'How (not) to learn about AI with metaphors: a field guide'
const TLDR_HEAD = `---\ntitle: ${TITLE}\n---\n\n`
const TLDR_BODY = 'People reach for metaphors first.\n\nSome of them help.\n\n## TLDR;\n\nMetaphors are tools, not truths.\n\n## More\n\nAnd the rest.\n'
const TLDR = TLDR_HEAD + TLDR_BODY

test('a document whose first heading comes after paragraphs: no conflict, no heading to use, the title is inserted at the top', () => {
  for (const part of [false, true]) {
    expect(titleConflict(TLDR, 'essays/metaphors.md', { part })).toBeNull()
    expect(withTitleFixed(TLDR, 'essays/metaphors.md', 'heading-to-title', { part })).toEqual({ ok: false, message: 'This document does not start with a heading, so there is no heading to use as its title.' })
  }
  expect(titleHeadingInsertable(TLDR, 'essays/metaphors.md', { part: false })).toBe(true)
  const fixed = withTitleFixed(TLDR, 'essays/metaphors.md', 'title-to-heading', { part: false })
  // `# Title` and a blank line at the top of the body; `## TLDR;` and every other byte unchanged.
  expect(fixed).toEqual({ ok: true, next: `${TLDR_HEAD}# ${TITLE}\n\n${TLDR_BODY}` })
  if (fixed.ok) expect(titleConflict(fixed.next, 'essays/metaphors.md', { part: false })).toBeNull()
  // A Folio part is never given its heading here: its "Add the heading" change does that.
  expect(titleHeadingInsertable(TLDR, 'essays/metaphors.md', { part: true })).toBe(false)
  expect(withTitleFixed(TLDR, 'essays/metaphors.md', 'title-to-heading', { part: true })).toEqual({ ok: false, message: PART_HEADING_IS_A_CHANGE })
})

test('a top heading that differs: the conflict, and the fix touches only the body’s first line', () => {
  const body = 'Text.\n\n## TLDR;\n\nMore.\n'
  const source = `${fm('New')}## Old\n\n${body}`
  expect(titleConflict(source, 'p.md', { part: false })).toEqual({ title: 'New', heading: 'Old' })
  expect(titleHeadingInsertable(source, 'p.md', { part: false })).toBe(false)
  expect(toHeading(source)).toEqual({ ok: true, next: `${fm('New')}## New\n\n${body}` })
  expect(toTitle(source)).toEqual({ ok: true, next: `---\ntitle: Old\n---\n\n## Old\n\n${body}` })
  // Blank lines before the top heading still count as top.
  const spaced = `${fm('New')}\n\n# Old\n\n${body}`
  expect(toHeading(spaced)).toEqual({ ok: true, next: `${fm('New')}\n\n# New\n\n${body}` })
})

test('a document that opens with a list or a paragraph and has no heading at all: the title goes in at the top', () => {
  for (const body of ['- one\n- two\n', 'Just words.\n', '1. first\n2. second\n\nAfter.\n']) {
    const source = `${fm('New')}${body}`
    expect(titleConflict(source, 'p.md', { part: false })).toBeNull()
    expect(toTitle(source).ok).toBe(false)
    expect(toHeading(source)).toEqual({ ok: true, next: `${fm('New')}# New\n\n${body}` })
  }
  // Frontmatter running straight into the text: a blank line goes before the heading too, nothing else moves.
  expect(toHeading('---\ntitle: New\n---\nWords.\n')).toEqual({ ok: true, next: '---\ntitle: New\n---\n\n# New\n\nWords.\n' })
  // CRLF keeps its line ends.
  expect(toHeading('---\r\ntitle: New\r\n---\r\n\r\nWords.\r\n')).toEqual({ ok: true, next: '---\r\ntitle: New\r\n---\r\n\r\n# New\r\n\r\nWords.\r\n' })
})

test('nothing is inserted without a title, with heading: none, or when the top heading already says the title', () => {
  for (const source of ['Words.\n\n# Later\n', `${fm('New', 'heading: none\n')}Words.\n`, `${fm('New')}# New\n\nWords.\n`]) {
    expect([source, titleHeadingInsertable(source, 'p.md', { part: false })]).toEqual([source, false])
    expect([source, toHeading(source).ok]).toEqual([source, false])
  }
})
