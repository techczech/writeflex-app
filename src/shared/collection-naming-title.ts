export type CollectionTitleField = 'metadata' | 'heading'

export type CollectionNamingTitle = {
  field: CollectionTitleField
  title: string
  range: { from: number; to: number } | null
}

export type CollectionNamingCandidate = CollectionNamingTitle & { id: number }

export const isUntitledPiece = (name: string): boolean =>
  /^untitled(?:-(?:[2-9]|[1-9][0-9]+))?\.md$/.test(name)
