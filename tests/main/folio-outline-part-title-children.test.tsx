// Folio Outline, 2026-10-18: a part's title is its row; no child row repeats it, on disk or from the open buffer.
// The next heading (### Section) is still listed. Seam: FolioOutlinePart over the shared title rule.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolioOutlinePart } from '../../src/renderer/src/components/FolioOutline'
import { partTitle } from '../../src/shared/folio-part-title'

const T = 'Kapitola 4. Idealizované kognitivní modely'
const PATH = 'p/a.md'
const FM = `---\ntitle: "${T}"\n---\n\n`

type Head = { level: number; text: string }

/** Headings of a source as the two feeds give them: disk (line) and buffer (from). */
function headingsOf(source: string): Head[] {
  return source.split('\n').flatMap((line) => {
    const m = /^(#{1,6}) (.+)$/.exec(line)
    return m ? [{ level: m[1].length, text: m[2] }] : []
  })
}

function render(source: string, open: boolean): string {
  const heads = headingsOf(source)
  const named = partTitle(source, PATH)
  const outline = {
    dir: 'p', name: 'p',
    pieces: [{ path: PATH, title: named.title, heading: named.mode, headings: heads.map((h, i) => ({ ...h, line: i * 2 + 1 })) }],
    also: [],
  }
  return renderToStaticMarkup(
    <FolioOutlinePart
      outline={outline as never}
      openPath={open ? PATH : 'p/other.md'}
      bufferPath={open ? PATH : null}
      bufferHeadings={open ? heads.map((h, i) => ({ level: h.level, from: i * 10, text: h.text })) : []}
      bufferText={open ? source : null}
      activeFrom={null}
      needle=""
      levelLimit={null}
      expanded={new Map([[`piece:0:${PATH}`, true]])}
      onToggle={() => {}}
      onOpenFile={() => {}}
      onJumpToFile={() => {}}
      onJumpOpen={() => {}}
      listRef={{ current: null }}
      onMovePiece={() => {}}
      onAdd={() => {}}
      busy={false}
      justAdded={[]}
      announcement=""
      touched={null}
      onFocusedRow={() => {}}
      onOpenPlan={() => {}}
    />,
  )
}

/** The text of every heading (child) row. */
const childRows = (html: string): string[] =>
  [...html.matchAll(/class="fo-row fo-hd"[^>]*?title="([^"]*)"/g)].map((m) => m[1])

const SOURCES: Array<[string, string, string]> = [
  ['## T under frontmatter title T', `${FM}## ${T}\n\nText.\n\n### Section\n`, T],
  ['# T then ## T', `${FM}# ${T}\n\n## ${T}\n\nText.\n\n### Section\n`, T],
  ['## T with a footnote reference, title "T"', `${FM}## ${T}[^1]\n\nText.\n\n### Section\n\n[^1]: Note.\n`, T],
]

for (const open of [false, true]) {
  for (const [name, source] of SOURCES) {
    test(`${name}, ${open ? 'open in the editor' : 'on disk'}: no child row repeats the title, ### Section is listed`, () => {
      const rows = childRows(render(source, open))
      expect(rows).toEqual(['Section'])
      expect(rows.some((row) => row.includes(T))).toBe(false)
    })
  }
}
