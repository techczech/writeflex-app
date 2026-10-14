import { expect, test } from 'bun:test'
import { exportBundleRequest, exportDocumentRequest } from '../../src/main/export-ipc'

test('the document IPC payload carries only validated HTML export options', () => {
  expect(exportDocumentRequest({
    path: 'piece.md',
    format: 'html',
    target: '/tmp/piece.html',
    html: {
      readerNotes: true,
      readerEdits: true,
      sidebar: false,
      titleBlock: true,
      summaryTiles: true,
      design: 'b',
      frontmatterFields: ['date', 'status', 'author', 'purpose', 'tags', 'series'],
    },
  })).toEqual({
    path: 'piece.md',
    format: 'html',
    target: '/tmp/piece.html',
    html: {
      readerNotes: true,
      readerEdits: true,
      sidebar: false,
      titleBlock: true,
      summaryTiles: true,
      design: 'b',
      frontmatterFields: ['date', 'status', 'author', 'purpose', 'tags', 'series'],
    },
  })
})

test('the bundle IPC payload rejects unselected or malformed frontmatter field requests', () => {
  expect(() => exportBundleRequest({
    dir: 'essays',
    format: 'html',
    target: '/tmp/essays.html',
    html: { frontmatterFields: ['status', 'secret-project'] },
  })).toThrow('Invalid HTML export options.')
  expect(() => exportBundleRequest({
    dir: 'essays',
    format: 'html',
    target: '/tmp/essays.html',
    html: { sidebar: 'yes' },
  })).toThrow('Invalid HTML export options.')
})

test('the existing IPC payload remains valid without HTML options', () => {
  expect(exportDocumentRequest({ path: 'piece.md', format: 'docx', target: '/tmp/piece.docx' })).toEqual({
    path: 'piece.md',
    format: 'docx',
    target: '/tmp/piece.docx',
  })
})
