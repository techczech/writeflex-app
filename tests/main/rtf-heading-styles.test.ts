import { test, expect } from 'bun:test'
import { toRtf } from '../../src/shared/markdown/to-rtf'

// The QA report's ask: headings should survive a paste as WORD HEADING STYLES, not merely as bold
// text at the right size. That is what gives the user the navigation pane, a working table of
// contents, and a document someone else can restyle. RTF says it with a `{\stylesheet}` whose
// entries are NAMED `heading 1`…`heading 6` (Word's own built-in names) and paragraphs tagged with
// `\sN`. The visual sizing stays on the paragraph as direct formatting, so a reader that ignores
// the stylesheet still shows the hierarchy — the fallback, not the mechanism.
//
// VERIFIED OUTSIDE THIS FILE (2026-07-25): the emitted RTF read by a real RTF reader (LibreOffice
// → .docx) produces `w:pStyle w:val="Heading1"`, `Heading2`, `Heading3` on the headings and
// `Normal` on the prose. `textutil` is NOT the gate for this — AppKit has no named paragraph styles,
// so it flattens every heading to bold-at-a-size, which is also why it drops a `\pict`. The Word
// EXPORT path already wrote real heading styles (the `docx` library's HeadingLevel); this is the
// PASTE path catching up with it.

const DOC = [
  '# One', '', 'Body prose.', '',
  '## Two', '', '### Three', '', '#### Four', '', '##### Five', '', '###### Six', '',
].join('\n')

test('the RTF declares Word’s own heading styles, by their built-in names', () => {
  const rtf = toRtf(DOC)
  expect(rtf).toContain('{\\stylesheet')
  for (let level = 1; level <= 6; level += 1) expect(rtf).toContain(`heading ${level};`)
  // Normal must be there too, or a reader has nothing for the styles to be based on.
  expect(rtf).toContain('Normal;')
  // The stylesheet sits in the header, before any prose.
  expect(rtf.indexOf('{\\stylesheet')).toBeLessThan(rtf.indexOf('Body prose'))
})

test('every heading paragraph is TAGGED with its style and its outline level', () => {
  const rtf = toRtf(DOC)
  for (let level = 1; level <= 6; level += 1) {
    expect(rtf).toContain(`\\s${level}\\`)
    expect(rtf).toContain(`\\outlinelevel${level - 1}`)
  }
})

test('body prose carries no heading style — only the headings are headings', () => {
  const paragraphs = toRtf('Just prose.\n').split('\\par')
  const body = paragraphs.find((line) => line.includes('Just prose.')) ?? ''
  expect(body).not.toMatch(/\\s[1-6]\b/)
  expect(body).not.toContain('\\outlinelevel')
})

test('the current visual sizing is kept as the fallback formatting', () => {
  const rtf = toRtf('# One\n')
  // 18pt in half-points, exactly as before the styles existed.
  expect(rtf).toContain('\\fs36')
  expect(rtf).toContain('\\b\\fs36')
})

test('a heading’s own inline formatting still travels', () => {
  expect(toRtf('## A **bold** word\n')).toContain('{\\b bold}')
})
