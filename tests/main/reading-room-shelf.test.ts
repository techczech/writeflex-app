import { describe, expect, test } from 'bun:test'
import type { ShelfAttachment, ShelfItem } from '@readflex/zotero-bridge'
import {
  NO_FILE_NOTICE,
  readingRoomDocumentFor,
  shelfAttachmentRow,
  shelfAuthorYear,
  shelfRow,
} from '../../src/main/reading-room-shelf'

function creator(lastName: string, creatorType = 'author'): ShelfItem['creators'][number] {
  return { creatorType, firstName: 'A.', lastName }
}

function item(overrides: Partial<ShelfItem> = {}): ShelfItem {
  return {
    attachments: [],
    citationKey: 'Lakoff1987Women',
    creators: [creator('Lakoff')],
    itemKey: 'LAKOFF01',
    libraryId: 1,
    tags: [],
    title: 'Women, Fire, and Dangerous Things',
    year: '1987',
    ...overrides,
  }
}

function attachment(overrides: Partial<ShelfAttachment> = {}): ShelfAttachment {
  return {
    contentType: 'application/pdf',
    filename: 'lakoff.pdf',
    key: 'LAKOFFPDF',
    kind: 'pdf',
    linkMode: 0,
    resolution: { kind: 'pdf', path: '/library/storage/LAKOFFPDF/lakoff.pdf', state: 'stored' },
    storedPath: 'storage:lakoff.pdf',
    title: 'Full book PDF',
    url: null,
    ...overrides,
  }
}

describe('the Shelf scan line', () => {
  test('names one, two and many authors, and drops an absent year', () => {
    expect(shelfAuthorYear(item())).toBe('Lakoff 1987')
    expect(shelfAuthorYear(item({ creators: [creator('Lakoff'), creator('Johnson')], year: '1980' })))
      .toBe('Lakoff and Johnson 1980')
    expect(shelfAuthorYear(item({ creators: [creator('Lakoff'), creator('Johnson'), creator('Turner')] })))
      .toBe('Lakoff et al. 1987')
    expect(shelfAuthorYear(item({ year: undefined }))).toBe('Lakoff')
    expect(shelfAuthorYear(item({ creators: [] }))).toBe('1987')
  })

  test('an editor stands in only when there is no author', () => {
    expect(shelfAuthorYear(item({ creators: [creator('Ortony', 'editor')] }))).toBe('Ortony 1987')
    expect(shelfAuthorYear(item({ creators: [creator('Ortony', 'editor'), creator('Lakoff')] })))
      .toBe('Lakoff 1987')
  })
})

describe('every attachment state is visible rather than a failing click', () => {
  test('a stored PDF and a stored snapshot are openable and badged by kind', () => {
    expect(shelfAttachmentRow(attachment())).toMatchObject({ badge: 'PDF', openable: true, notice: null })
    expect(shelfAttachmentRow(attachment({
      resolution: { kind: 'snapshot', path: '/library/storage/SNAP/index.html', state: 'stored' },
    }))).toMatchObject({ badge: 'HTML snapshot', kind: 'snapshot', openable: true })
  })

  test('a file Zotero has not downloaded carries the locked mockup copy', () => {
    const row = shelfAttachmentRow(attachment({
      resolution: { expectedKind: 'pdf', expectedPath: '/library/storage/X/y.pdf', state: 'missing' },
    }))
    expect(row.openable).toBe(false)
    expect(row.badge).toBe('PDF · not downloaded')
    expect(row.notice).toBe("This PDF isn't on this machine yet. Zotero hasn't downloaded it.")
  })

  test('a web link, a lost linked file and an unsupported type each explain themselves', () => {
    expect(shelfAttachmentRow(attachment({ linkMode: 3, resolution: { state: 'link', url: 'https://example.org' } })))
      .toMatchObject({ badge: 'Web link', openable: false })
    expect(shelfAttachmentRow(attachment({
      resolution: { available: false, kind: 'pdf', path: '/gone/supplement.pdf', state: 'linked-file' },
    }))).toMatchObject({ badge: 'PDF · file not found', openable: false })
    expect(shelfAttachmentRow(attachment({
      resolution: { contentType: 'application/epub+zip', state: 'unsupported' },
    }))).toMatchObject({ badge: 'Unsupported file', openable: false })
  })

  test('a linked file that IS on this machine opens', () => {
    expect(shelfAttachmentRow(attachment({
      resolution: { available: true, kind: 'pdf', path: '/elsewhere/supplement.pdf', state: 'linked-file' },
    }))).toMatchObject({ openable: true, notice: null })
  })

  test('an untitled attachment falls back to its filename, then to its kind', () => {
    expect(shelfAttachmentRow(attachment({ title: '' })).title).toBe('lakoff.pdf')
    expect(shelfAttachmentRow(attachment({ filename: null, title: '' })).title).toBe('PDF')
  })
})

describe('a Shelf row is an item, with its attachments as a property (ADR-0009)', () => {
  test('an item with no readable file appears, is not openable, and can still be cited', () => {
    const row = shelfRow(item({ attachments: [] }))
    expect(row).toMatchObject({ attachmentKey: null, badge: 'No file', kind: 'none', openable: false })
    expect(row.notice).toBe(NO_FILE_NOTICE)
    expect(row.citationKey).toBe('Lakoff1987Women')
  })

  test('an item whose only attachment is missing shows that attachment’s notice', () => {
    const row = shelfRow(item({
      attachments: [attachment({
        resolution: { expectedKind: 'pdf', expectedPath: null, state: 'missing' },
      })],
    }))
    expect(row.openable).toBe(false)
    expect(row.notice).toBe("This PDF isn't on this machine yet. Zotero hasn't downloaded it.")
  })

  test('a chaptered book counts its readable files and offers the first', () => {
    const row = shelfRow(item({
      attachments: [
        attachment(),
        attachment({ key: 'LAKOFFCH2', resolution: { kind: 'pdf', path: '/library/storage/LAKOFFCH2/two.pdf', state: 'stored' } }),
        attachment({ key: 'MISSINGPDF', resolution: { expectedKind: 'pdf', expectedPath: null, state: 'missing' } }),
      ],
    }))
    expect(row.badge).toBe('PDF · 2 files')
    expect(row.attachmentKey).toBe('LAKOFFPDF')
    expect(row.openable).toBe(true)
    // The unreadable one is still listed, so it is visible rather than silently dropped.
    expect(row.attachments).toHaveLength(3)
    expect(row.attachments[2]).toMatchObject({ openable: false })
  })

  test('a single readable file shows its own badge, not a count', () => {
    expect(shelfRow(item({ attachments: [attachment()] })).badge).toBe('PDF')
  })
})

describe('opening a Shelf selection goes through the remembered-document record', () => {
  test('the named attachment supplies the path, kind and locator strings', () => {
    const source = item({
      attachments: [
        attachment(),
        attachment({ key: 'SNAPHTML1', kind: 'snapshot', resolution: { kind: 'snapshot', path: '/library/storage/SNAPHTML1/index.html', state: 'stored' } }),
      ],
    })
    expect(readingRoomDocumentFor(source, 'SNAPHTML1')).toEqual({
      attachmentKey: 'SNAPHTML1',
      authorYear: 'Lakoff 1987',
      itemKey: 'LAKOFF01',
      kind: 'snapshot',
      libraryId: 1,
      path: '/library/storage/SNAPHTML1/index.html',
      shortTitle: 'Women, Fire, and Dangerous Things',
    })
  })

  test('no named attachment takes the first readable one, skipping the unreadable', () => {
    const source = item({
      attachments: [
        attachment({ key: 'MISSINGPDF', resolution: { expectedKind: 'pdf', expectedPath: null, state: 'missing' } }),
        attachment(),
      ],
    })
    expect(readingRoomDocumentFor(source, null).attachmentKey).toBe('LAKOFFPDF')
  })

  test('an unreadable selection refuses with the row’s own words, never a silent open', () => {
    const source = item({
      attachments: [attachment({ key: 'MISSINGPDF', resolution: { expectedKind: 'pdf', expectedPath: null, state: 'missing' } })],
    })
    expect(() => readingRoomDocumentFor(source, 'MISSINGPDF')).toThrow(
      "This PDF isn't on this machine yet. Zotero hasn't downloaded it.",
    )
    expect(() => readingRoomDocumentFor(item({ attachments: [] }), null)).toThrow(NO_FILE_NOTICE)
  })
})
