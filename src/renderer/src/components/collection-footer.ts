/** The Folder dashboard's footer count: "1 piece · 9 folders · 3 folder pieces · 303 words". Folders come only when there are some. */
export function collectionFooterText(counts: { pieces: number; folderPieces: number; subfolders: number; words: number }): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  const parts = [plural(counts.pieces, 'piece', 'pieces')]
  if (counts.subfolders > 0) parts.push(plural(counts.subfolders, 'folder', 'folders'))
  parts.push(plural(counts.folderPieces, 'folder piece', 'folder pieces'))
  parts.push(`${counts.words.toLocaleString('en-GB')} words`)
  return parts.join(' · ')
}

/** The Purpose cell of a subfolder row: how many pieces it holds. */
export function subfolderPiecesText(pieces: number): string {
  return `${pieces} ${pieces === 1 ? 'piece' : 'pieces'}`
}
