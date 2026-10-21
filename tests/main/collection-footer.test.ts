import { expect, test } from 'bun:test'
import { collectionFooterText, subfolderPiecesText } from '../../src/renderer/src/components/collection-footer'

test('the footer counts subfolders only when there are some', () => {
  expect(collectionFooterText({ pieces: 1, folderPieces: 0, subfolders: 9, words: 303 })).toBe('1 piece · 9 folders · 0 folder pieces · 303 words')
  expect(collectionFooterText({ pieces: 2, folderPieces: 1, subfolders: 0, words: 1200 })).toBe('2 pieces · 1 folder piece · 1,200 words')
  expect(collectionFooterText({ pieces: 0, folderPieces: 0, subfolders: 1, words: 0 })).toBe('0 pieces · 1 folder · 0 folder pieces · 0 words')
})

test('a subfolder row counts its pieces', () => {
  expect(subfolderPiecesText(1)).toBe('1 piece')
  expect(subfolderPiecesText(12)).toBe('12 pieces')
})
