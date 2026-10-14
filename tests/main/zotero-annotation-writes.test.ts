import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '@readflex/sidecar'
import { documentTitle } from '../../src/main/frontmatter'
import { createBunSqliteDriver } from '@readflex/sqlite-driver/bun'
import { openZoteroAnnotationWriteSession, type NewZoteroAnnotation } from '@readflex/zotero-bridge'
import {
  MAX_ANNOTATION_COMMENT_BYTES,
  MAX_ANNOTATION_POSITION_BYTES,
  MAX_ANNOTATION_TEXT_BYTES,
  annotationPositionWithinCap,
  annotationPayload,
  annotationTextWithinCap,
  areaQuotationPayload,
  citationAnnotation,
  drainOutbox,
  drainOutboxToZotero,
  e2eZoteroLivenessProbes,
  findExactCitationAnnotation,
  isPdfCitationPosition,
  localAnnotationFromPayload,
  quotationComment,
  type SavedAnnotation,
  type ZoteroWriteOutcome,
  type ZoteroWriteTransport,
} from '../../src/main/zotero-annotation-writes'

const annotation: SavedAnnotation = {
  color: '#ffd400',
  comment: 'the crux',
  key: 'ANN1',
  pageLabel: '157',
  position: '{"pageIndex":156,"rects":[[131.8,274.1,287.0,283.2]]}',
  sortIndex: '00156|000601|00268',
  tags: ['models'],
  text: 'the implicit models that have generally been used',
  type: 'highlight',
}

const directories: string[] = []
function store(): SidecarStore {
  const directory = mkdtempSync(join(tmpdir(), 'wf-outbox-'))
  directories.push(directory)
  return new SidecarStore(createBunSqliteDriver(), join(directory, 'sidecar.sqlite'))
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function queue(sidecar: SidecarStore, key = 'ANN1'): number {
  return sidecar.enqueueOutbox({
    itemKey: null,
    libraryId: 1,
    operation: 'create',
    parentItemKey: 'ATT1',
    payload: JSON.stringify(annotationPayload({ ...annotation, key }, 'ATT1')),
  }).id
}

const always = (outcome: ZoteroWriteOutcome): ZoteroWriteTransport => async () => outcome

describe('the verified API payload (ADR-0002)', () => {
  test('maps the reader’s annotation one-to-one', () => {
    expect(annotationPayload(annotation, 'ATT1')).toEqual({
      annotationColor: '#ffd400',
      annotationComment: 'the crux',
      annotationPageLabel: '157',
      annotationPosition: { pageIndex: 156, rects: [[131.8, 274.1, 287.0, 283.2]] },
      annotationSortIndex: '00156|000601|00268',
      annotationText: 'the implicit models that have generally been used',
      annotationType: 'highlight',
      itemType: 'annotation',
      parentItem: 'ATT1',
      tags: [{ tag: 'models' }],
    })
  })

  test('keeps itemType annotation, which the public /itemTypes list omits but the API accepts', () => {
    expect(annotationPayload(annotation, 'ATT1').itemType).toBe('annotation')
  })

  test('an update carries the version the edit is based on; a create does not', () => {
    expect(annotationPayload(annotation, 'ATT1', 42).version).toBe(42)
    expect('version' in annotationPayload(annotation, 'ATT1')).toBe(false)
  })

  test('absent fields become empty strings and Zotero’s default colour, never undefined', () => {
    const bare = annotationPayload(
      { ...annotation, color: null, comment: null, pageLabel: null, text: null }, 'ATT1',
    )
    expect(bare.annotationText).toBe('')
    expect(bare.annotationComment).toBe('')
    expect(bare.annotationPageLabel).toBe('')
    expect(bare.annotationColor).toBe('#ffd400')
  })

  test('a position the reader could not serialise degrades rather than throwing', () => {
    expect(annotationPayload({ ...annotation, position: 'not json' }, 'ATT1').annotationPosition)
      .toEqual({ pageIndex: 0, rects: [] })
  })

  test('the final comment is capped at 2 KiB in UTF-8 without splitting a character', () => {
    const atBoundary = 'é'.repeat(MAX_ANNOTATION_COMMENT_BYTES / 2)
    expect(annotationPayload({ ...annotation, comment: atBoundary }, 'ATT1').annotationComment)
      .toBe(atBoundary)

    const capped = annotationPayload({
      ...annotation,
      comment: `${atBoundary}é`,
    }, 'ATT1').annotationComment
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(MAX_ANNOTATION_COMMENT_BYTES)
    expect(capped).toEndWith('…')
    expect(capped).not.toContain('\uFFFD')
  })

  test('a cross-page PDF position survives byte-identical through the payload and local insert', () => {
    const position = '{"pageIndex":0,"rects":[[72,680,280,700]],"nextPageRects":[[72,40,280,60]]}'
    const payload = annotationPayload({ ...annotation, position }, 'ATT1')
    expect(JSON.stringify(payload.annotationPosition)).toBe(position)
    expect(localAnnotationFromPayload(
      { itemKey: 'CROSSPG1', libraryId: 1, parentItemKey: 'ATT1' },
      payload,
    )?.position).toBe(position)
  })
})

test('citation limits are measured in UTF-8 bytes and include the stated boundary', () => {
  expect(annotationPositionWithinCap('x'.repeat(MAX_ANNOTATION_POSITION_BYTES))).toBe(true)
  expect(annotationPositionWithinCap('x'.repeat(MAX_ANNOTATION_POSITION_BYTES + 1))).toBe(false)
  expect(annotationPositionWithinCap('é'.repeat(MAX_ANNOTATION_POSITION_BYTES / 2))).toBe(true)
  expect(annotationPositionWithinCap(`é${'x'.repeat(MAX_ANNOTATION_POSITION_BYTES - 1)}`)).toBe(false)

  expect(annotationTextWithinCap('x'.repeat(MAX_ANNOTATION_TEXT_BYTES))).toBe(true)
  expect(annotationTextWithinCap('x'.repeat(MAX_ANNOTATION_TEXT_BYTES + 1))).toBe(false)
  expect(annotationTextWithinCap(null)).toBe(true)
})

describe('citing creates one exact Zotero highlight (ADR-0035)', () => {
  const selection = {
    color: '#ffd400',
    pageLabel: '157',
    position: '{"pageIndex":156,"rects":[[131.8,274.1,287,283.2]]}',
    sortIndex: '00156|000601|00268',
    text: 'the implicit models that have generally been used',
    type: 'highlight' as const,
  }

  test('accepts only four finite values in every PDF rectangle', () => {
    expect(isPdfCitationPosition('{"pageIndex":0,"rects":[[10,20,30,40]]}')).toBe(true)
    expect(isPdfCitationPosition('{"pageIndex":0,"rects":[[10,20,30]]}')).toBe(false)
    expect(isPdfCitationPosition('{"pageIndex":0,"rects":[[10,20,30,40,50]]}')).toBe(false)
    expect(isPdfCitationPosition('{"pageIndex":0,"rects":[[10,20,30,null]]}')).toBe(false)
  })

  test('the create has a local Zotero key and the exact draft title plus human date comment', () => {
    expect(quotationComment('The Radial Category Problem', new Date('2026-07-29T12:00:00Z')))
      .toBe('Quoted in "The Radial Category Problem" — 29 July 2026')
    const created = citationAnnotation(
      selection,
      'The Radial Category Problem',
      new Date('2026-07-29T12:00:00Z'),
      () => 0,
    )
    expect(created).toEqual({
      color: '#ffd400',
      comment: 'Quoted in "The Radial Category Problem" — 29 July 2026',
      key: '22222222',
      pageLabel: '157',
      position: '{"pageIndex":156,"rects":[[131.8,274.1,287,283.2]]}',
      sortIndex: '00156|000601|00268',
      tags: [],
      text: 'the implicit models that have generally been used',
      type: 'highlight',
    })
  })

  test('the draft title is truncated to 200 characters with an ellipsis before interpolation', () => {
    const created = citationAnnotation(
      selection,
      'T'.repeat(201),
      new Date('2026-07-29T12:00:00Z'),
      () => 0,
    )
    const title = created.comment?.match(/^Quoted in "(.+)" — /)?.[1]

    expect(title).toBe(`${'T'.repeat(199)}…`)
    expect([...title!]).toHaveLength(200)
    expect(Buffer.byteLength(created.comment!, 'utf8')).toBeLessThanOrEqual(
      MAX_ANNOTATION_COMMENT_BYTES,
    )
  })

  test('only an app-created mark with the same attachment, page and byte-identical rects is reused', () => {
    const sidecar = store()
    const exact = sidecar.enqueueOutbox({
      itemKey: 'EXACT222',
      libraryId: 1,
      operation: 'create',
      parentItemKey: 'ATT1',
      payload: JSON.stringify(annotationPayload(
        { ...citationAnnotation(selection, 'First draft'), key: 'EXACT222' },
        'ATT1',
      )),
    })
    sidecar.enqueueOutbox({
      itemKey: 'NEAR2222',
      libraryId: 1,
      operation: 'create',
      parentItemKey: 'ATT1',
      payload: JSON.stringify(annotationPayload(
        {
          ...citationAnnotation(selection, 'First draft'),
          key: 'NEAR2222',
          position: '{"pageIndex":156,"rects":[[131.8,274.1,287.01,283.2]]}',
        },
        'ATT1',
      )),
    })
    sidecar.enqueueOutbox({
      itemKey: 'OTHERATT',
      libraryId: 1,
      operation: 'create',
      parentItemKey: 'ATT2',
      payload: JSON.stringify(annotationPayload(
        { ...citationAnnotation(selection, 'First draft'), key: 'OTHERATT' },
        'ATT2',
      )),
    })
    sidecar.enqueueOutbox({
      itemKey: 'UPDATE22',
      libraryId: 1,
      operation: 'update',
      parentItemKey: 'ATT1',
      payload: JSON.stringify(annotationPayload(
        { ...citationAnnotation(selection, 'First draft'), key: 'UPDATE22' },
        'ATT1',
      )),
    })

    expect(findExactCitationAnnotation(
      [
        ...sidecar.outboxByStatus('pending'),
        ...sidecar.outboxByStatus('retrying'),
        ...sidecar.outboxByStatus('confirmed'),
        ...sidecar.outboxByStatus('failed'),
        ...sidecar.outboxByStatus('conflict'),
      ],
      1,
      'ATT1',
      selection.position,
    )?.id).toBe(exact.id)
    expect(findExactCitationAnnotation(
      sidecar.outboxByStatus('pending'),
      1,
      'ATT1',
      '{"pageIndex":156,"rects":[[131.8,274.1,287.001,283.2]]}',
    )).toBeNull()
    sidecar.close()
  })

  test('dedupe compares the complete verbatim PDF position, including next-page rectangles', () => {
    const sidecar = store()
    const position = '{"pageIndex":0,"rects":[[72,680,280,700]],"nextPageRects":[[72,40,280,60]]}'
    const exact = sidecar.enqueueOutbox({
      itemKey: 'CROSSPG1',
      libraryId: 1,
      operation: 'create',
      parentItemKey: 'ATT1',
      payload: JSON.stringify(annotationPayload(
        { ...citationAnnotation(selection, 'First draft'), key: 'CROSSPG1', position },
        'ATT1',
      )),
    })
    expect(findExactCitationAnnotation(sidecar.outboxByStatus('pending'), 1, 'ATT1', position)?.id)
      .toBe(exact.id)
    expect(findExactCitationAnnotation(
      sidecar.outboxByStatus('pending'),
      1,
      'ATT1',
      '{"pageIndex":0,"rects":[[72,680,280,700]],"nextPageRects":[[72,41,280,60]]}',
    )).toBeNull()
    sidecar.close()
  })
})

describe('the outbox is the durability boundary', () => {
  test('a queued highlight is safe before anything touches the network', () => {
    const sidecar = store()
    const entry = sidecar.enqueueOutbox({
      itemKey: null,
      libraryId: 1,
      operation: 'create',
      parentItemKey: 'ATT1',
      payload: JSON.stringify(annotationPayload(annotation, 'ATT1')),
    })
    expect(entry.status).toBe('pending')
    expect(sidecar.outboxDue()).toHaveLength(1)
    expect(sidecar.countOutboxWaiting()).toBe(1)
    sidecar.close()
  })

  test('with NO credential nothing is attempted and nothing is lost', async () => {
    const sidecar = store()
    queue(sidecar)
    const report = await drainOutbox(sidecar, null)
    expect(report).toMatchObject({ attempted: 0, skipped: 'no-credential' })
    expect(sidecar.outboxDue()).toHaveLength(1)
    sidecar.close()
  })

  test('it survives a restart — a new store over the same file still owes the write', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wf-outbox-restart-'))
    directories.push(directory)
    const path = join(directory, 'sidecar.sqlite')
    const first = new SidecarStore(createBunSqliteDriver(), path)
    queue(first)
    first.close()

    const second = new SidecarStore(createBunSqliteDriver(), path)
    const due = second.outboxDue()
    expect(due).toHaveLength(1)
    expect(JSON.parse(due[0]!.payload).annotationText).toContain('implicit models')
    second.close()
  })
})

describe('draining', () => {
  test('a confirmed create records the key Zotero assigned', async () => {
    const sidecar = store()
    queue(sidecar)
    const report = await drainOutbox(sidecar, always({ itemKey: 'SERVERKEY', kind: 'confirmed' }))
    expect(report).toMatchObject({ attempted: 1, confirmed: 1 })
    expect(sidecar.outboxDue()).toHaveLength(0)
    expect(sidecar.outboxByStatus('confirmed')[0]?.itemKey).toBe('SERVERKEY')
    expect(sidecar.countOutboxWaiting()).toBe(0)
    sidecar.close()
  })

  test('offline → online: it queues, stays queued, then drains when the network returns', async () => {
    const sidecar = store()
    queue(sidecar, 'A')
    queue(sidecar, 'B')

    const offline: ZoteroWriteTransport = async () => { throw new Error('offline') }
    const first = await drainOutbox(sidecar, offline)
    expect(first).toMatchObject({ attempted: 2, retrying: 2, confirmed: 0 })
    expect(sidecar.outboxDue()).toHaveLength(2)
    expect(sidecar.outboxDue()[0]?.attemptCount).toBe(1)

    const second = await drainOutbox(sidecar, always({ kind: 'confirmed' }))
    expect(second).toMatchObject({ attempted: 2, confirmed: 2 })
    expect(sidecar.outboxDue()).toHaveLength(0)
    sidecar.close()
  })

  test('a rejected write keeps its reason and stops retrying, without blocking the queue', async () => {
    const sidecar = store()
    queue(sidecar, 'A')
    queue(sidecar, 'B')
    let call = 0
    const transport: ZoteroWriteTransport = async () => (
      (call += 1) === 1
        ? { kind: 'rejected', reason: 'The paper this highlight belongs to is no longer in Zotero.' }
        : { kind: 'confirmed' }
    )
    const report = await drainOutbox(sidecar, transport)
    expect(report).toMatchObject({ attempted: 2, confirmed: 1, rejected: 1 })
    const failed = sidecar.outboxByStatus('failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.lastError).toBe('The paper this highlight belongs to is no longer in Zotero.')
    // A failed write is no longer drainable. It remains visible through the
    // separate rejected count so the user can inspect or retry it deliberately.
    expect(sidecar.outboxDue()).toHaveLength(0)
    expect(sidecar.countOutboxWaiting()).toBe(0)
    expect(sidecar.countOutboxRejected()).toBe(1)
    sidecar.retryOutbox(failed[0]!.id)
    expect(sidecar.outboxDue()).toHaveLength(1)
    sidecar.close()
  })

  test('a conflict keeps the losing version rather than dropping it', async () => {
    const sidecar = store()
    queue(sidecar)
    const report = await drainOutbox(sidecar, always({
      kind: 'conflict',
      reason: 'This highlight was edited somewhere else.',
    }))
    expect(report).toMatchObject({ attempted: 1, conflicted: 1 })
    const conflicted = sidecar.outboxByStatus('conflict')
    expect(conflicted).toHaveLength(1)
    // The version that lost is preserved — no data is ever dropped (ADR-0002).
    expect(JSON.parse(conflicted[0]!.conflictPayload!).annotationText).toContain('implicit models')
    expect(conflicted[0]?.lastError).toBe('This highlight was edited somewhere else.')
    sidecar.close()
  })

  test('an unreadable payload fails permanently instead of jamming everything behind it', async () => {
    const sidecar = store()
    sidecar.enqueueOutbox({
      itemKey: null, libraryId: 1, operation: 'create', parentItemKey: 'ATT1', payload: 'not json',
    })
    queue(sidecar, 'GOOD')
    const report = await drainOutbox(sidecar, always({ kind: 'confirmed' }))
    expect(report).toMatchObject({ attempted: 2, confirmed: 1, rejected: 1 })
    expect(sidecar.outboxByStatus('failed')).toHaveLength(1)
    sidecar.close()
  })

  test('the drain is bounded, so a long queue cannot block a session', async () => {
    const sidecar = store()
    for (let index = 0; index < 5; index += 1) queue(sidecar, `A${index}`)
    const report = await drainOutbox(sidecar, always({ kind: 'confirmed' }), 2)
    expect(report.attempted).toBe(2)
    expect(sidecar.outboxDue()).toHaveLength(3)
    sidecar.close()
  })
})

describe('the local write (ADR-0031)', () => {
  const payload = annotationPayload(annotation, 'ATT1')

  test('the API payload maps back onto the local insert with no translation', () => {
    expect(localAnnotationFromPayload(
      { itemKey: 'ANNKEY22', libraryId: 1, parentItemKey: 'ATT1' }, payload,
    )).toEqual({
      color: '#ffd400',
      comment: 'the crux',
      key: 'ANNKEY22',
      libraryId: 1,
      pageLabel: '157',
      parentAttachmentKey: 'ATT1',
      position: '{"pageIndex":156,"rects":[[131.8,274.1,287,283.2]]}',
      sortIndex: '00156|000601|00268',
      tags: ['models'],
      text: 'the implicit models that have generally been used',
      type: 'highlight',
    })
  })

  test('an annotation type Zotero has no number for is not written', () => {
    expect(localAnnotationFromPayload(
      { itemKey: 'ANNKEY22', libraryId: 1, parentItemKey: 'ATT1' },
      { ...payload, annotationType: 'scribble' as SavedAnnotation['type'] },
    )).toBeNull()
  })

  test('a create is written and confirmed under the key the database actually took', async () => {
    const sidecar = store()
    queue(sidecar)
    const inserted: NewZoteroAnnotation[] = []
    const report = await drainOutboxToZotero(sidecar, () => ({
      backupPath: '/tmp/backup.sqlite',
      close() {},
      databasePath: '/tmp/zotero.sqlite',
      insert(input) {
        inserted.push(input)
        // The reader's key was taken, so Zotero got a different one.
        return { itemId: 9_842, key: 'ZOTEROK2', keyReplaced: true }
      },
      kind: 'open',
      schema: { system: 32, userdata: 128 },
    }))
    expect(report).toMatchObject({ attempted: 1, confirmed: 1, skipped: null })
    expect(inserted[0]).toMatchObject({ libraryId: 1, parentAttachmentKey: 'ATT1', type: 'highlight' })
    // ADR-0029 deduplicates the painted union on the key, so the one actually written is recorded.
    expect(sidecar.outboxByStatus('confirmed')[0]?.itemKey).toBe('ZOTEROK2')
    expect(sidecar.countOutboxWaiting()).toBe(0)
    sidecar.close()
  })

  test('Zotero open: nothing attempted, nothing lost, and a sentence for a person', async () => {
    const sidecar = store()
    queue(sidecar)
    const report = await drainOutboxToZotero(sidecar, () => ({
      code: 'zotero-is-open',
      details: ['A Zotero process is running: 4711 zotero'],
      kind: 'refused',
      reason: 'Close Zotero and this highlight will be saved to your library.',
      signals: ['zotero-process-running'],
    }))
    expect(report).toMatchObject({
      attempted: 0,
      skipped: 'zotero-is-open',
      skippedReason: 'Close Zotero and this highlight will be saved to your library.',
    })
    // Still owed, still counted, and therefore still DRAWN (ADR-0029).
    expect(sidecar.outboxDue()).toHaveLength(1)
    expect(sidecar.countOutboxWaiting()).toBe(1)
    sidecar.close()
  })

  test('a schema past the pin refuses rather than guessing, and keeps the highlight', async () => {
    const sidecar = store()
    queue(sidecar)
    const report = await drainOutboxToZotero(sidecar, () => ({
      code: 'schema-drift',
      details: ['userdata: ReadFlex is built for 128, your Zotero database reports 129'],
      kind: 'refused',
      reason: 'Zotero has updated its database since this version of ReadFlex was checked against it, so ReadFlex is not writing to it. Your highlight is saved here and waiting.',
      signals: [],
    }))
    expect(report.skipped).toBe('schema-drift')
    expect(sidecar.outboxDue()).toHaveLength(1)
    sidecar.close()
  })

  test('an insert that throws keeps the highlight with its reason, and stops retrying', async () => {
    const sidecar = store()
    queue(sidecar)
    const report = await drainOutboxToZotero(sidecar, () => ({
      backupPath: '/tmp/backup.sqlite',
      close() {},
      databasePath: '/tmp/zotero.sqlite',
      insert() {
        throw new Error('The document this highlight belongs to is no longer in Zotero, so the highlight was not written.')
      },
      kind: 'open',
      schema: { system: 32, userdata: 128 },
    }))
    expect(report).toMatchObject({ attempted: 1, rejected: 1 })
    const failed = sidecar.outboxByStatus('failed')
    expect(failed[0]?.lastError).toContain('no longer in Zotero')
    // Failed is still unconfirmed, so the mark is still painted — nothing vanishes (ADR-0029).
    expect(sidecar.outboxUnconfirmed()).toHaveLength(1)
    sidecar.close()
  })

  test('an update is kept rather than written: ADR-0031 decides the insert and nothing else', async () => {
    const sidecar = store()
    sidecar.enqueueOutbox({
      itemKey: 'EXISTING2',
      libraryId: 1,
      operation: 'update',
      parentItemKey: 'ATT1',
      payload: JSON.stringify(payload),
    })
    let inserts = 0
    const report = await drainOutboxToZotero(sidecar, () => ({
      backupPath: '/tmp/backup.sqlite',
      close() {},
      databasePath: '/tmp/zotero.sqlite',
      insert() {
        inserts += 1
        return { itemId: 1, key: 'SHOULDNT', keyReplaced: false }
      },
      kind: 'open',
      schema: { system: 32, userdata: 128 },
    }))
    // The insert is never even reached: writing an UPDATE as an INSERT would duplicate the
    // annotation in Zotero, which is worse than not writing it.
    expect(inserts).toBe(0)
    // Kept, not refused: Zotero was never asked, so nothing is counted against it.
    expect(report).toMatchObject({ attempted: 1, keptLocal: 1, rejected: 0, confirmed: 0 })
    const kept = sidecar.outboxUnconfirmed()
    expect(kept).toHaveLength(1)
    expect(kept[0]?.lastError).toContain('not something WriteFlex does yet')
    expect(kept[0]?.localOnly).toBe(1)
    expect(kept[0]?.payload).toBe(JSON.stringify(payload))
    expect(sidecar.countOutboxRejected()).toBe(0)
    expect(sidecar.countOutboxWaiting()).toBe(0)
    sidecar.close()
  })

  test('the private Area quotation update resolves the confirmed create and changes only its comment', async () => {
    const sidecar = store()
    const createPayload = {
      ...annotationPayload({ ...annotation, comment: null, type: 'image' }, 'ATT1'),
      readflexSourceKey: 'READERA7',
    }
    const create = sidecar.enqueueOutbox({
      itemKey: 'READERA7', libraryId: 1, operation: 'create', parentItemKey: 'ATT1',
      payload: JSON.stringify(createPayload),
    })
    sidecar.markOutboxConfirmed(create.id, 'ZOTEROA7')
    sidecar.enqueueOutbox({
      itemKey: 'READERA7', libraryId: 1, operation: 'update', parentItemKey: 'ATT1',
      payload: JSON.stringify(areaQuotationPayload(
        createPayload,
        'READERA7',
        'Quoted in "Draft one" — 1 August 2026',
      )),
    })
    const calls: unknown[] = []
    const report = await drainOutboxToZotero(sidecar, () => ({
      backupPath: '/tmp/backup.sqlite',
      close() {},
      databasePath: '/tmp/zotero.sqlite',
      insert() { throw new Error('must not insert') },
      setImageQuotation(input) { calls.push(input); return { recorded: true } },
      kind: 'open',
      schema: { system: 32, userdata: 129 },
    }))
    expect(report).toMatchObject({ attempted: 1, confirmed: 1 })
    expect(calls).toEqual([{
      comment: 'Quoted in "Draft one" — 1 August 2026',
      key: 'ZOTEROA7',
      libraryId: 1,
      parentAttachmentKey: 'ATT1',
    }])
    sidecar.close()
  })

  test('a retained pre-marker Area resolves by its confirmed canonical key', async () => {
    const sidecar = store()
    const createPayload = annotationPayload({ ...annotation, comment: null, type: 'image' }, 'ATT1')
    const create = sidecar.enqueueOutbox({
      itemKey: 'LEGACYA7', libraryId: 1, operation: 'create', parentItemKey: 'ATT1',
      payload: JSON.stringify(createPayload),
    })
    sidecar.markOutboxConfirmed(create.id, 'LEGACYA7')
    sidecar.enqueueOutbox({
      itemKey: 'LEGACYA7', libraryId: 1, operation: 'update', parentItemKey: 'ATT1',
      payload: JSON.stringify(areaQuotationPayload(
        createPayload,
        'LEGACYA7',
        'Quoted in "Legacy draft" — 1 August 2026',
      )),
    })
    const calls: unknown[] = []
    const report = await drainOutboxToZotero(sidecar, () => ({
      backupPath: '/tmp/backup.sqlite', close() {}, databasePath: '/tmp/zotero.sqlite',
      insert() { throw new Error('must not insert') },
      setImageQuotation(input) { calls.push(input); return { recorded: true } },
      kind: 'open', schema: { system: 32, userdata: 129 },
    }))
    expect(report).toMatchObject({ confirmed: 1, retrying: 0 })
    expect(calls).toHaveLength(1)
    sidecar.close()
  })

  test('the session is closed even when the drain throws — Zotero is never held open', async () => {
    const sidecar = store()
    queue(sidecar)
    let closed = 0
    await drainOutboxToZotero(sidecar, () => ({
      backupPath: '/tmp/backup.sqlite',
      close() { closed += 1 },
      databasePath: '/tmp/zotero.sqlite',
      insert() { throw new Error('anything at all') },
      kind: 'open',
      schema: { system: 32, userdata: 128 },
    }))
    expect(closed).toBe(1)
    sidecar.close()
  })
})

/**
 * The seam that stops the tests consulting the machine (ADR-0031, correction).
 *
 * The proof that matters is the PAIR of behaviours, not either one alone: with the fixture probes
 * injected, "fixture says open" and "fixture says closed" must give DIFFERENT refusals. If the
 * injection ever falls back to the machine defaults, both cases get whatever `pgrep` happens to say
 * on the machine running the suite — the same answer twice — and this fails whichever way that goes.
 * That is what makes it machine-independent, and a single-case assertion would not be.
 */
describe('fixture-scoped liveness probes (ADR-0031, correction)', () => {
  const fixtureEnvironment = (
    extra: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv => ({
    WRITEFLEX_E2E: '1',
    WRITEFLEX_E2E_ZOTERO_DIRECTORY: '/tmp/wf-fixture-library',
    ...extra,
  })

  test('no probes outside the e2e harness — production still asks the machine', () => {
    expect(e2eZoteroLivenessProbes({})).toBeUndefined()
    expect(
      e2eZoteroLivenessProbes({ WRITEFLEX_E2E_ZOTERO_DIRECTORY: '/tmp/wf-fixture-library' }),
    ).toBeUndefined()
  })

  test('no probes without a fixture library — the seam can never speak for his real library', () => {
    expect(e2eZoteroLivenessProbes({ WRITEFLEX_E2E: '1' })).toBeUndefined()
    expect(
      e2eZoteroLivenessProbes({ WRITEFLEX_E2E: '1', WRITEFLEX_E2E_ZOTERO_LIVENESS: 'open' }),
    ).toBeUndefined()
  })

  test('a fixture library reports closed by default and open when told to', () => {
    const closed = e2eZoteroLivenessProbes(fixtureEnvironment())
    expect(closed?.runningZoteroProcesses?.()).toEqual([])
    expect(closed?.processesHoldingDatabase?.('/tmp/wf-fixture-library/zotero.sqlite')).toEqual([])

    const open = e2eZoteroLivenessProbes(
      fixtureEnvironment({ WRITEFLEX_E2E_ZOTERO_LIVENESS: 'open' }),
    )
    expect(open?.runningZoteroProcesses?.()).not.toEqual([])
    expect(open?.processesHoldingDatabase?.('/tmp/wf-fixture-library/zotero.sqlite')).not.toEqual([])
  })

  test('the write session refuses on the fixture’s word, not the machine’s', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wf-liveness-'))
    directories.push(directory)
    const databasePath = join(directory, 'zotero.sqlite')
    // An empty file is enough: the liveness gate runs before the schema is read, so "closed" gets
    // past it and lands on `schema-unreadable` while "open" never reaches the schema at all.
    writeFileSync(databasePath, '')

    const refusalWith = (extra: NodeJS.ProcessEnv): string => {
      const liveness = e2eZoteroLivenessProbes(
        fixtureEnvironment({ WRITEFLEX_E2E_ZOTERO_DIRECTORY: directory, ...extra }),
      )
      const session = openZoteroAnnotationWriteSession(createBunSqliteDriver(), {
        backupDirectory: join(directory, 'backups'),
        databasePath,
        ...(liveness ? { liveness } : {}),
      })
      if (session.kind !== 'refused') {
        session.close()
        return 'opened'
      }
      return session.code
    }

    const toldOpen = refusalWith({ WRITEFLEX_E2E_ZOTERO_LIVENESS: 'open' })
    const toldClosed = refusalWith({})
    expect(toldOpen).toBe('zotero-is-open')
    expect(toldClosed).toBe('schema-unreadable')
    // The load-bearing assertion: the two answers DIFFER. Machine defaults would return the same
    // answer for both, whatever that answer happened to be.
    expect(toldClosed).not.toBe(toldOpen)
  })
})

// ADR-0034 conflicts with the Round 3 brief's frontmatter-first expectation.
test('citation note composition follows the shared heading-first Piece title rule', () => {
  const draft = '---\ntitle: The Radial Category Problem\n---\n\n# A heading the title overrides\n'
  const title = documentTitle(draft, 'draft.md')
  expect(citationAnnotation(annotation, title, new Date('2026-09-04T12:00:00Z')).comment)
    .toBe('Quoted in "A heading the title overrides" — 4 September 2026')
})
