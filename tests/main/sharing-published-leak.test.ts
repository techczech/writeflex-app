// Leaves nothing behind (sharing ticket 03; spec section 8 "What is published", test matrix row
// "Leaves nothing behind"): the HTML-export leak harness, extended for sharing, run on what the
// publisher actually sent to the service (the publish JSON, every request on the wire) and on the
// reader page the service serves. A piece is set up with a canary in every place the spec names:
// file path, collection name, Agent notes, pending changes, version history, comments hidden in the
// Markdown, frontmatter not shown. A link turned off leaves no copy and no pictures.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { Workspace } from '../../src/main/workspace.ts'
import { ChangeStore } from '../../src/main/changes.ts'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import { assertHtmlExportDoesNotLeak, type HtmlExportLeakContext } from '../helpers/html-export-leak-harness.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const COLLECTION = 'Collection Canary Folder'
const PATH = `${COLLECTION}/drafts/piece-canary-name.md`
// A one-pixel PNG, so the copy has a picture to carry.
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 4, 133, 1, 128, 132, 169, 140, 33, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
const PIECE = [
  '---',
  'title: A shared piece',
  'status: drafting',
  'privateField: UNSELECTED_FRONTMATTER_CANARY',
  '---',
  '',
  '# A shared piece',
  '',
  'Public prose that readers see.',
  '',
  '<!-- HIDDEN_COMMENT_CANARY -->',
  '',
  '![a picture](pixel.png)',
  '',
  'A local link [to a file](file:///tmp/example-author/secret.md) and a wikilink [[Other piece]].',
  '',
].join('\n')

test('the published payload and the reader page carry none of what the spec leaves out', async () => {
  const w = await publishWorld({
    files: {
      [PATH]: PIECE,
      [`${COLLECTION}/drafts/pixel.png`]: PNG.toString('latin1'),
      [`${COLLECTION}/agent-notes/review-of-the-piece.md`]: '---\nsourceDocument: drafts/piece-canary-name.md\n---\n\nAGENT_NOTE_CANARY: the second paragraph drags.\n',
      [`${COLLECTION}/Other piece.md`]: '# Other piece\n\nLINKED_PIECE_CANARY\n',
      [`${COLLECTION}/.writeflex/versions/VERSION_RECORD_CANARY.json`]: '{"text":"VERSION_RECORD_CANARY"}',
    },
  })
  // The picture must be its bytes, not latin1 text.
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${w.root}/${COLLECTION}/drafts/pixel.png`, PNG)
  // A pending change to the piece, in the collection's ledger (never accepted).
  await new ChangeStore(new Workspace(w.root)).add({
    path: PATH, provenance: 'agent', editClass: 'insert', category: 'other', summary: 'PENDING_CHANGE_SUMMARY_CANARY',
    oldText: '', newText: 'PENDING_CHANGE_CANARY prose.', insertAfter: '', isCorrection: false,
  })

  const made = await w.publisher.make(w.root, PATH, { name: 'Marta', comments: true })
  expect(made.ok).toBe(true)
  const shareId = made.ok ? made.shareId! : ''
  const [published] = w.publishes()
  expect(published.body.parts[0].html).toContain('Public prose that readers see.')
  expect(published.body.images).toHaveLength(1)
  expect(published.body.parts[0].html).toContain(`/s/${shareId}/images/${published.body.images[0]}`)

  const context: HtmlExportLeakContext = {
    marginNoteTexts: ['HIDDEN_COMMENT_CANARY'],
    sourceFrontmatter: { title: 'A shared piece', status: 'drafting', privateField: 'UNSELECTED_FRONTMATTER_CANARY' },
    selectedFrontmatterFields: ['title', 'status'],
    workspaceRoot: w.root,
    machineHostname: hostname(),
    versionRecordMarkers: ['VERSION_RECORD_CANARY'],
    diarySessionMarkers: [],
    collectionProvenanceMarkers: ['LINKED_PIECE_CANARY'],
    agentNoteTexts: ['AGENT_NOTE_CANARY'],
    pendingChangeTexts: ['PENDING_CHANGE_CANARY', 'PENDING_CHANGE_SUMMARY_CANARY'],
    collectionName: COLLECTION,
    filePaths: [PATH, 'piece-canary-name', 'drafts/', `${w.root}/${PATH}`],
    // The service's own reader page runs the notes script on a link with comments on; the payload has none.
    annotationEnabled: false,
  }
  // The payload as sent, and everything else the publisher put on the wire to the service.
  assertHtmlExportDoesNotLeak(JSON.stringify(published.body), context)
  assertHtmlExportDoesNotLeak(w.serviceCalls().map((entry) => `${entry.url}\n${entry.body}`).join('\n'), context)
  // What a reader gets.
  const page = await w.readerPage(shareId)
  expect(page.status).toBe(200)
  assertHtmlExportDoesNotLeak(page.text, { ...context, annotationEnabled: true, editEnabled: true })
  expect(page.text).toContain('Made with WriteFlex')

  // Link off: no copy and no pictures are left at the service.
  expect((await w.publisher.turnOff(shareId))?.ok).toBe(true)
  const base = w.setup.serviceAccess()!.base
  expect((await w.fake.serviceFetch(`${base}/s/${shareId}`)).status).toBe(404)
  expect((await w.fake.serviceFetch(`${base}/s/${shareId}/images/${published.body.images[0]}`)).status).toBe(404)
  const tables = w.svc.shares.states.get(shareId)!.db
  expect(tables.query('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 0 })
  expect(tables.query('SELECT COUNT(*) AS n FROM page_chunks').get()).toEqual({ n: 0 })
})

test('a byte-order mark before a hidden comment: the comment reaches neither the payload, the wire nor the reader page', async () => {
  for (const text of ['﻿<!--\n# SECRET\n-->\n\n# Public\n', '﻿// SECRET\n# Public\n']) {
    const w = await publishWorld({ files: { [PATH]: text } })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    expect(made.ok).toBe(true)
    const shareId = made.ok ? made.shareId! : ''
    const [published] = w.publishes()
    expect(published.body.title).toBe('Public')
    const context: HtmlExportLeakContext = {
      marginNoteTexts: ['SECRET'],
      sourceFrontmatter: {},
      selectedFrontmatterFields: [],
      workspaceRoot: w.root,
      machineHostname: hostname(),
      versionRecordMarkers: [],
      diarySessionMarkers: [],
      collectionProvenanceMarkers: [],
      collectionName: COLLECTION,
      filePaths: [PATH, 'piece-canary-name', 'drafts/', `${w.root}/${PATH}`],
      annotationEnabled: false,
    }
    assertHtmlExportDoesNotLeak(JSON.stringify(published.body), context)
    assertHtmlExportDoesNotLeak(w.serviceCalls().map((entry) => `${entry.url}\n${entry.body}`).join('\n'), context)
    const page = await w.readerPage(shareId)
    expect(page.status).toBe(200)
    assertHtmlExportDoesNotLeak(page.text, { ...context, annotationEnabled: true, editEnabled: true })
  }
})

// Sharing ticket 09: the same harness on a Folio payload. Every part keeps every rule of a shared
// piece; a part with Agent notes, hidden comments (a byte-order mark before one included), a widget, a
// local link and a pending change; a part missing on disk; an entry outside the Folio and an Agent note
// listed in the manifest (never read); the Index Note's body (only its title and chips go out).
test('a Folio: the payload, the wire and the reader page carry none of what the spec leaves out, for every part', async () => {
  const FOLIO = `${COLLECTION}/Folio canary folder`
  const PART_ONE = `${FOLIO}/contents/part-one-canary-name.md`
  const PART_TWO = `${FOLIO}/contents/part-two-canary-name.md`
  const GONE = `${FOLIO}/contents/Assessment and reading lists.md`
  const w = await publishWorld({
    files: {
      [`${FOLIO}/_report-structure.json`]: JSON.stringify({
        content_root: 'contents',
        files: [
          { path: 'part-one-canary-name.md' },
          { path: 'Assessment and reading lists.md' },
          { path: 'part-two-canary-name.md' },
          { path: '../../Outside canary piece.md' },
          { path: 'agent-notes/review-of-part-one.md' },
        ],
      }),
      [`${FOLIO}/_Folio canary folder_INDEX.md`]: '---\ntitle: Teaching notes, autumn term\nprivateField: INDEX_FRONTMATTER_CANARY\n---\n\n# Teaching notes\n\nINDEX_BODY_CANARY\n',
      [PART_ONE]: PIECE.replace('# A shared piece', '# Part one'),
      [PART_TWO]: [
        '﻿<!--\n# HIDDEN_BOM_COMMENT_CANARY\n-->',
        '',
        '# Part two',
        '',
        'Part two prose.',
        '',
        '// POSTIT_COMMENT_CANARY',
        '',
        '[Simulation: widgets/secret-widget-canary.html]',
        '',
        'A [relative link](../private/relative-link-canary.md) and a [web link](https://example.com/page).',
        '',
      ].join('\n'),
      [`${FOLIO}/contents/pixel.png`]: PNG.toString('latin1'),
      [`${FOLIO}/contents/agent-notes/review-of-part-one.md`]: '---\nsourceDocument: part-one-canary-name.md\n---\n\nAGENT_NOTE_CANARY: the second paragraph drags.\n',
      [`${COLLECTION}/Outside canary piece.md`]: '# OUTSIDE_TITLE_CANARY\n\nLINKED_PIECE_CANARY\n',
      [`${COLLECTION}/Other piece.md`]: '# Other piece\n\nLINKED_PIECE_CANARY\n',
      [`${FOLIO}/.writeflex/versions/VERSION_RECORD_CANARY.json`]: '{"text":"VERSION_RECORD_CANARY"}',
    },
  })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${w.root}/${FOLIO}/contents/pixel.png`, PNG)
  await new ChangeStore(new Workspace(w.root)).add({
    path: PART_TWO, provenance: 'agent', editClass: 'insert', category: 'other', summary: 'PENDING_CHANGE_SUMMARY_CANARY',
    oldText: '', newText: 'PENDING_CHANGE_CANARY prose.', insertAfter: '', isCorrection: false,
  })

  const made = await w.publisher.make(w.root, FOLIO, { name: 'Reading pack', comments: true }, 'folio')
  expect(made.ok).toBe(true)
  const shareId = made.ok ? made.shareId! : ''
  const [published] = w.publishes()
  expect(published.body.kind).toBe('folio')
  expect(published.body.title).toBe('Teaching notes, autumn term')
  expect(published.body.parts.map((entry) => [entry.title, entry.missing === true])).toEqual([['Part one', false], ['Assessment and reading lists', true], ['Part two', false]])
  expect(published.body.parts[0].html).toContain('Public prose that readers see.')
  expect(published.body.parts[2].html).toContain('Part two prose.')
  expect(published.body.parts[2].html).toContain('Interactive part not shared')
  expect(published.body.parts[2].html).toContain('https://example.com/page')
  expect(published.body.images).toHaveLength(1)

  const context: HtmlExportLeakContext = {
    marginNoteTexts: ['HIDDEN_COMMENT_CANARY', 'HIDDEN_BOM_COMMENT_CANARY', 'POSTIT_COMMENT_CANARY'],
    sourceFrontmatter: { title: 'A shared piece', status: 'drafting', privateField: 'UNSELECTED_FRONTMATTER_CANARY', indexField: 'INDEX_FRONTMATTER_CANARY' },
    selectedFrontmatterFields: ['title', 'status'],
    workspaceRoot: w.root,
    machineHostname: hostname(),
    versionRecordMarkers: ['VERSION_RECORD_CANARY'],
    diarySessionMarkers: [],
    collectionProvenanceMarkers: ['LINKED_PIECE_CANARY', 'OUTSIDE_TITLE_CANARY', 'Outside canary piece', 'INDEX_BODY_CANARY'],
    agentNoteTexts: ['AGENT_NOTE_CANARY', 'review-of-part-one'],
    pendingChangeTexts: ['PENDING_CHANGE_CANARY', 'PENDING_CHANGE_SUMMARY_CANARY'],
    collectionName: COLLECTION,
    filePaths: [
      PART_ONE, PART_TWO, GONE, 'part-one-canary-name', 'part-two-canary-name', 'Folio canary folder', 'contents/', `${w.root}/${PART_ONE}`,
      'secret-widget-canary', 'relative-link-canary', '_report-structure', '_INDEX',
    ],
    annotationEnabled: false,
  }
  assertHtmlExportDoesNotLeak(JSON.stringify(published.body), context)
  assertHtmlExportDoesNotLeak(w.serviceCalls().map((entry) => `${entry.url}\n${entry.body}`).join('\n'), context)
  const page = await w.readerPage(shareId)
  expect(page.status).toBe(200)
  assertHtmlExportDoesNotLeak(page.text, { ...context, annotationEnabled: true, editEnabled: true })
  expect(page.text).toContain('This part is not available.')
  expect(page.text).toContain('Made with WriteFlex')

  // Link off: no copy and no pictures are left at the service.
  expect((await w.publisher.turnOff(shareId))?.ok).toBe(true)
  const base = w.setup.serviceAccess()!.base
  expect((await w.fake.serviceFetch(`${base}/s/${shareId}`)).status).toBe(404)
  const tables = w.svc.shares.states.get(shareId)!.db
  expect(tables.query('SELECT COUNT(*) AS n FROM images').get()).toEqual({ n: 0 })
  expect(tables.query('SELECT COUNT(*) AS n FROM page_chunks').get()).toEqual({ n: 0 })
})
