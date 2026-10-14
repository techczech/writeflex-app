import { describe, expect, test } from 'bun:test'
import {
  areaCaptureMarkdown,
  commitReadingRoomAreaDrop,
  decodeReadingRoomAreaPng,
  parseReadingRoomAreaTransfer,
  READING_ROOM_AREA_MIME,
  readingRoomAreaTransferForAnnotation,
} from '../../src/renderer/src/editor/reading-room-area-drop'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'

const valid = {
  annotationKey: 'AREA0001',
  attachmentKey: 'LAKOFFPDF',
  authorYear: 'Lakoff 1987',
  image: PNG_DATA_URL,
  libraryId: 1,
  link: 'zotero://open-pdf/library/items/LAKOFFPDF?annotation=AREA0001',
  pageLabel: '91',
}

describe('the private Area drag payload', () => {
  test('has its own MIME type so the reader text payload stays untouched', () => {
    expect(READING_ROOM_AREA_MIME).toBe('application/x-writeflex-reading-area')
  })

  test('accepts a PNG tied to one exact Zotero annotation', () => {
    expect(parseReadingRoomAreaTransfer(JSON.stringify(valid))).toEqual(valid)
  })

  test('builds the payload from the canonical reader annotation rather than trusting raw drag fields', () => {
    expect(readingRoomAreaTransferForAnnotation({
      image: PNG_DATA_URL,
      key: 'AREA0001',
      pageLabel: '91',
      type: 'image',
    }, {
      attachmentKey: 'LAKOFFPDF',
      authorYear: 'Lakoff 1987',
      libraryId: 1,
    }, 'zotero://open-pdf/library/items/LAKOFFPDF')).toEqual(valid)
  })

  test('does not build an Area payload for another annotation type', () => {
    expect(readingRoomAreaTransferForAnnotation({
      image: PNG_DATA_URL,
      key: 'AREA0001',
      pageLabel: '91',
      type: 'highlight',
    }, {
      attachmentKey: 'LAKOFFPDF',
      authorYear: 'Lakoff 1987',
      libraryId: 1,
    }, 'zotero://open-pdf/library/items/LAKOFFPDF')).toBeNull()
  })

  test('keeps an exact annotation link when the PDF has no display page label', () => {
    expect(parseReadingRoomAreaTransfer(JSON.stringify({ ...valid, pageLabel: null })))
      .toEqual({ ...valid, pageLabel: null })
    expect(areaCaptureMarkdown('assets/area.png', { ...valid, pageLabel: null }))
      .toContain('[⟨Lakoff 1987 · area annotation⟩]')
  })

  test.each([
    ['malformed JSON', '{'],
    ['a non-PNG image', JSON.stringify({ ...valid, image: 'data:image/jpeg;base64,/9j/' })],
    ['a missing annotation key', JSON.stringify({ ...valid, annotationKey: ' ' })],
    ['a missing attachment key', JSON.stringify({ ...valid, attachmentKey: '' })],
    ['a missing source label', JSON.stringify({ ...valid, authorYear: '' })],
    ['an empty page label', JSON.stringify({ ...valid, pageLabel: '' })],
    ['an invalid library id', JSON.stringify({ ...valid, libraryId: -1 })],
    ['a zero library id', JSON.stringify({ ...valid, libraryId: 0 })],
    ['a link for a different annotation', JSON.stringify({
      ...valid,
      link: 'zotero://open-pdf/library/items/LAKOFFPDF?annotation=SOMEWHEREELSE',
    })],
  ])('rejects %s', (_case, raw) => {
    expect(parseReadingRoomAreaTransfer(raw)).toBeNull()
  })

  test('rejects decoded image data above the supplied IPC boundary', () => {
    expect(parseReadingRoomAreaTransfer(JSON.stringify(valid), 7)).toBeNull()
  })

  test('rejects an oversized serialised payload before its JSON can become a large object graph', () => {
    expect(parseReadingRoomAreaTransfer(JSON.stringify({ ...valid, padding: 'x'.repeat(5000) }), 64))
      .toBeNull()
  })
})

describe('an Area arriving in the draft', () => {
  test('decodes only the validated PNG bytes', () => {
    expect([...decodeReadingRoomAreaPng(valid.image)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  test('becomes one image-plus-exact-source block', () => {
    expect(areaCaptureMarkdown('assets/pasted-2026-07-31-1.png', valid)).toBe(
      '![Captured chart or table](assets/pasted-2026-07-31-1.png)\n\n'
      + '[⟨Lakoff 1987, p. 91 · area annotation⟩](zotero://open-pdf/library/items/LAKOFFPDF?annotation=AREA0001)',
    )
  })

  test('records the quotation only after the complete block is inserted', async () => {
    const events: string[] = []
    const result = await commitReadingRoomAreaDrop(valid, {
      insert: (markdown) => { events.push(`insert:${markdown}`); return true },
      isCurrent: () => true,
      onStatus: (message) => events.push(`status:${message}`),
      recordQuotation: async () => { events.push('record') },
      saveImage: async () => { events.push('save'); return { path: 'assets/area.png' } },
    })
    expect(result).toBe('inserted')
    expect(events[0]).toBe('save')
    expect(events[1]).toStartWith('insert:![Captured chart or table]')
    expect(events[2]).toBe('record')
  })

  test('does not insert or record when asset saving fails', async () => {
    const events: string[] = []
    const result = await commitReadingRoomAreaDrop(valid, {
      insert: () => { events.push('insert'); return true },
      isCurrent: () => true,
      onStatus: (message) => events.push(message),
      recordQuotation: async () => { events.push('record') },
      saveImage: async () => { throw new Error('disk full') },
    })
    expect(result).toBe('failed')
    expect(events).toEqual(['Could not insert the Area capture: disk full'])
  })

  test('does not put an Area into a different draft after the save finishes', async () => {
    const events: string[] = []
    const result = await commitReadingRoomAreaDrop(valid, {
      insert: () => { events.push('insert'); return true },
      isCurrent: () => false,
      onStatus: (message) => events.push(message),
      recordQuotation: async () => { events.push('record') },
      saveImage: async () => ({ path: 'assets/area.png' }),
    })
    expect(result).toBe('stale')
    expect(events).toEqual(['Area capture saved, but the destination draft changed before insertion.'])
  })

  test('turns a thrown editor transaction into a handled insertion failure', async () => {
    const events: string[] = []
    const result = await commitReadingRoomAreaDrop(valid, {
      insert: () => { throw new Error('transaction refused') },
      isCurrent: () => true,
      onStatus: (message) => events.push(message),
      recordQuotation: async () => { events.push('record') },
      saveImage: async () => ({ path: 'assets/area.png' }),
    })
    expect(result).toBe('failed')
    expect(events).toEqual(['Could not insert the Area capture: transaction refused'])
  })

  test('keeps a successful insertion when quotation recording fails', async () => {
    const events: string[] = []
    const result = await commitReadingRoomAreaDrop(valid, {
      insert: () => { events.push('insert'); return true },
      isCurrent: () => true,
      onStatus: (message) => events.push(message),
      recordQuotation: async () => { throw new Error('Zotero is open') },
      saveImage: async () => ({ path: 'assets/area.png' }),
    })
    expect(result).toBe('inserted-without-provenance')
    expect(events).toEqual([
      'insert',
      'Area inserted, but its quotation record could not be saved: Zotero is open',
    ])
  })
})
