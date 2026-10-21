export type DashSortKey = 'title' | 'purpose' | 'status' | 'date' | 'words'
export type DashSort = { key: DashSortKey; dir: 'asc' | 'desc' }

/** One Folder-dashboard row reduced to what ordering needs. `isFolder` covers plain subfolders and folder pieces. */
export type DashEntry<T> = {
  isFolder: boolean
  /** The shown label: title if a work, else the name. */
  label: string
  /** The Purpose cell's text (a subfolder shows its piece count), or null. */
  purpose: string | null
  words?: number
  status: string | null
  /** Modified time in ms, or null when unknown. */
  modified: number | null
  item: T
}

const collate = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

function valueOf<T>(entry: DashEntry<T>, key: DashSortKey): string | number | null {
  const v = key === 'title' ? entry.label : key === 'purpose' ? entry.purpose : key === 'status' ? entry.status : key === 'words' ? entry.words ?? null : entry.modified
  return v === '' ? null : v
}

function compare<T>(a: DashEntry<T>, b: DashEntry<T>, sort: DashSort): number {
  const av = valueOf(a, sort.key)
  const bv = valueOf(b, sort.key)
  if (av === null && bv === null) return collate(a.label, b.label)
  if (av === null) return 1 // empty cells go last in either direction
  if (bv === null) return -1
  const base = typeof av === 'number' && typeof bv === 'number' ? av - bv : collate(String(av), String(bv))
  const signed = sort.dir === 'desc' ? -base : base
  return signed !== 0 ? signed : collate(a.label, b.label)
}

/** The Folder dashboard's order: all folder rows first, then all file rows. The column sort applies within each
 *  group, never across them; rows with no value for the sorted column go last within their group. */
export function orderDashboard<T>(entries: DashEntry<T>[], sort: DashSort): DashEntry<T>[] {
  const sorted = (group: DashEntry<T>[]): DashEntry<T>[] => [...group].sort((a, b) => compare(a, b, sort))
  return [...sorted(entries.filter((e) => e.isFolder)), ...sorted(entries.filter((e) => !e.isFolder))]
}
