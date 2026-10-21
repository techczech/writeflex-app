/**
 * The vault sidebar's PINNED section as data (vaults ticket 05, documents added in 0.24): `vault.json` pins
 * + each pin's kind as main read it (the live tree wins when they differ) + the vault index + the folders and documents that exist now -> one row
 * per pin, in pin order. Folders and documents share the one order. Pure; the sidebar draws it and the
 * preload pin operations change the file.
 */
import type { VaultPinKind } from '../../shared/vault'
import type { VaultIndex } from '../../shared/vault-index'

export type PinRow = {
  /** Root-relative POSIX path of the folder or document, as stored in `vault.json`. */
  path: string
  /** What the pin names now: a folder, a document, or nothing (`missing`). */
  kind: VaultPinKind
  /** Folder: the work's title under Titles when it is a work, else the path. Document: its title under
   *  Titles when it has one, else its file name. Missing: the path. */
  label: string
  /** A tooltip in the tree rows' way (the other of title / file name; `mono` for a file name), or null for
   *  the row's plain native title (its path, or `not found`). */
  tip: { text: string; mono: boolean } | null
  /** `58 works`, `Folio · 11 parts`; empty for a document, when missing, or while the index is not loaded. */
  countText: string
  /** Nothing pinnable stands at the path: drawn greyed with `not found` and a Remove button. */
  missing: boolean
  /** The folder is a Folio: it opens as a Folio. */
  folio: boolean
  /** The row offers the hover Unpin button (every row that names something; a missing one has Remove instead). */
  unpinnable: boolean
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * The pin's kind now: the live tree wins over main's reading. The tree is refreshed on every file or folder
 * change and main's reading only when the vault file changes, so a target deleted since shows `not found` at
 * once, one made again shows at once, and one whose kind changed (a document replaced by a folder of that
 * name, or the reverse) shows as what it is now. Main's reading only breaks a tie the tree cannot.
 */
function kindOf(path: string, claimed: VaultPinKind | undefined, folders: ReadonlySet<string>, documents: ReadonlySet<string>): VaultPinKind {
  const folder = folders.has(path)
  const document = documents.has(path)
  if (folder && document) return claimed === 'document' ? 'document' : 'folder'
  if (folder) return 'folder'
  if (document) return 'document'
  return 'missing'
}

export function pinnedRows(input: {
  pins: readonly string[]
  /** Each pin's kind as main read it (VaultView.pinKinds, [path, kind] pairs); the tree wins over it. */
  kinds?: ReadonlyArray<readonly [string, VaultPinKind]>
  index: VaultIndex | null
  /** Every folder that exists in the root (root-relative paths). */
  folders: ReadonlySet<string>
  /** Every Markdown document that exists in the root (root-relative paths). */
  documents?: ReadonlySet<string>
  titles: boolean
}): PinRow[] {
  const { pins, kinds = [], index, folders, documents = new Set<string>(), titles } = input
  const claimed = new Map(kinds)
  return pins.map((path) => {
    const kind = kindOf(path, claimed.get(path), folders, documents)
    const missing = kind === 'missing'
    if (kind === 'document') {
      const name = baseName(path)
      const title = index?.labels[path]
      if (titles && title) return { path, kind, label: title, tip: { text: name, mono: true }, countText: '', missing, folio: false, unpinnable: !missing }
      const tip = title !== undefined && title !== name ? { text: title, mono: false } : null
      return { path, kind, label: name, tip, countText: '', missing, folio: false, unpinnable: !missing }
    }
    const own = index?.works.find((work) => work.path === path)
    const folio = !missing && own?.kind === 'folio'
    let countText = ''
    if (!missing && index) {
      if (folio && own) countText = `Folio · ${plural(own.parts.length, 'part', 'parts')}`
      else {
        const prefix = `${path}/`
        const n = index.works.filter((work) => work.path === path || work.path.startsWith(prefix)).length
        countText = plural(n, 'work', 'works')
      }
    }
    const title = titles && !missing && own && own.kind !== 'file' ? index?.labels[path] : undefined
    return { path, kind, label: title || path, tip: null, countText, missing, folio, unpinnable: !missing }
  })
}

/**
 * The pin order after dropping `path` so it lands before the pin at `beforeIndex` of the current order
 * (`pins.length` = at the end). Null when the order would not change or `path` is not pinned. Folders and
 * documents move alike.
 */
export function movePin(pins: readonly string[], path: string, beforeIndex: number): string[] | null {
  const from = pins.indexOf(path)
  if (from === -1) return null
  const rest = pins.filter((pin) => pin !== path)
  const at = Math.max(0, Math.min(rest.length, beforeIndex > from ? beforeIndex - 1 : beforeIndex))
  const next = [...rest.slice(0, at), path, ...rest.slice(at)]
  return next.every((pin, i) => pin === pins[i]) ? null : next
}
