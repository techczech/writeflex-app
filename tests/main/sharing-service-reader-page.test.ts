// The reader page the sharing service serves: the locked read-only layout for a piece and for a
// Folio (docs/design/2026-10-14-sharing-reader-page/, frames read-only, folio, link-off), the
// "Updated" line, the "Made with WriteFlex" end line, and plain text kept plain.
import { describe, expect, test } from 'bun:test'
import { MADE_WITH_URL, formatUpdated, linkOffResponse, renderReaderPage } from '../../sharing-service/reader-page.ts'
import { parsePublishBody, type PublishBody } from '../../sharing-service/share-protocol.ts'

const SAVED_AT = Date.UTC(2026, 9, 14, 8, 12)

function body(overrides: Record<string, unknown> = {}): PublishBody {
  return parsePublishBody({
    revision: 1,
    savedAt: SAVED_AT,
    timeZone: 'Europe/London',
    sharedBy: 'Dominik',
    kind: 'piece',
    title: 'What a reading list is for',
    chips: [{ label: 'Date', value: '12 October 2026' }, { label: 'Status', value: 'draft' }, { label: 'Author', value: 'Dominik' }],
    parts: [{ html: '<p class="wf-paragraph">Most reading lists are written as if the reader will finish them.</p><h2 class="wf-heading" id="start">Start with a question</h2><p class="wf-paragraph">Last, a list should be revised.</p>' }],
    ...overrides,
  })
}

function folio(overrides: Record<string, unknown> = {}): PublishBody {
  return body({
    kind: 'folio',
    title: 'Teaching notes, autumn term',
    chips: [{ label: 'Author', value: 'Dominik' }, { label: 'Parts', value: '3' }],
    parts: [
      { title: 'What a reading list is for', html: '<p class="wf-paragraph">Part one text.</p><h2 class="wf-heading" id="p1-start">Start with a question</h2>', headings: [{ id: 'p1-start', text: 'Start with a question' }] },
      { title: 'Setting the first week', html: '<p class="wf-paragraph">Part two text.</p>' },
      { title: 'Marking without a rubric', html: '<p class="wf-paragraph">Part three, the last words.</p>' },
    ],
    ...overrides,
  })
}

const between = (html: string, start: string, end: string): string => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)) + end.length)

describe('a shared piece', () => {
  const html = renderReaderPage(body())

  test('has the reader bar: Shared by and Updated with date and time, and nothing about WriteFlex', () => {
    const bar = between(html, '<header class="rbar">', '</header>')
    expect(bar).toContain('<span class="by">Shared by Dominik</span>')
    expect(bar).toContain('Updated <time datetime="2026-10-14T08:12:00.000Z">14 October 2026, 09:12</time>')
    expect(bar).not.toMatch(/WriteFlex/i)
  })

  test('is the read-only layout: masthead with chips, the text, no notes column or notes switch', () => {
    expect(html).toContain('<div class="rp readonly">')
    expect(html).toContain('<header class="hero wf-masthead"><h1>What a reading list is for</h1><div class="meta-row"><span class="chip"><strong>Date</strong> · 12 October 2026</span>')
    expect(html).toContain('Most reading lists are written as if the reader will finish them.')
    expect(html).not.toMatch(/notes-col|viewswitch|Under the passage|class="sidebar"/)
    expect(html).toContain('<title>What a reading list is for</title>')
  })

  test('ends with a small, muted "Made with WriteFlex" line after the text, linking to writeflex.app with no logo', () => {
    expect(MADE_WITH_URL).toBe('https://writeflex.app')
    const article = between(html, '<article class="content">', '</article>')
    expect(article.endsWith('<footer class="made-with"><a href="https://writeflex.app" rel="noopener noreferrer" referrerpolicy="no-referrer">Made with WriteFlex</a></footer></article>')).toBe(true)
    expect(article.indexOf('Last, a list should be revised.')).toBeLessThan(article.indexOf('Made with WriteFlex'))
    expect(html.match(/WriteFlex/g)).toHaveLength(1)
    const footer = between(html, '<footer class="made-with">', '</footer>')
    expect(footer).not.toMatch(/<img|<svg/)
    expect(html).toMatch(/\.made-with\{[^}]*font-size:12\.5px[^}]*color:var\(--muted\)/)
  })

  test('without a time zone says the time is UTC; without a name has no Shared by', () => {
    const plain = renderReaderPage(body({ timeZone: null, sharedBy: null }))
    expect(plain).toContain('14 October 2026, 08:12 UTC')
    expect(plain).not.toContain('Shared by')
    expect(formatUpdated(Date.UTC(2026, 0, 5, 23, 5), 'Europe/Prague')).toBe('6 January 2026, 00:05')
  })

  test('title, chips, name and headings are shown as text, never as markup', () => {
    const hostile = '<script>alert(1)</script>"\'&'
    const page = renderReaderPage(folio({
      title: hostile,
      sharedBy: hostile,
      chips: [{ label: hostile, value: hostile }],
      parts: [{ title: hostile, html: '<p>ok</p>', headings: [{ id: 'h1', text: hostile }] }],
    }))
    expect(page).not.toContain('<script>')
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;')
  })
})

describe('a shared Folio', () => {
  const html = renderReaderPage(folio())

  test('has a contents list with the parts in running order and their headings', () => {
    expect(html).toContain('<div class="rp readonly folio">')
    const contents = between(html, '<aside class="sidebar" aria-label="Contents">', '</aside>')
    expect(contents).toContain('<h2 class="sidebar-title">Teaching notes, autumn term</h2><p class="toc-label">Contents</p>')
    const links = [...contents.matchAll(/<a class="nav-link ([a-z0-9- ]+)" href="#([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2], m[3]])
    expect(links).toEqual([
      ['piece-link', 'part-1', '1. What a reading list is for'],
      ['level-3', 'p1-start', 'Start with a question'],
      ['piece-link', 'part-2', '2. Setting the first week'],
      ['piece-link', 'part-3', '3. Marking without a rubric'],
    ])
  })

  test('shows the parts in order, each with its label and title, and ends with the Made with line after the last part', () => {
    const order = ['id="part-1"', 'Part one text.', 'id="part-2"', 'Part two text.', 'id="part-3"', 'Part three, the last words.', 'Made with WriteFlex']
    const at = order.map((needle) => html.indexOf(needle))
    expect(at.every((index) => index > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toContain('<p class="plabel">Part 2</p><h1 class="wf-bundle-section-title" id="part-2-title">Setting the first week</h1>')
    expect(html).toContain('</section><footer class="made-with">')
  })

  test('a part missing on disk shows its title with "not available"', () => {
    const page = renderReaderPage(folio({ parts: [{ title: 'Here', html: '<p>Here.</p>' }, { title: 'Gone', missing: true }] }))
    expect(page).toContain('<h1 class="wf-bundle-section-title" id="part-2-title">Gone</h1><p class="part-missing">This part is not available.</p>')
  })
})

describe('what a publish may carry', () => {
  test('a piece is exactly one part with its text; heading anchors are unique and never a part anchor', () => {
    expect(() => body({ parts: [] })).toThrow('at least one part')
    expect(() => body({ parts: [{ html: 'a' }, { html: 'b' }] })).toThrow('exactly one part')
    expect(() => body({ parts: [{ missing: true }] })).toThrow('without its text')
    expect(() => folio({ parts: [{ title: 'A', html: '', headings: [{ id: 'x', text: 'X' }] }, { title: 'B', html: '', headings: [{ id: 'x', text: 'X' }] }] })).toThrow('used twice')
    expect(() => folio({ parts: [{ title: 'A', html: '', headings: [{ id: 'part-2', text: 'X' }] }] })).toThrow('used twice')
    expect(() => folio({ parts: [{ title: 'A', html: '', headings: [{ id: '"><x', text: 'X' }] }] })).toThrow('not a usable anchor')
  })

  test('labels are one line of plain text within their limits', () => {
    expect(() => body({ title: 'a\nb' })).toThrow('one line')
    expect(() => body({ sharedBy: 'Dominik‮' })).toThrow('one line')
    expect(() => body({ title: 'x'.repeat(301) })).toThrow('longer than 300')
    expect(() => body({ chips: Array.from({ length: 9 }, () => ({ label: 'a', value: 'b' })) })).toThrow('at most 8')
    expect(() => body({ lang: 'en"><script>' })).toThrow('language tag')
    expect(() => body({ images: ['../../etc/passwd'] })).toThrow('not an image name')
  })
})

describe('the "turned off" page', () => {
  test('is the locked link-off frame and names no one', async () => {
    const html = await linkOffResponse().text()
    expect(html).toContain('<h1>This link has been turned off</h1><p>If you still need the text, ask the person who sent you the link.</p>')
    expect(html).not.toMatch(/Shared by|Updated|Made with/)
  })
})
