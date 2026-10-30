/**
 * Zotero collections as the Shelf's filter sees them: pure tree, membership and picker logic shared by
 * the main process (filtering before the row limit) and the renderer (the picker). Ported from
 * ReadFlex's library-collections; nothing here reads or writes anything.
 *
 * Ids are library-qualified (`${libraryId}:${key}`) because a collection key is only unique within one
 * library, and collection NAMES are not unique even within one (two "Methods" under different projects).
 */

export type ShelfCollectionRecord = { key: string; libraryId: number; name: string; parentKey: string | null }

/** The raw read: collections plus the collection keys of each item, keyed `${libraryId}:${itemKey}`. */
export type ShelfCollectionData = {
  collections: ShelfCollectionRecord[]
  itemCollections: Record<string, string[]>
}

/** One collection as it crosses the IPC boundary. */
export type ShelfCollectionNode = {
  /** Library-qualified id. */
  id: string
  name: string
  /** Parent's library-qualified id, or null at the top level. */
  parentId: string | null
  /** Distinct Shelf items in this collection or any collection beneath it. */
  count: number
}

export const collectionId = (libraryId: number, key: string): string => `${libraryId}:${key}`

const recordId = (record: ShelfCollectionRecord): string => collectionId(record.libraryId, record.key)

/** The collection and every collection beneath it. Cycle-safe. */
export function descendantIds(collections: readonly ShelfCollectionRecord[], id: string): Set<string> {
  const result = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const collection of collections) {
      const own = recordId(collection)
      if (
        collection.parentKey
        && result.has(collectionId(collection.libraryId, collection.parentKey))
        && !result.has(own)
      ) {
        result.add(own)
        grew = true
      }
    }
  }
  return result
}

type ItemRef = { itemKey: string; libraryId: number }

function memberIds(item: ItemRef, itemCollections: ShelfCollectionData['itemCollections']): string[] {
  return (itemCollections[`${item.libraryId}:${item.itemKey}`] ?? []).map((key) => collectionId(item.libraryId, key))
}

/** Items in the collection or any collection beneath it. An id that is not a known collection yields
 *  every item: the caller validates the id, and an unknown one means "no filter". */
export function itemsInCollection<T extends ItemRef>(
  items: readonly T[],
  data: ShelfCollectionData,
  id: string | null,
): T[] {
  if (id === null || !data.collections.some((collection) => recordId(collection) === id)) return [...items]
  const wanted = descendantIds(data.collections, id)
  return items.filter((item) => memberIds(item, data.itemCollections).some((member) => wanted.has(member)))
}

/** The collections with distinct-item counts that include each collection's subtree. */
export function collectionNodes(items: readonly ItemRef[], data: ShelfCollectionData): ShelfCollectionNode[] {
  const known = new Set(data.collections.map(recordId))
  const parentOf = new Map<string, string | null>()
  for (const collection of data.collections) {
    const parent = collection.parentKey ? collectionId(collection.libraryId, collection.parentKey) : null
    // An orphan (parent missing) is shown at the top level.
    parentOf.set(recordId(collection), parent && known.has(parent) ? parent : null)
  }
  const counts = new Map<string, number>()
  for (const item of items) {
    const reached = new Set<string>()
    for (const member of memberIds(item, data.itemCollections)) {
      let current: string | null | undefined = member
      while (current && !reached.has(current)) {
        reached.add(current)
        current = parentOf.get(current)
      }
    }
    for (const id of reached) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return data.collections.map((collection) => ({
    count: counts.get(recordId(collection)) ?? 0,
    id: recordId(collection),
    name: collection.name,
    parentId: parentOf.get(recordId(collection)) ?? null,
  }))
}

export type CollectionRow = {
  depth: number
  id: string
  name: string
  /** Names from the top-level collection down to this one, joined with " › ". */
  path: string
  /** Path of the parents only; empty at the top level. */
  parentPath: string
}

const compareNames = (left: string, right: string): number =>
  left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })

/** Collections as an indented depth-first list, alphabetical within each level. */
export function collectionRows(nodes: readonly ShelfCollectionNode[]): CollectionRow[] {
  const children = new Map<string | null, ShelfCollectionNode[]>()
  for (const node of nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
  const rows: CollectionRow[] = []
  const visited = new Set<string>()
  const walk = (parent: string | null, depth: number, parentPath: string): void => {
    const level = [...(children.get(parent) ?? [])].sort(
      (left, right) => compareNames(left.name, right.name) || left.id.localeCompare(right.id),
    )
    for (const node of level) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      const path = parentPath ? `${parentPath} › ${node.name}` : node.name
      rows.push({ depth, id: node.id, name: node.name, parentPath, path })
      walk(node.id, depth + 1, path)
    }
  }
  walk(null, 0, '')
  return rows
}

/** Rows whose path contains every word typed; the full list for an empty needle. */
export function matchCollectionRows(rows: readonly CollectionRow[], needle: string): CollectionRow[] {
  const words = needle.trim().toLocaleLowerCase('en').split(/\s+/u).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const haystack = row.path.toLocaleLowerCase('en')
    return words.every((word) => haystack.includes(word))
  })
}

/** The stored choice if that collection still exists, otherwise null (All collections). */
export function resolveStoredCollection(stored: string | null, nodes: readonly ShelfCollectionNode[]): string | null {
  return stored && nodes.some((node) => node.id === stored) ? stored : null
}

/** An IPC argument as a collection id: the string only when it names a known collection, else null.
 *  The renderer's value is untrusted, so anything else (wrong type, stale, unqualified key) is ignored. */
export function knownCollectionId(raw: unknown, data: ShelfCollectionData): string | null {
  if (typeof raw !== 'string') return null
  return data.collections.some((collection) => recordId(collection) === raw) ? raw : null
}
