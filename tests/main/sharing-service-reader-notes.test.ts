// Readers' notes, the pure parts: what a reader may send (sharing-service/reader-notes.ts), the
// service-wide hourly count (note-budget.ts), and the reader page with comments on or off
// (reader-page.ts). The request handlers are in tests/helpers/sharing-service-notes-suite.ts.
import { describe, expect, test } from 'bun:test'
import { NoteBudgetTable } from '../../sharing-service/note-budget.ts'
import { renderReaderPage, readerPageResponse } from '../../sharing-service/reader-page.ts'
import { NoteProtocolError, cleanText, networkOf, parseName, parsePostedNote, readerKeyOf } from '../../sharing-service/reader-notes.ts'
import { READER_PAGE_RUNTIME } from '../../sharing-service/reader-runtime.ts'
import { parsePublishBody } from '../../sharing-service/share-protocol.ts'
import { fakeObjectState } from '../helpers/sharing-service-runtime.ts'

const anchor = { quote: 'stop guessing', before: 'a child', after: 'at words', block: 'n:2', start: 10, end: 23 }

describe('what a reader may send', () => {
  test('a note: id, kind, a one-line name, plain text, the anchor', () => {
    expect(parsePostedNote({ id: 'abcdefgh', kind: 'note', name: '  Marta ', text: ' Why? ', anchor })).toEqual({
      id: 'abcdefgh', kind: 'note', name: 'Marta', text: 'Why?', anchor, writtenAt: null, revision: null,
    })
  })

  test('names refuse line breaks, invisible and bidi characters; text loses them', () => {
    for (const name of ['a\nb', 'a b', 'Mar​ta', 'Marta‮', 'Marta⁦', '­']) expect(() => parseName(name)).toThrow(NoteProtocolError)
    expect(parseName('Tomás Ñ 李')).toBe('Tomás Ñ 李')
    expect(cleanText('a\r\nb c\u0000d‮e⁧f\tg')).toBe('a\nb\ncdef\tg')
  })

  test('the reader digest is bound to the share', async () => {
    const secret = 'A'.repeat(43)
    const one = await readerKeyOf('S'.repeat(22), secret)
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    expect(await readerKeyOf('T'.repeat(22), secret)).not.toBe(one)
    expect(one).not.toContain(secret)
  })
})

describe('the network a note comes from', () => {
  test('IPv4 as it is; IPv6 by its /64, however it is written; anything else is one network, unknown', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7')
    expect(networkOf(' 203.0.113.7 ')).toBe('203.0.113.7')
    const block = '2001:0db8:0001:0002::/64'
    for (const address of ['2001:db8:1:2::5', '2001:DB8:1:2:ffff:ffff:ffff:9', '2001:db8:1:2:0:0:0:1', '2001:db8:1:2::ffff:192.0.2.1']) expect(networkOf(address)).toBe(block)
    expect(networkOf('2001:db8:1:3::5')).not.toBe(block)
    expect(networkOf('::1')).toBe('0000:0000:0000:0000::/64')
    for (const junk of [null, '', 'unknown', 'example.com', '1.2.3', '2001:db8::1::2', '2001:db8:1:2:3:4:5:6:7', 'x'.repeat(100), '<script>']) expect(networkOf(junk)).toBe('unknown')
  })
})

describe('the service-wide hourly count', () => {
  test('grants up to the limit in any hour, counts refusals, and frees room as the hour slides', () => {
    const state = fakeObjectState()
    const table = new NoteBudgetTable(state.storage.sql as never)
    const t0 = Date.UTC(2026, 9, 15, 10, 0)
    const granted = Array.from({ length: 5 }, (_, i) => table.take(t0 + i * 600_000, 3))
    expect(granted).toEqual([true, true, true, false, false])
    expect(state.db.query('SELECT SUM(refused) AS n FROM note_budget').get()).toEqual({ n: 2 })
    // 60 minutes after the first: the first minute has left the window.
    expect(table.take(t0 + 3_600_000, 3)).toBe(true)
    expect(table.take(t0 + 3_600_000, 3)).toBe(false)
  })

  test('a grant given back makes room again; a minute with nothing granted gives nothing back', () => {
    const state = fakeObjectState()
    const table = new NoteBudgetTable(state.storage.sql as never)
    const t0 = Date.UTC(2026, 9, 15, 10, 0)
    const minute = table.grant(t0, 1)
    expect(minute).toBe(Math.floor(t0 / 60_000))
    expect(table.grant(t0, 1)).toBeNull()
    expect(table.refund(minute!)).toBe(true)
    expect(table.refund(minute!)).toBe(false)
    expect(table.grant(t0, 1)).toBe(minute)
  })
})

describe('the reader page with comments', () => {
  const publish = (extra: Record<string, unknown>) => parsePublishBody({
    revision: 4, savedAt: Date.UTC(2026, 9, 14, 8, 12), timeZone: 'Europe/London', sharedBy: 'Dominik "D" <b>', kind: 'piece',
    title: 'T', parts: [{ html: '<p class="wf-paragraph">Text.</p>' }], ...extra,
  })

  test('off by default: text only, and the reader bar says so', () => {
    const html = renderReaderPage(publish({}))
    expect(html).toContain('<div class="rp readonly">')
    expect(html).toContain('<span>Comments are off for this link.</span>')
    expect(html.slice(html.indexOf('<body>'))).not.toContain('notes-col')
    expect(() => publish({ comments: 'yes' })).toThrow('comments must be true or false')
  })

  test('on: an empty notes column, the revision, and the author\'s name escaped', () => {
    const html = renderReaderPage(publish({ comments: true }))
    expect(html).toContain('<div class="rp notes" data-view="margin" data-comments="on" data-revision="4" data-author="Dominik &quot;D&quot; &lt;b&gt;">')
    expect(html).toContain('</article><aside class="notes-col" aria-label="Comments"></aside></div></div></body></html>')
    expect(html).not.toContain('Comments are off')
  })

  test('the page\'s script is added as the page is served, and never closes its own element early', async () => {
    const html = renderReaderPage(publish({ comments: true }))
    const served = await (await readerPageResponse(html)).text()
    expect(served).toBe(html.replace('</body></html>', `<script>${READER_PAGE_RUNTIME}</script></body></html>`))
    expect(READER_PAGE_RUNTIME).not.toMatch(/<\/script|<!--/i)
    expect(READER_PAGE_RUNTIME).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/)
    // Every character of the script is ASCII: nothing an encoding could change.
    expect([...READER_PAGE_RUNTIME].every((c) => c.charCodeAt(0) < 127)).toBe(true)
  })
})
