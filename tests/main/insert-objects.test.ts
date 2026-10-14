import { describe, expect, test } from 'bun:test'
import {
  buildCodeBlock,
  buildMarkmap,
  buildMermaid,
  buildSvg,
  buildTable,
  isSvgFile,
  isSvgText,
  nextFootnoteNumber,
} from '../../src/renderer/src/editor/insert-objects'

describe('insert object skeletons', () => {
  test('builds the locked 3 by 3 table skeleton', () => {
    expect(buildTable()).toBe('|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n|  |  |  |')
  })

  test('builds code, mermaid, markmap, and SVG fences ready to edit', () => {
    expect(buildCodeBlock()).toBe('```\n\n```')
    expect(buildMermaid()).toBe('```mermaid\nflowchart LR\n  A --> B\n```')
    expect(buildMarkmap()).toBe('```markmap\n- The River\n  - seasons\n    - birds\n```')
    expect(buildSvg()).toBe('```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">\n  <rect width="320" height="180" rx="12" fill="#f2f0ea"/>\n</svg>\n```')
  })

  test('recognises SVG documents and SVG clipboard files without treating other images as SVG', () => {
    expect(isSvgText('  <svg viewBox="0 0 1 1"><rect/></svg>  ')).toBe(true)
    expect(isSvgText('<svg><rect/></svg> trailing')).toBe(false)
    expect(isSvgText('<div><svg/></div>')).toBe(false)
    expect(isSvgFile({ name: 'drawing.svg', type: '' })).toBe(true)
    expect(isSvgFile({ name: 'drawing.SVG', type: 'application/octet-stream' })).toBe(true)
    expect(isSvgFile({ name: 'drawing.txt', type: 'image/svg+xml' })).toBe(true)
    expect(isSvgFile({ name: 'pixel.png', type: 'image/png' })).toBe(false)
  })

  test('uses the next unused numeric footnote', () => {
    expect(nextFootnoteNumber('No notes')).toBe(1)
    expect(nextFootnoteNumber('One[^1]\n\n[^1]: first\n[^3]: third')).toBe(2)
  })
})
