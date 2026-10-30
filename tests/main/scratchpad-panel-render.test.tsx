import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScratchpadPanel } from '../../src/renderer/src/components/scratchpad/ScratchpadPanel'
import { ItemActions, PlacementNote, ScratchpadCompare, ScratchpadPreview } from '../../src/renderer/src/components/scratchpad/ScratchpadParts'
import type { ScratchpadLayoutApi } from '../../src/renderer/src/scratchpad/useScratchpadLayout'
import type { ScratchItem, ScratchSnapshot } from '../../src/shared/scratchpad-items'
import type { ScratchMode } from '../../src/shared/scratchpad-layout'

// The rendered Scratchpad (ticket 01): formatted text cards (not plain tiles), the three lists, origin
// wording that never invents a cut, Put back only on recorded cuts, the Rendered / Markdown preview, the
// pill, and fragments that cannot run script or open javascript: links.

const SECTION = '## Review rounds\n\nEach round had a **different job**:\n\n1. *Meaning*\n   - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
const item = (over: Partial<ScratchItem>): ScratchItem => ({
  id: 'p_aaaaaa01', source: 'lossless', kind: 'text', how: 'copy', by: 'writer', createdAt: new Date().toISOString(),
  origin: { path: 'book/part-3.md', heading: 'Findings' }, title: 'Review rounds', markdown: SECTION, group: null, status: 'active',
  done: false, uses: [], ...over,
})
const layout = (mode: ScratchMode): ScratchpadLayoutApi => ({
  layout: { mode, restore: 'float', box: { x: 20, y: 60, w: 700, h: 600 } },
  toggle: () => {}, expand: () => {}, collapse: () => {}, dock: () => {}, float: () => {}, setBox: () => {},
})
const handlers = { insert: () => {}, setStatus: async () => true, setGroup: async () => true, createGroup: async () => null, toggleDone: () => {}, setColour: () => {}, deleteForever: async () => true, say: () => {} }
const itemHandlers = { insert: () => {}, toggleDone: () => {}, setColour: () => {}, reject: () => {}, moveBack: () => {}, openMove: () => {} }

const snapshot = (items: ScratchItem[]): ScratchSnapshot => ({ items, groups: [{ id: 'g_refs01', name: 'References' }], notices: [], folioDir: 'book' })
const render = (items: ScratchItem[], mode: ScratchMode = 'float'): string => renderToStaticMarkup(
  <ScratchpadPanel layout={layout(mode)} snapshot={snapshot(items)} loadError={null} activePath="book/part-2.md" assetBaseUrl="wf-asset://t" placement={{ part: 'part-2', after: 'Sample size sketch' }} focusTick={0} handlers={handlers} docked={false} />,
)

describe('the panel', () => {
  test('text cards draw the fragment formatted, with origin wording per capture kind, across the Folio\'s parts', () => {
    const html = render([
      item({ id: 'p_cut00001', how: 'cut', origin: { path: 'book/part-1.md', heading: null } }),
      item({ id: 'p_copy0001' }),
      item({ id: 'legacy:book/part-3.md#s_old', source: 'legacy', how: null, createdAt: null, markdown: 'Old scrap text.', title: 'Old scrap text.', expandTrigger: 'sig', done: true }),
    ])
    expect(html).toContain('Cut from part-1')
    expect(html).toContain('Copied from part-3')
    expect(html).toContain('Saved scrap · part-3')
    expect(html).toContain('<strong>different job</strong>')
    expect(html).toMatch(/<h2[^>]*>Review rounds<\/h2>/)
    expect(html).toContain('<table')
    expect(html).toContain('<li')
    expect(html).toContain('expandable')
    expect(html).toContain('>done<')
    expect(html).toContain('Candidates <span>3</span>')
    expect(html).toContain('Folio: book')
    expect(html).toContain('Added today')
    expect(html).toContain('From part-3.md')
  })

  test('rejected and put-back items leave Candidates; put-back items in this part are under In this document', () => {
    const html = render([
      item({ id: 'p_rej00001', status: 'rejected' }),
      item({ id: 'p_put00001', how: 'cut', uses: [{ useId: 'u_x00001', path: 'book/part-2.md', mode: 'put-back', at: '' }] }),
      item({ id: 'p_live0001' }),
    ])
    expect(html).toContain('Candidates <span>1</span>')
    expect(html).toContain('In this document <span>1</span>')
    expect(html).toContain('Rejected <span>1</span>')
  })

  test('collapsed, it is the pill with its count', () => {
    expect(render([item({})], 'collapsed')).toContain('Scratchpad · 1')
  })

  test('with nothing set aside, it says how to set text aside', () => {
    expect(render([])).toContain('Nothing set aside yet')
  })
})

describe('actions, preview and placement', () => {
  test('Put back is offered only for a recorded cut; Insert a copy for every item', () => {
    const cut = renderToStaticMarkup(<ItemActions item={item({ how: 'cut' })} handlers={itemHandlers} canInsert />)
    const copy = renderToStaticMarkup(<ItemActions item={item({ how: 'copy' })} handlers={itemHandlers} canInsert />)
    const legacy = renderToStaticMarkup(<ItemActions item={item({ id: 'legacy:a.md#s_x', source: 'legacy', how: null })} handlers={itemHandlers} canInsert />)
    expect(cut).toContain('Put back')
    expect(cut).toContain('Insert a copy')
    expect(copy).not.toContain('Put back')
    expect(legacy).not.toContain('Put back')
    expect(legacy).toContain('Insert a copy')
  })

  test('the big preview draws the whole fragment and offers the Markdown view', () => {
    const html = renderToStaticMarkup(<ScratchpadPreview item={item({})} partName={(p) => p} assetBaseUrl={null} handlers={itemHandlers} placement={null} onBack={() => {}} />)
    expect(html).toContain('Back to the list')
    expect(html).toContain('>Rendered<')
    expect(html).toContain('>Markdown<')
    expect(html).toContain('<em>Meaning</em>')
    expect(html).toContain('§ Findings')
    expect(html).toContain('Click in the text to choose where this goes')
  })

  test('the placement note names the part and the block it follows', () => {
    expect(renderToStaticMarkup(<PlacementNote placement={{ part: 'How the review works', after: 'Sample size sketch' }} />)).toContain('Inserts in <b>How the review works</b>, after “Sample size sketch”')
  })

  test('a fragment cannot run script or carry a javascript: link into the panel', () => {
    const hostile = 'Hi <script>alert(1)</script> <img src=x onerror=alert(2)> [x](javascript:alert(3))'
    const html = render([item({ markdown: hostile, title: 'Hostile' })])
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/<img[^>]*onerror/)
    expect(html).not.toMatch(/href="javascript:/)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;') // shown as the words it is
  })
})

describe('local visual candidates', () => {
  test('typed previews show actual SVG, table and origin-based picture content', () => {
    const html = render([
      item({ id: 'p_picture1', kind: 'pic', markdown: '![Loop](assets/loop.png)' }),
      item({ id: 'p_svg00001', kind: 'svg', markdown: '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>\n```' }),
      item({ id: 'p_table001', kind: 'table', markdown: '| A | B |\n|---|---|\n| 1 | 2 |' }),
    ])
    expect(html).toContain('>Picture<')
    expect(html).toContain('>SVG<')
    expect(html).toContain('wf-asset://t/book/assets/loop.png')
    expect(html).toContain('<svg')
    expect(html).toContain('<table')
  })
  test('a widget big preview is sealed until Run is requested', () => {
    const html = renderToStaticMarkup(<ScratchpadPreview item={item({ kind: 'widget', markdown: '[Simulation: assets/demo.html]' })} partName={p => p} assetBaseUrl="wf-asset://t" handlers={itemHandlers} placement={null} onBack={() => {}} />)
    expect(html).toContain('Run widget')
    expect(html).not.toContain('<iframe')
  })
  test('a Reference offers the four distinct acts and never Insert a copy; a canonical source only Collect', () => {
    const ref = { sourceId: 'ref:zotero:library/ABCD1234', citationId: 'zotero:library/ABCD1234', evidenceKind: 'zotero' as const, target: 'zotero://select/library/items/ABCD1234', label: 'Lea and Street 1998', sourceTitle: 'Student Writing', attachedParts: ['Summary'] }
    const reference = renderToStaticMarkup(<ItemActions item={item({ kind: 'ref', ref, markdown: '[⟨Lea and Street 1998⟩](zotero://select/library/items/ABCD1234)' })} handlers={itemHandlers} canInsert />)
    expect(reference).toContain('Cite')
    expect(reference).toContain('Insert link')
    expect(reference).toContain('Attach to part…')
    expect(reference).not.toContain('Insert quote with citation')
    expect(reference).not.toContain('Insert a copy')
    const evidence = renderToStaticMarkup(<ItemActions item={item({ kind: 'evidence', ref: { ...ref, sourceId: 'ev:x#y', quote: 'Words.' } })} handlers={itemHandlers} canInsert />)
    expect(evidence).toContain('Insert quote with citation')
    const canonical = renderToStaticMarkup(<ItemActions item={item({ kind: 'ref', source: 'canonical', ref })} handlers={itemHandlers} canInsert />)
    expect(canonical).toContain('Collect to Scratchpad')
    expect(canonical).not.toContain('Cite')
    const card = render([item({ kind: 'ref', ref, markdown: '[⟨Lea and Street 1998⟩](zotero://select/library/items/ABCD1234)', title: 'Student Writing' })])
    expect(card).toContain('>Reference<')
    expect(card).toContain('Attached · 1')
    expect(card).toContain('References <span>1</span>')
    const cited = renderToStaticMarkup(<ScratchpadPreview item={item({ kind: 'ref', source: 'document', ref, cited: { count: 2, positions: [{ from: 0, to: 5, line: 3, markdown: 'x' }, { from: 9, to: 14, line: 7, markdown: 'x' }] }, document: { from: 0, to: 5, line: 3, basis: 'live' } })} partName={(p) => p} assetBaseUrl={null} handlers={itemHandlers} placement={null} onBack={() => {}} />)
    expect(cited).toContain('Cited 2×')
    expect(cited).toContain('Line 7 — Show in document')
  })

  test('ticket 04: compare draws mixed types side by side, each with its own typed actions and Take out', () => {
    const ref = { sourceId: 'ref:zotero:library/ABCD1234', citationId: 'zotero:library/ABCD1234', evidenceKind: 'zotero' as const, target: 'zotero://select/library/items/ABCD1234', label: 'Lea and Street 1998', sourceTitle: 'Student Writing' }
    const html = renderToStaticMarkup(
      <ScratchpadCompare
        items={[
          item({ id: 'p_cmptext1', how: 'cut' }),
          item({ id: 'p_cmpref01', kind: 'ref', ref, markdown: '[⟨Lea and Street 1998⟩](zotero://select/library/items/ABCD1234)', title: 'Student Writing' }),
          item({ id: 'p_cmpwid01', kind: 'widget', markdown: '[Simulation: assets/demo.html]', title: 'Demo widget' }),
          item({ id: 'p_cmptab01', kind: 'table', markdown: '| A | B |\n|---|---|\n| 1 | 2 |', title: 'Table one' }),
        ]}
        partName={(p) => p} assetBaseUrl={null} handlers={itemHandlers} placement={{ part: 'part-2', after: null }}
        onBack={() => {}} onTakeOut={() => {}}
      />,
    )
    expect(html).toContain('Compare side by side')
    expect(html).toContain('Back to the list')
    expect((html.match(/data-compare-item=/g) ?? []).length).toBe(4)
    expect((html.match(/Take out/g) ?? []).length).toBe(4)
    // Each type keeps its own actions: text inserts (and a cut puts back), a reference cites, a widget runs sealed.
    expect(html).toContain('Insert a copy')
    expect(html).toContain('Put back')
    expect(html).toContain('Cite')
    expect(html).toContain('Run widget')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('<table')
  })

  test('ticket 04: Delete forever appears only on a rejected item, beside Move back', () => {
    const withDelete = { ...itemHandlers, deleteForever: () => {} }
    const rejected = renderToStaticMarkup(<ItemActions item={item({ status: 'rejected' })} handlers={withDelete} canInsert />)
    expect(rejected).toContain('Move back')
    expect(rejected).toContain('Delete forever…')
    expect(rejected).not.toContain('Insert a copy')
    const active = renderToStaticMarkup(<ItemActions item={item({})} handlers={withDelete} canInsert />)
    expect(active).not.toContain('Delete forever')
    const noHandler = renderToStaticMarkup(<ItemActions item={item({ status: 'rejected' })} handlers={itemHandlers} canInsert />)
    expect(noHandler).not.toContain('Delete forever')
  })

  test('ticket 04: the placement note offers Change place only when places are given', () => {
    const bare = renderToStaticMarkup(<PlacementNote placement={{ part: 'P', after: null }} />)
    expect(bare).not.toContain('Change place')
    const withPlaces = renderToStaticMarkup(<PlacementNote placement={{ part: 'P', after: null }} places={[{ path: 'a.md', name: 'A' }]} activePath="a.md" onChangePlace={() => {}} />)
    expect(withPlaces).toContain('Change place')
  })

  test('a document asset offers navigation and collection, not mutation of its source', () => {
    const html = renderToStaticMarkup(<ItemActions item={item({ source: 'document', kind: 'pic', document: { from: 0, to: 5, line: 1, basis: 'live' } })} handlers={itemHandlers} canInsert={true} />)
    expect(html).toContain('Show in document')
    expect(html).toContain('Add to Scratchpad')
    expect(html).not.toContain('Reject')
    expect(html).not.toContain('Insert a copy')
  })
})
