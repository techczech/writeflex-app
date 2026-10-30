import { describe, expect, test } from 'bun:test'
import { documentAssets, documentAssetsProjected, assetStillCurrent } from '../../src/shared/scratchpad-inventory'

const picture = '![Loop](assets/loop.png)'
const svg = '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>\n```'
const table = '| A | B |\n|---|---|\n| 1 | 2 |'
const widget = '[Simulation: assets/demo.html]'

describe('parser-aware document assets', () => {
  test('exact payloads and positions come from the current unsaved source, excluding examples', () => {
    const source = ['# Draft', picture, svg, table, widget, '```md\n' + picture + '\n' + widget + '\n```', '    ' + picture, '`' + widget + '`', '> ' + widget].join('\n\n')
    const items = documentAssets('book/draft.md', source, 'live')
    expect(items.map(item => item.kind)).toEqual(['pic', 'svg', 'table', 'widget'])
    expect(items.map(item => item.markdown)).toEqual([picture, svg, table, widget])
    for (const item of items) {
      expect(source.slice(item.document!.from, item.document!.to)).toBe(item.markdown)
      expect(item.origin.path).toBe('book/draft.md')
      expect(item.document!.basis).toBe('live')
      expect(assetStillCurrent(item, source)).toBe(true)
    }
    expect(documentAssets('book/draft.md', '# Draft\n', 'live')).toEqual([])
    expect(assetStillCurrent(items[0], 'prefix\n' + source)).toBe(false)
  })
  test('fenced SVG only, exact CRLF, duplicate objects keep distinct positional identities', () => {
    const source = picture + '\r\n\r\n' + picture + '\r\n\r\n' + svg.replaceAll('\n', '\r\n')
    const items = documentAssets('draft.md', source, 'disk')
    expect(items).toHaveLength(3)
    expect(new Set(items.map(item => item.id)).size).toBe(3)
    expect(items[2].markdown).toContain('\r\n')
    expect(items[1].document!.line).toBe(3)
  })
  test('projected inventory: pending deletion before identical assets keeps raw ranges, lines and payloads', () => {
    const gone = 'OLDGONE\n\n'
    const raw = gone + picture + '\n\n' + picture + '\n'
    const removedSpans = [{ from: 0, to: gone.length }]
    const items = documentAssetsProjected('draft.md', raw, 'live', removedSpans)
    expect(items.map(item => item.markdown)).toEqual([picture, picture])
    expect(items[0].document).toMatchObject({ from: raw.indexOf(picture), to: raw.indexOf(picture) + picture.length, line: 3 })
    expect(items[1].document).toMatchObject({ from: raw.lastIndexOf(picture), to: raw.lastIndexOf(picture) + picture.length, line: 5 })
    expect(items[0].id).not.toBe(items[1].id)
    for (const item of items) {
      expect(raw.slice(item.document!.from, item.document!.to)).toBe(picture)
      expect(assetStillCurrent(item, { raw, removedSpans })).toBe(true)
    }
    // A stale range shifted by the removed span (the old clean-coordinate bug) must not validate.
    const shifted = { ...items[0], document: { ...items[0].document!, from: items[0].document!.from - gone.length, to: items[0].document!.to - gone.length } }
    expect(assetStillCurrent(shifted, { raw, removedSpans })).toBe(false)
  })
  test('projected inventory: pending replacement before an asset, and a pending-deleted asset is not current', () => {
    const raw = 'oldwordnewword\n\n' + picture + '\n'
    const items = documentAssetsProjected('draft.md', raw, 'live', [{ from: 0, to: 'oldword'.length }])
    expect(items).toHaveLength(1)
    expect(items[0].document!.from).toBe(raw.indexOf(picture))
    expect(assetStillCurrent(items[0], { raw, removedSpans: [{ from: 0, to: 7 }] })).toBe(true)
    const deletedRaw = picture + '\n\n' + table
    const kept = documentAssetsProjected('draft.md', deletedRaw, 'live', [{ from: 0, to: picture.length }])
    expect(kept.map(item => item.kind)).toEqual(['table'])
    expect(kept[0].document!.from).toBe(deletedRaw.indexOf(table))
    expect(kept[0].document!.line).toBe(3)
  })
  test('whole-line widgets use the existing embed rule and never collect arbitrary prose', () => {
    expect(documentAssets('d.md', 'See ' + widget + '\n\n[Embed: https://example.com]\n\n' + widget + ' words', 'live')).toEqual([])
  })
})
