/**
 * Ticket 07 of Folio versions: the read-only view as drawn (render seam: the version already read). The keys, the real window and the
 * disk are the Electron end-to-end tests'. Here: what is on screen has nothing that can be typed into, dragged or removed, and the
 * banner says what it must.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReaderBanner, ReaderBinder, ReaderBody, firstTarget, type ReadingLoad } from '../../src/renderer/src/components/FolioVersionReader'
import type { FolioVersionReading, ReadingVersion } from '../../src/shared/folio-versions-view'

const VERSION: ReadingVersion = { id: 'fv_1', name: 'Draft for Sam Rowe', ts: Date.UTC(2026, 9, 15, 15, 30), author: 'Dominik Lukes' }
const READING: FolioVersionReading = {
  contents: {
    id: 'fv_1', name: VERSION.name, ts: VERSION.ts, author: VERSION.author, indexPath: 'f/_f_INDEX.md', indexWords: 12,
    parts: [
      { path: 'f/a.md', title: 'Alpha', order: 1, words: 30 },
      { path: 'f/b.md', title: 'Beta', order: 2, words: 40 },
      { path: 'f/gone.md', title: 'Gone since', order: 3, words: null },
    ],
    unlisted: [{ path: 'f/limitations.md', title: 'limitations', words: 9 }], inserted: [], references: [], words: 70,
  },
  index: '# Folio\n\nIndex text.\n',
  texts: { 'f/a.md': '---\ntitle: Alpha\n---\n\n# Alpha\n\nThe first <script>alert(1)</script> paragraph, with **bold**.\n', 'f/b.md': '# Beta\n\nSecond part.\n', 'f/gone.md': null, 'f/limitations.md': '# Limitations\n\nText.\n' },
}
const LOAD: ReadingLoad = { state: 'ready', value: READING }
const CANNOT_WRITE = /<input|<textarea|<select|contenteditable|draggable|cm-editor|<form/

describe('the banner', () => {
  test('names the version, says read-only, offers Back, and holds Export, Compare and Restore off with their reasons', () => {
    const html = renderToStaticMarkup(<ReaderBanner version={VERSION} onBack={() => {}} />)
    expect(html).toContain('Reading <b data-testid="reading-name">Draft for Sam Rowe</b>')
    expect(html).toContain('read-only. Nothing here can be edited.')
    expect(html).toContain('Back to ')
    expect(html).toContain('data-testid="reading-back"')
    for (const id of ['export', 'compare', 'restore']) expect(html).toMatch(new RegExp(`data-reader-action="${id}"[^>]*aria-disabled="true"[^>]*title="[^"]*not built yet\\.`))
    expect(html).not.toMatch(CANNOT_WRITE)
  })
})

describe('what is drawn has nothing to type into, drag or remove', () => {
  for (const tab of ['outline', 'text', 'cards'] as const) {
    test(`the ${tab} tab`, () => {
      const html = renderToStaticMarkup(<ReaderBody load={LOAD} tab={tab} selected={{ kind: 'part', path: 'f/a.md' }} onSelect={() => {}} onOpenText={() => {}} />)
      expect(html).not.toMatch(CANNOT_WRITE)
      expect(html).toContain('Alpha')
      // A part whose saved text is gone says so; it does not read the working file.
      expect(html).toContain(tab === 'text' ? 'The first' : 'Saved text not found')
    })
  }

  test('the text is the saved text without its front matter, and raw HTML in it is shown as text, never run', () => {
    const html = renderToStaticMarkup(<ReaderBody load={LOAD} tab="text" selected={{ kind: 'part', path: 'f/a.md' }} onSelect={() => {}} onOpenText={() => {}} />)
    expect(html).not.toContain('title: Alpha')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('aria-readonly="true"')
    expect(html).toContain('<strong>bold</strong>')
  })

  test('the Binder lists the Index Note and the version\'s parts, with a lock for each and none of the working Binder\'s controls', () => {
    const html = renderToStaticMarkup(<ReaderBinder load={LOAD} version={VERSION} selected={{ kind: 'part', path: 'f/b.md' }} onSelect={() => {}} />)
    expect(html).toContain('Index Note')
    for (const title of ['Alpha', 'Beta', 'Gone since']) expect(html).toContain(title)
    expect(html).toContain('3 parts · read-only')
    expect(html).toMatch(/aria-selected="true"[^>]*data-reader-target="f\/b.md"/)
    expect(html).not.toMatch(CANNOT_WRITE)
    expect(html).not.toMatch(/Add to outline|Remove|Rename|fr-bplus/)
    expect(html).toContain('Not in the outline')
  })

  test('a version with an Index Note only: no parts, the Index Note is the text', () => {
    const only: ReadingLoad = { state: 'ready', value: { ...READING, contents: { ...READING.contents, parts: [], unlisted: [] }, texts: {} } }
    expect(firstTarget(only.state === 'ready' ? only.value : READING, null)).toEqual({ kind: 'index' })
    const html = renderToStaticMarkup(<ReaderBody load={only} tab="text" selected={{ kind: 'index' }} onSelect={() => {}} onOpenText={() => {}} />)
    expect(html).toContain('Index text.')
    const outline = renderToStaticMarkup(<ReaderBody load={only} tab="outline" selected={{ kind: 'index' }} onSelect={() => {}} onOpenText={() => {}} />)
    expect(outline).toContain('This version has no parts.')
  })

  test('it opens on the part the writer had chosen in the working draft, by file then by title, else the first', () => {
    expect(firstTarget(READING, { path: 'f/b.md', title: 'Renamed since' })).toEqual({ kind: 'part', path: 'f/b.md' })
    expect(firstTarget(READING, { path: 'f/moved.md', title: 'Beta' })).toEqual({ kind: 'part', path: 'f/b.md' })
    expect(firstTarget(READING, { path: null, title: 'Not there' })).toEqual({ kind: 'part', path: 'f/a.md' })
    expect(firstTarget(READING, null)).toEqual({ kind: 'part', path: 'f/a.md' })
  })

  test('loading and unreadable states are drawn, and offer nothing to change', () => {
    expect(renderToStaticMarkup(<ReaderBody load={{ state: 'loading' }} tab="text" selected={{ kind: 'index' }} onSelect={() => {}} onOpenText={() => {}} />)).toContain('aria-busy="true"')
    const unreadable = renderToStaticMarkup(<ReaderBody load={{ state: 'unreadable' }} tab="text" selected={{ kind: 'index' }} onSelect={() => {}} onOpenText={() => {}} />)
    expect(unreadable).toContain('This version could not be read.')
    expect(unreadable).not.toMatch(CANNOT_WRITE)
  })
})
