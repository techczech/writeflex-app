import { expect, test } from 'bun:test'
// jszip is the zip library `docx` itself packs with; reading the package back is the honest check.
import JSZip from 'jszip'
import { toDocx } from '../../src/shared/markdown/to-docx'
import { toHtml as renderHtml } from '../../src/shared/markdown/to-html'

const toHtml = (markdown: string): string => renderHtml(markdown).html
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toRtf } from '../../src/shared/markdown/to-rtf'

/**
 * Lettered and roman lists keep their letters in every export (the locked export frame,
 * docs/design/2026-09-27-checkbox-lists/mockup/hifi-direction-1.html): HTML says `<ol type="a">`,
 * Word numbers the list in its own lowerLetter / lowerRoman format.
 */

const SOURCE = 'a. The pupil who decoded perfectly\nb. The pupil who understood\n   i. because nobody asked\n   ii. because the answer had no words yet\n'

test('HTML: <ol type="a|A|i|I">, with the matching list-style-type and a start where it is not 1', () => {
  const html = toHtml(SOURCE)
  expect(html).toMatch(/<ol type="a" style="[^"]*list-style-type:lower-alpha;[^"]*">/)
  expect(html).toMatch(/<ol type="i" style="[^"]*list-style-type:lower-roman;[^"]*">/)
  expect(toHtml('C)  third\nD)  fourth\n')).toMatch(/<ol type="A" start="3" style="[^"]*list-style-type:upper-alpha;/)
  expect(toHtml('I.  One\nII.  Two\n')).toMatch(/<ol type="I" style=/)
  // Numbered lists are untouched.
  expect(toHtml('1. one\n2. two\n')).toMatch(/<ol style="[^"]*">/)
  expect(toHtml('1. one\n2. two\n')).not.toContain('type=')
})

async function wordParts(markdown: string): Promise<{ document: string; numbering: string }> {
  const { buffer } = await toDocx(markdown)
  const zip = await JSZip.loadAsync(buffer)
  return {
    document: await zip.file('word/document.xml')!.async('string'),
    numbering: await zip.file('word/numbering.xml')!.async('string'),
  }
}

/** The numFmt and lvlText Word will number each numbered paragraph with, in document order. */
async function wordNumbering(markdown: string): Promise<string[]> {
  const { document, numbering } = await wordParts(markdown)
  const abstractOf = new Map([...numbering.matchAll(/<w:num w:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)"\/>/g)].map((m) => [m[1], m[2]]))
  const firstLevel = new Map([...numbering.matchAll(/<w:abstractNum [^>]*w:abstractNumId="(\d+)"[^>]*>(.*?)<\/w:abstractNum>/gs)].map((m) => {
    const levels = [...m[2].matchAll(/<w:lvl w:ilvl="(\d+)"[^>]*>(.*?)<\/w:lvl>/gs)].map((l) => {
      const format = /<w:numFmt w:val="([^"]+)"/.exec(l[2])?.[1]
      const text = /<w:lvlText w:val="([^"]+)"/.exec(l[2])?.[1]
      return `${format} ${text}`
    })
    return [m[1], levels]
  }))
  return [...document.matchAll(/<w:numPr><w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>/g)].map((m) => {
    const levels = firstLevel.get(abstractOf.get(m[2]) ?? '') ?? []
    return levels[Number(m[1])] ?? '?'
  })
}

test('Word: each item is numbered in the matching format, nested lists in theirs', async () => {
  expect(await wordNumbering(SOURCE)).toEqual(['lowerLetter %1.', 'lowerLetter %1.', 'lowerRoman %2.', 'lowerRoman %2.'])
  expect(await wordNumbering('A)  one\nB)  two\n')).toEqual(['upperLetter %1)', 'upperLetter %1)'])
  expect(await wordNumbering('I.  One\n')).toEqual(['upperRoman %1.'])
  expect(await wordNumbering('1. one\n')).toEqual(['decimal %1.'])
})

test('Word: a lettered list that starts past a says where it continues from, in letters', async () => {
  const { document } = await wordParts('c. third\nd. fourth\n')
  expect(document).toContain('(continuing from c)')
})

test('plain text and RTF write the letters too', () => {
  expect(toPlain(SOURCE)).toContain('a. The pupil who decoded perfectly')
  expect(toPlain(SOURCE)).toContain('  ii. because the answer had no words yet')
  expect(toPlain('A)  one\nB)  two\n')).toContain('B) two')
  expect(toRtf(SOURCE)).toContain('b.\\tab ')
})
