import { describe, expect, test } from 'bun:test'
import type { ZoteroAnnotation } from '@readflex/zotero-bridge'
import type { OutboxEntry } from '@readflex/sidecar'
import {
  annotationFromOutbox,
  highlightRow,
  highlightsResult,
  matchesHighlightFilter,
  mergeWithOutbox,
} from '../../src/main/reading-room-highlights'

function annotation(overrides: Partial<ZoteroAnnotation> = {}): ZoteroAnnotation {
  return {
    authorName: null,
    color: '#ffd400',
    comment: null,
    isExternal: false,
    key: 'ANN1',
    pageLabel: '84',
    parentItemKey: 'ATT1',
    position: '{"pageIndex":83,"rects":[[10,20,30,40]]}',
    sortIndex: '00083|000601|00268',
    tags: [],
    text: 'The idea that categories are defined by common properties is not entirely wrong.',
    type: 'highlight',
    ...overrides,
  }
}

describe('a row knows how its body should be read', () => {
  test('a highlight and an underline are quotes', () => {
    expect(highlightRow(annotation())).toMatchObject({ bodyKind: 'quote' })
    expect(highlightRow(annotation({ type: 'underline' }))).toMatchObject({ bodyKind: 'quote' })
  })

  test('a note and a text annotation carry the reader’s own words', () => {
    const note = highlightRow(annotation({ comment: 'Come back to this', text: null, type: 'note' }))
    expect(note).toMatchObject({ bodyKind: 'note', body: 'Come back to this' })
  })

  test('an image or an ink mark has no words, so it names itself and stays reachable', () => {
    const image = highlightRow(annotation({ text: null, type: 'image' }))
    expect(image).toMatchObject({ bodyKind: 'mark', body: 'A marked region of the page' })
    expect(image.position).toBe('{"pageIndex":83,"rects":[[10,20,30,40]]}')
    expect(highlightRow(annotation({ text: null, type: 'ink' })).body).toBe('A drawing on the page')
  })

  test('an image with a comment shows the comment rather than the placeholder', () => {
    expect(highlightRow(annotation({ comment: 'the ICM diagram', text: null, type: 'image' })).body)
      .toBe('the ICM diagram')
  })

  test('a quote that also carries a comment keeps both, never duplicated', () => {
    const row = highlightRow(annotation({ comment: 'the crux' }))
    expect(row.body).toContain('categories are defined')
    expect(row.comment).toBe('the crux')
    expect(highlightRow(annotation({ comment: null })).comment).toBeNull()
  })

  test('a row is never blank, whatever Zotero stored', () => {
    expect(highlightRow(annotation({ comment: '   ', text: '   ' })).body.length).toBeGreaterThan(0)
  })

  test('Zotero’s note-link pseudo-tags never reach the filter row', () => {
    const row = highlightRow(annotation({
      tags: ['zotero://note/u/ZIPWT2YP/', 'prototype', 'zotero://note/u/P762PGFY/'],
    }))
    expect(row.tags).toEqual(['prototype'])
    expect(highlightsResult([annotation({ tags: ['zotero://note/u/ABC/'] })]).tags).toEqual([])
  })

  test('wrapped text from a PDF collapses to one line', () => {
    expect(highlightRow(annotation({ text: 'a broken\n  line\tof words' })).body)
      .toBe('a broken line of words')
  })
})

describe('the list is in document order with its facets', () => {
  test('rows sort by Zotero’s sortIndex, not by the page label', () => {
    // Page labels here are roman and out of order; sortIndex is the truth.
    const result = highlightsResult([
      annotation({ key: 'C', pageLabel: 'ix', sortIndex: '00100|000001|00001' }),
      annotation({ key: 'A', pageLabel: 'xi', sortIndex: '00002|000001|00001' }),
      annotation({ key: 'B', pageLabel: 'i', sortIndex: '00010|000001|00001' }),
    ])
    expect(result.rows.map((row) => row.key)).toEqual(['A', 'B', 'C'])
  })

  test('colours come in order of first appearance and tags alphabetically', () => {
    const result = highlightsResult([
      annotation({ color: '#2ea8e5', key: 'A', sortIndex: '1', tags: ['prototype'] }),
      annotation({ color: '#ffd400', key: 'B', sortIndex: '2', tags: ['ICM', 'prototype'] }),
      annotation({ color: '#2ea8e5', key: 'C', sortIndex: '3', tags: [] }),
    ])
    expect(result.colours).toEqual(['#2ea8e5', '#ffd400'])
    expect(result.tags).toEqual(['ICM', 'prototype'])
    expect(result.rows[1]!.tags).toEqual(['ICM', 'prototype'])
  })

  test('a document with no marks yields empty facets rather than an error', () => {
    expect(highlightsResult([])).toEqual({ colours: [], error: null, forReader: [], rows: [], tags: [] })
  })

  test('the marks handed to the reader carry the real quoted text, not the list placeholder', () => {
    const result = highlightsResult([
      annotation({ key: 'H' }),
      annotation({ key: 'IMG', text: null, type: 'image' }),
      annotation({ key: 'ODD', type: 'unknown' }),
    ])
    // The list names an image mark; the reader must receive its true (empty) text to paint it.
    expect(result.rows.find((row) => row.key === 'IMG')?.body).toBe('A marked region of the page')
    expect(result.forReader.find((mark) => mark.key === 'IMG')?.text).toBeNull()
    expect(result.forReader.find((mark) => mark.key === 'H')?.text).toContain('categories are defined')
    // A type the reader has no renderer for is not handed over, but is still listed.
    expect(result.forReader.map((mark) => mark.key)).toEqual(['H', 'IMG'])
    expect(result.rows).toHaveLength(3)
  })
})

describe('the filter', () => {
  const yellow = highlightRow(annotation({ color: '#ffd400', key: 'Y', tags: ['prototype'] }))
  const blue = highlightRow(annotation({
    color: '#2ea8e5',
    key: 'B',
    tags: ['ICM'],
    text: 'Idealized cognitive models are not the world.',
  }))
  const none = new Set<string>()

  test('no filter matches everything', () => {
    for (const row of [yellow, blue]) {
      expect(matchesHighlightFilter(row, { colours: none, query: '', tags: none })).toBe(true)
    }
  })

  test('colours are OR within themselves', () => {
    const colours = new Set(['#2ea8e5'])
    expect(matchesHighlightFilter(yellow, { colours, query: '', tags: none })).toBe(false)
    expect(matchesHighlightFilter(blue, { colours, query: '', tags: none })).toBe(true)
  })

  test('a colour and a tag are ANDed across the two rows of chips', () => {
    const filter = { colours: new Set(['#2ea8e5']), query: '', tags: new Set(['prototype']) }
    expect(matchesHighlightFilter(blue, filter)).toBe(false)
    expect(matchesHighlightFilter(yellow, filter)).toBe(false)
  })

  test('text matches the quote, a tag or the page, on all words at once', () => {
    expect(matchesHighlightFilter(blue, { colours: none, query: 'cognitive models', tags: none })).toBe(true)
    expect(matchesHighlightFilter(blue, { colours: none, query: 'ICM', tags: none })).toBe(true)
    expect(matchesHighlightFilter(blue, { colours: none, query: '84', tags: none })).toBe(true)
    expect(matchesHighlightFilter(blue, { colours: none, query: 'cognitive turnip', tags: none })).toBe(false)
  })

  test('a colourless mark is excluded once any colour is demanded', () => {
    const colourless = highlightRow(annotation({ color: null, key: 'N' }))
    expect(matchesHighlightFilter(colourless, { colours: new Set(['#ffd400']), query: '', tags: none }))
      .toBe(false)
  })
})

describe('what gets painted is Zotero plus the outbox, as one set (ADR-0029)', () => {
  function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
    return {
      attemptCount: 0,
      conflictPayload: null,
      createdAt: '2026-07-28T12:00:00.000Z',
      id: 1,
      itemKey: 'QUEUED1',
      lastError: null,
      libraryId: 1,
      localOnly: 0,
      operation: 'create',
      parentItemKey: 'ATT1',
      payload: JSON.stringify({
        annotationColor: '#5fb236',
        annotationComment: '',
        annotationPageLabel: '12',
        annotationPosition: { pageIndex: 11, rects: [[1, 2, 3, 4]] },
        annotationSortIndex: '00011|000100|00050',
        annotationText: 'a mark made offline',
        annotationType: 'highlight',
        itemType: 'annotation',
        parentItem: 'ATT1',
        tags: [{ tag: 'later' }],
      }),
      status: 'pending',
      updatedAt: '2026-07-28T12:00:00.000Z',
      ...overrides,
    }
  }

  test('a highlight that only exists in the outbox is drawn like any other', () => {
    const merged = mergeWithOutbox([], [entry()])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      color: '#5fb236',
      key: 'QUEUED1',
      pageLabel: '12',
      tags: ['later'],
      text: 'a mark made offline',
    })
    // Drawn identically: the row carries no marker of its sync state at all.
    const row = highlightRow(merged[0]!)
    expect(row.body).toBe('“a mark made offline”'.slice(1, -1))
    expect(JSON.stringify(row)).not.toContain('pending')
    expect(JSON.stringify(row)).not.toContain('sync')
  })

  test('a mark present in BOTH places paints once — the window that makes this a real bug', () => {
    // Between a write being confirmed and the read index being rebuilt, the same annotation is in
    // Zotero AND still in the outbox. Painting both yields a doubled highlight, which a reader reports
    // as a rendering fault rather than a sync one — so they would report the wrong bug.
    const stored = annotation({ key: 'QUEUED1', text: 'the older wording' })
    const merged = mergeWithOutbox([stored], [entry()])
    expect(merged).toHaveLength(1)
    // The outbox wins: it holds the newer intent, which the local database has not been told about.
    expect(merged[0]?.text).toBe('a mark made offline')
  })

  test('a mark painted from the outbox over a Zotero mark keeps that mark\'s tags, with no stamp, so its deletion is still checked', () => {
    const stored = { ...annotation({ key: 'QUEUED1', tags: ['added in Zotero'] }), zoteroState: { modified: '2026-10-22 10:00:00', tags: ['added in Zotero'] } }
    const update = entry({ operation: 'update' })
    const [merged] = mergeWithOutbox([stored], [update])
    // WriteFlex never writes tags, and its own write moves Zotero's stamp.
    expect(merged?.zoteroState).toEqual({ modified: null, tags: ['added in Zotero'] })
    expect(highlightsResult([merged!]).forReader[0]?.zoteroState).toEqual({ modified: null, tags: ['added in Zotero'] })
    // A confirmed-unread create and a later edit over it: still the stored tags.
    expect(mergeWithOutbox([stored], [entry(), entry({ id: 2, operation: 'update' })])[0]?.zoteroState)
      .toEqual({ modified: null, tags: ['added in Zotero'] })
    // A stored mark whose state is unknown gives the overlay none: unknown is not "no tags".
    expect(mergeWithOutbox([annotation({ key: 'QUEUED1' })], [update])[0]?.zoteroState).toBeUndefined()
  })

  test('with nothing beneath it, a create has no tags in Zotero and an edit takes the tags its reader was shown', () => {
    expect(mergeWithOutbox([], [entry()])[0]?.zoteroState).toEqual({ modified: null, tags: [] })
    const base = JSON.parse(entry().payload) as Record<string, unknown>
    const shown = entry({ operation: 'update', payload: JSON.stringify({ ...base, readflexBaseline: { zoteroState: { modified: '2026-10-22 10:00:00', tags: ['shown'] } } }) })
    expect(mergeWithOutbox([], [shown])[0]?.zoteroState).toEqual({ modified: null, tags: ['shown'] })
    expect(mergeWithOutbox([], [entry({ operation: 'update' })])[0]?.zoteroState).toBeUndefined()
  })

  test('a quotation-only update never paints a second copy of its Area', () => {
    const base = JSON.parse(entry().payload) as Record<string, unknown>
    const quotation = entry({
      operation: 'update',
      payload: JSON.stringify({
        ...base,
        readflexAreaQuotation: {
          sourceKey: 'READERA7',
          comment: 'Quoted in "Draft" — 1 August 2026',
        },
      }),
    })
    expect(annotationFromOutbox(quotation)).toBeNull()
  })

  test('a rejected or conflicted write still paints — the mark exists whatever sync did', () => {
    for (const status of ['retrying', 'failed', 'conflict'] as const) {
      expect(mergeWithOutbox([], [entry({ status })])).toHaveLength(1)
    }
  })

  test('a queued deletion removes nothing from view, and an unreadable row is skipped', () => {
    expect(annotationFromOutbox(entry({ operation: 'delete' }))).toBeNull()
    expect(annotationFromOutbox(entry({ payload: 'not json' }))).toBeNull()
    expect(annotationFromOutbox(entry({ itemKey: null }))).toBeNull()
    // A broken queue row must not take the whole harvest down with it.
    expect(mergeWithOutbox([annotation()], [entry({ payload: 'not json' })])).toHaveLength(1)
  })

  test('stored marks the outbox says nothing about are untouched', () => {
    const merged = mergeWithOutbox(
      [annotation({ key: 'A' }), annotation({ key: 'B' })],
      [entry({ itemKey: 'C' })],
    )
    expect(merged.map((mark) => mark.key).sort()).toEqual(['A', 'B', 'C'])
  })
})
