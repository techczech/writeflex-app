import { expect, test } from 'bun:test'
// jszip is the zip library `docx` itself packs with; reading the package back is the honest check.
import JSZip from 'jszip'
import { toDocx } from '../../src/shared/markdown/to-docx'

async function documentXml(markdown: string): Promise<string> {
  const { buffer } = await toDocx(markdown)
  const zip = await JSZip.loadAsync(buffer)
  return zip.file('word/document.xml')!.async('string')
}

function paragraphs(xml: string): string[] {
  return xml.match(/<w:p>.*?<\/w:p>|<w:p [^>]*>.*?<\/w:p>/gs) ?? []
}

test('Word shows a real box for each task item, ticked or not, in place of the bullet', async () => {
  const xml = await documentXml('- [ ] Add the restaurant script example\n- [x] Move the schema definition up\n- plain\n')
  const [open, done, plain] = paragraphs(xml)
  expect(open).toContain('☐')
  expect(open).toContain('Add the restaurant script example')
  expect(done).toContain('☑')
  // The box stands where the dot was: no bullet numbering, the bullet's own indent, a tab to the words.
  for (const item of [open, done]) {
    expect(item).not.toContain('<w:numPr>')
    expect(item).toMatch(/<w:ind w:left="720" w:hanging="360"\/>/)
    expect(item).toContain('<w:tab/>')
  }
  expect(plain).toContain('<w:numPr>')
  expect(plain).not.toMatch(/[☐☑]/)
})

test('a nested task item indents one bullet level further; a numbered task item keeps its number', async () => {
  const xml = await documentXml('- [ ] parent\n  - [x] child\n\n1. [ ] numbered\n')
  const [parent, child, numbered] = paragraphs(xml)
  expect(parent).toMatch(/w:left="720"/)
  expect(child).toMatch(/<w:ind w:left="1440" w:hanging="360"\/>/)
  expect(child).toContain('☑')
  expect(numbered).toContain('<w:numPr>')
  expect(numbered).toContain('☐ ')
})
