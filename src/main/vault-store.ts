/**
 * The vault store: everything main knows and does about a Collection root's `.writeflex/vault.json`.
 *
 * - `read()` tells whether the root is a vault and what its settings are, with defaults for anything
 *   missing. Reading never creates anything (ADR-0008 / ADR-0034: no file written by mere presence).
 * - `create(input)` writes the file once; it refuses when anything already stands at that name.
 * - `addPin` / `removePin` / `reorderPins` read the file as it is on disk at that moment, apply the one
 *   change, and write it back by the checked whole-file write, saying what the file must still hold.
 *   When another writer got in between (file sync bringing a change from another Mac), the operation is
 *   applied again onto the newer content, so neither change is lost.
 * - `save(settings, baseHash)` replaces the known fields only when the file still has the hash the
 *   renderer read; otherwise it writes nothing and answers `changed`.
 * - Unknown keys in the file are kept on every write, in their place. A value carried over that JSON
 *   numbers cannot hold exactly (`9007199254740993`, `1e400`, a key written twice) refuses the write
 *   (`refused`, naming the key) rather than change it (lossless-json.ts).
 * - A pin names a folder or a Markdown document (`.md`, a regular file) inside the root, never the root
 *   itself, never anything in `.writeflex/` or in any folder the workspace listing hides, never through a
 *   link that leads outside the root (checked link by link, without looking past an escaping link). Every
 *   view tells each pin's kind as read from disk (`pinKinds`: [path, folder | document | missing] pairs).
 * - Pins are stored in their spelling on disk and compared as the disk compares names:
 *   Unicode-normalised, and case-folded on a volume that ignores case (probed once per root).
 * - A write answers success only after the checked write returned without throwing.
 * - A file that is not a JSON object reads as defaults with `unreadable: true`; no pin operation or
 *   create writes over it, and a save does only when told to overwrite it.
 * - `noticeDiskChange()` is called by the workspace watcher when the file's name was touched; it reads
 *   the file and tells the listeners (`onVaultChanged`) only when the bytes differ from the last ones
 *   this store wrote or told, so the app's own writes never come back as outside changes. Own writes
 *   are told too, with `outside: false`, so every window on the root shows them.
 *
 * One store per root (`vaultStoreFor`), so every window on a root shares its queue and its memory of
 * the last bytes. Every read and write runs on that queue.
 */
import { createHash } from 'node:crypto'
import { realpath as realpathCallback } from 'node:fs'
import { lstat, readlink, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { pausedMessage } from './collection-write-gate'
import { isListedPath } from './document-path'
import { readStoreFile, StoreFileChanged, StoreFileExists, StoreWriteRefused, writeStoreFile, type StoreFileStamp } from './checked-store-write'
import { firstLossyCarriedKey } from './lossless-json'
import {
  checkSettingsInput,
  defaultVaultSettings,
  normalisePinPath,
  PIN_DOCUMENT_EXTENSION,
  settingsFromRaw,
  type VaultChangedEvent,
  type VaultCreateInput,
  type VaultPinKind,
  type VaultSettings,
  type VaultView,
  type VaultWriteResult,
} from '../shared/vault'

export const VAULT_FILE_REL = '.writeflex/vault.json'

/** How many times a pin operation is applied again after another writer changed the file under it. */
const PIN_RETRIES = 3

type Disk =
  | { state: 'absent' }
  | { state: 'refused'; where: 'folder' | 'file'; message: string }
  /** `stamp`: as read from disk; null for the bytes this store has just written (never a write's base). */
  | { state: 'present'; bytes: Buffer; stamp: StoreFileStamp | null; hash: string; raw: Record<string, unknown> | null }

const hashOf = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** The memory key of what is on disk: the content hash, or the reason there is none. */
function stamp(disk: Disk): string {
  if (disk.state === 'present') return disk.hash
  if (disk.state === 'refused') return `refused:${disk.where}`
  return 'absent'
}

function parseRaw(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const serialise = (raw: Record<string, unknown>): string => `${JSON.stringify(raw, null, 2)}\n`

/** The operating system's own realpath(3): on macOS it answers with the name's spelling on disk. */
const realpathNative = promisify(realpathCallback.native)

type Listener = (root: string, event: VaultChangedEvent) => void
const listeners = new Set<Listener>()

/** Every change to any root's vault file, own or outside. Returns the unsubscribe. */
export function onVaultChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const refusal = (reason: Exclude<VaultWriteResult, { ok: true }>['reason'], message: string, vault?: VaultView | null): VaultWriteResult =>
  vault === undefined ? { ok: false, reason, message } : { ok: false, reason, message, vault }

export class VaultStore {
  #queue: Promise<unknown> = Promise.resolve()
  /** The stamp of the bytes this store last wrote or told; undefined until the first look. */
  #told: string | undefined

  constructor(readonly root: string) {}

  #run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(op, op)
    this.#queue = next.catch(() => undefined)
    return next
  }

  get #folderName(): string {
    return basename(this.root) || this.root
  }

  async #fresh(): Promise<Disk> {
    const read = await readStoreFile(this.root, VAULT_FILE_REL)
    if (read.state !== 'present') return read
    return { state: 'present', bytes: read.bytes, stamp: read.stamp, hash: hashOf(read.bytes), raw: parseRaw(read.bytes) }
  }

  /** What the renderer sees for `disk`; null when the root is not a vault. Each pin's kind is read from disk. */
  async #view(disk: Disk): Promise<VaultView | null> {
    if (disk.state === 'absent') return null
    // A `.writeflex` that is a link is not this folder's own store: no vault is read through it.
    if (disk.state === 'refused') return disk.where === 'folder' ? null : { settings: defaultVaultSettings(this.#folderName), pinKinds: [], unreadable: true, hash: stamp(disk) }
    const settings = disk.raw ? settingsFromRaw(disk.raw, this.#folderName) : defaultVaultSettings(this.#folderName)
    // Pairs, not an object: a pin named `__proto__` must be an entry, not a prototype assignment.
    const pinKinds: Array<[string, VaultPinKind]> = []
    for (const pin of settings.pins) {
      const target = await this.#pinTarget(pin)
      pinKinds.push([pin, target.ok ? target.kind : 'missing'])
    }
    return { settings, pinKinds, unreadable: disk.raw === null, hash: disk.hash }
  }

  async #tell(disk: Disk, outside: boolean): Promise<void> {
    this.#told = stamp(disk)
    const event: VaultChangedEvent = { vault: await this.#view(disk), outside }
    for (const listener of listeners) {
      try {
        listener(this.root, event)
      } catch {
        // A listener's failure (a closed window) never undoes or blocks the write.
      }
    }
  }

  /** The vault for this root, or null when it is not one. Writes nothing. */
  read(): Promise<VaultView | null> {
    return this.#run(async () => {
      const disk = await this.#fresh()
      this.#told ??= stamp(disk)
      return this.#view(disk)
    })
  }

  /** Called when the watcher saw the file's name touched: tells listeners only of bytes not yet told. */
  noticeDiskChange(): Promise<boolean> {
    return this.#run(async () => {
      const disk = await this.#fresh()
      if (stamp(disk) === this.#told) return false
      await this.#tell(disk, true)
      return true
    })
  }

  /**
   * Write `raw` over what `disk` holds (or create it), then tell every window. A value carried over
   * from the file that JSON numbers cannot hold exactly refuses the write. Success is answered only
   * after the checked write returned; its errors are thrown to the caller, which makes them refusals.
   */
  async #write(raw: Record<string, unknown>, disk: Disk, mode: 'create' | 'replace'): Promise<VaultWriteResult> {
    const paused = pausedMessage(this.root)
    if (paused) return refusal('refused', paused)
    if (disk.state === 'present' && disk.raw) {
      const lossy = firstLossyCarriedKey(disk.bytes.toString('utf8'), disk.raw, raw)
      if (lossy !== null) return refusal('refused', lossyMessage(lossy), await this.#view(disk))
    }
    if (disk.state === 'present' && !disk.stamp) throw new Error('vault store: a write must be based on a version read from disk.')
    const content = serialise(raw)
    await writeStoreFile(this.root, VAULT_FILE_REL, content, {
      mode,
      expect: disk.state === 'present' ? { bytes: disk.bytes, stamp: disk.stamp! } : null,
    })
    const bytes = Buffer.from(content, 'utf8')
    const written: Disk = { state: 'present', bytes, stamp: null, hash: hashOf(bytes), raw }
    await this.#tell(written, false)
    return { ok: true, vault: (await this.#view(written))! }
  }

  /** Why the file on disk may not be the base of a pin operation, or null when it may. */
  async #pinBlocker(disk: Disk): Promise<VaultWriteResult | null> {
    if (disk.state === 'absent') return refusal('not-a-vault', 'This folder is not a vault yet.', null)
    if (disk.state === 'refused') return refusal('refused', disk.message, await this.#view(disk))
    if (disk.raw === null) return refusal('unreadable', 'The vault settings file could not be read, so it was left as it is.', await this.#view(disk))
    return newerVersion(disk.raw) ? refusal('refused', NEWER, await this.#view(disk)) : null
  }

  /** Read fresh, apply `change` onto the raw object, write; applied again when the file changed meanwhile. */
  #pinOperation(change: (pins: string[], raw: Record<string, unknown>, disk: Disk) => Promise<string[] | VaultWriteResult>): Promise<VaultWriteResult> {
    return this.#run(async () => {
      for (let attempt = 0; ; attempt += 1) {
        const disk = await this.#fresh()
        const blocked = await this.#pinBlocker(disk)
        if (blocked) return blocked
        const raw = (disk as Extract<Disk, { state: 'present' }>).raw!
        const current = settingsFromRaw(raw, this.#folderName).pins
        const next = await change([...current], raw, disk)
        if (!Array.isArray(next)) return next
        if (next.length === current.length && next.every((pin, index) => pin === current[index])) {
          return { ok: true, vault: (await this.#view(disk))! }
        }
        try {
          return await this.#write({ ...raw, pins: next }, disk, 'replace')
        } catch (error) {
          if (error instanceof StoreFileChanged && attempt < PIN_RETRIES) continue
          return writeFailure(error, await this.#view(await this.#fresh()))
        }
      }
    })
  }

  /** Make this root a vault: one write of the whole file. Refuses when anything is already there. */
  create(input?: VaultCreateInput): Promise<VaultWriteResult> {
    return this.#run(async () => {
      const checked = checkSettingsInput(input)
      if (!checked.ok) return refusal('invalid', checked.message)
      const disk = await this.#fresh()
      if (disk.state === 'present') return refusal('exists', 'This folder is already a vault.', await this.#view(disk))
      if (disk.state === 'refused') return refusal('refused', disk.message)
      if (checked.fields.pins !== undefined) {
        const pins = await this.#canonicalPins(checked.fields.pins, [])
        if (!pins.ok) return refusal('invalid', pins.message)
        checked.fields.pins = pins.pins
      }
      const settings: VaultSettings = { ...defaultVaultSettings(this.#folderName), ...checked.fields, version: 1 }
      try {
        return await this.#write({ ...settings }, disk, 'create')
      } catch (error) {
        return writeFailure(error, await this.#view(await this.#fresh()))
      }
    })
  }

  /**
   * Pin a folder or a Markdown document: an existing directory, or a regular `.md` file, inside the root,
   * not already pinned. Stored in its spelling on disk (the real path relative to the root's real path),
   * so `Reports` typed as `reports` on a case-insensitive disk, or `café` typed decomposed, is one entry
   * and is pinned once.
   */
  addPin(path: unknown): Promise<VaultWriteResult> {
    const normal = normalisePinPath(path)
    if (!normal.ok) return Promise.resolve(refusal('invalid', normal.message))
    return this.#pinOperation(async (pins) => {
      const target = await this.#pinTarget(normal.path)
      if (!target.ok) return refusal('invalid', target.message)
      const key = await this.#pinKey()
      if (pins.some((pin) => key(pin) === key(target.path))) return refusal('invalid', `${normal.path} is already pinned.`)
      return [...pins, target.path]
    })
  }

  /** Unpin a folder or document (matched as the disk matches names). A pin already gone (removed on another Mac) is not an error. */
  removePin(path: unknown): Promise<VaultWriteResult> {
    const normal = normalisePinPath(path)
    if (!normal.ok) return Promise.resolve(refusal('invalid', normal.message))
    return this.#pinOperation(async (pins) => {
      const key = await this.#pinKey()
      return pins.filter((pin) => key(pin) !== key(normal.path))
    })
  }

  /**
   * Put the pins in `order`. Applied onto the file as it is now: names in `order` no longer pinned are
   * skipped, and pins not in `order` (added on another Mac meanwhile) keep their place after the rest.
   */
  reorderPins(order: unknown): Promise<VaultWriteResult> {
    if (!Array.isArray(order)) return Promise.resolve(refusal('invalid', 'The new order must be a list of pinned folders and documents.'))
    const asked: string[] = []
    for (const entry of order) {
      const normal = normalisePinPath(entry)
      if (!normal.ok) return Promise.resolve(refusal('invalid', normal.message))
      asked.push(normal.path)
    }
    return this.#pinOperation(async (pins) => {
      const key = await this.#pinKey()
      // Each asked name stands for the stored pin it matches; the stored spelling is kept.
      const wanted: string[] = []
      for (const name of asked) {
        const pin = pins.find((stored) => key(stored) === key(name))
        if (pin !== undefined && !wanted.includes(pin)) wanted.push(pin)
      }
      return [...wanted, ...pins.filter((pin) => !wanted.includes(pin))]
    })
  }

  /**
   * Replace the known fields with `settings`, only when the file still has `baseHash`. A file that
   * could not be read is replaced only with `overwriteUnreadable` (no UI passes it in this release).
   */
  save(settings: unknown, baseHash: unknown, options: { overwriteUnreadable?: boolean } = {}): Promise<VaultWriteResult> {
    return this.#run(async () => {
      const checked = checkSettingsInput(settings)
      if (!checked.ok) return refusal('invalid', checked.message)
      if (typeof baseHash !== 'string') return refusal('invalid', 'A save must say which version of the settings it was made from.')
      const disk = await this.#fresh()
      if (disk.state === 'absent') return refusal('not-a-vault', 'This folder is not a vault yet.', null)
      if (disk.state === 'refused') return refusal('refused', disk.message, await this.#view(disk))
      if (disk.hash !== baseHash) return refusal('changed', 'The vault settings were changed elsewhere since they were read.', await this.#view(disk))
      if (disk.raw === null && options.overwriteUnreadable !== true) {
        return refusal('unreadable', 'The vault settings file could not be read, so it was left as it is.', await this.#view(disk))
      }
      if (disk.raw && newerVersion(disk.raw)) return refusal('refused', NEWER, await this.#view(disk))
      if (checked.fields.pins !== undefined) {
        const kept = disk.raw ? settingsFromRaw(disk.raw, this.#folderName).pins : []
        const pins = await this.#canonicalPins(checked.fields.pins, kept)
        if (!pins.ok) return refusal('invalid', pins.message, await this.#view(disk))
        checked.fields.pins = pins.pins
      }
      const raw: Record<string, unknown> = disk.raw ? { ...disk.raw } : {}
      if (raw.version === undefined) raw.version = 1
      Object.assign(raw, checked.fields)
      try {
        return await this.#write(raw, disk, 'replace')
      } catch (error) {
        return writeFailure(error, await this.#view(await this.#fresh()))
      }
    })
  }

  /**
   * The pins a create or whole save asked for, held to addPin's rule: each an existing folder or `.md`
   * document inside the root (real-path containment), stored in its spelling on disk, and one pin per
   * entry as the disk tells names apart (a later spelling of one already listed is dropped). An entry
   * that fails refuses the whole write, its message naming it. One exception: a pin already in the file
   * (`kept`, matched as the disk matches names) whose target is now missing (`#pinTarget`'s sense: gone,
   * in a hidden folder, or behind a link that leaves the root) stays as the file has it, so a save does
   * not drop the "not found" rows the sidebar shows; a missing target is never added.
   */
  async #canonicalPins(asked: string[], kept: string[]): Promise<{ ok: true; pins: string[] } | { ok: false; message: string }> {
    const key = await this.#pinKey()
    const pins: string[] = []
    const seen = new Set<string>()
    for (const entry of asked) {
      const target = await this.#pinTarget(entry)
      let pin: string
      if (target.ok) pin = target.path
      else {
        const stored = target.missing ? kept.find((existing) => key(existing) === key(entry)) : undefined
        if (stored === undefined) return { ok: false, message: target.message }
        pin = stored
      }
      if (seen.has(key(pin))) continue
      seen.add(key(pin))
      pins.push(pin)
    }
    return { ok: true, pins }
  }

  /**
   * The folder or Markdown document `rel` (a normalised pin path) names, as its root-relative POSIX path
   * spelled as on disk; or why it cannot be pinned. `missing`: the sidebar cannot show anything at that
   * name (nothing stands there, it lies in a folder the listing hides, or it is reached through a link
   * that does not lead inside the root); a pin already stored stays on a save, a new one is refused.
   *
   * Containment is checked segment by segment from the root's real path, never by resolving the whole
   * path first: each segment is lstat'ed, and a link is followed ONE hop at a time, with realpath(3)
   * semantics. A hop's text is read with readlink and its components are put in front of the ones still
   * to walk; an absolute target must name the root (its real path, or the path the vault was opened by)
   * by its spelling, checked BEFORE anything there is looked at; a '..' pops one segment off the walked,
   * link-free path, and popping above the root leaves it. Every component must exist, and one with more
   * to follow must be a folder. A hop that leaves the root, a dangling hop, or more than `MAX_LINK_HOPS` hops
   * give ONE refusal, the same whether or not anything exists out there, and no filesystem call is ever
   * made on an outside path. A renderer cannot use a pin request, or a stored pin read on every view, to
   * learn what exists outside the vault.
   *
   * The real path's shape is checked again (a link into `.writeflex/` is refused), and it must be one
   * the workspace listing shows (document-path.ts `isListedPath`), so a pin is never accepted that the
   * sidebar would draw as "not found".
   */
  async #pinTarget(rel: string): Promise<{ ok: true; path: string; kind: Exclude<VaultPinKind, 'missing'> } | { ok: false; message: string; missing: boolean }> {
    const notHere = `${rel} is not a folder or Markdown document in this vault.`
    const throughLink = `${rel} goes through a link that does not lead to a folder or document inside this vault.`
    try {
      const realRoot = await realpathNative(this.root)
      const givenRoot = resolve(this.root)
      const inside = (path: string): boolean => path === realRoot || path.startsWith(`${realRoot}${sep}`)
      // Path components of a link's text: empty and '.' components are no-ops; '..' is kept in place.
      const components = (text: string): string[] => text.split(sep).filter((part) => part !== '' && part !== '.')
      // An absolute link target must name the root by a literal prefix of components: its real path, or
      // the path the vault was opened by (its real path is `realRoot`, so an absolute link spelled through
      // a linked prefix such as macOS /var -> /private/var still resolves). Anything else lies outside.
      const roots = [components(realRoot), components(givenRoot)]
      const belowRoot = (parts: string[]): string[] | null => {
        for (const base of roots) {
          if (parts.length >= base.length && base.every((part, i) => parts[i] === part)) return parts.slice(base.length)
        }
        return null
      }
      // realpath(3) semantics: components are taken in order; a link's target components are put in
      // front of the rest; '..' pops one segment off `current`, which is always resolved and link-free;
      // every component must exist, and every one with more to follow must be a folder.
      const pending = rel.split('/')
      let current = realRoot
      let hops = 0
      while (pending.length > 0) {
        const segment = pending.shift() as string
        if (segment === '..') {
          // Only a link's text carries '..' (a pin path is normalised); popping above the root leaves it.
          if (current === realRoot) return { ok: false, message: throughLink, missing: true }
          current = dirname(current)
          continue
        }
        const next = join(current, segment)
        let entry: Awaited<ReturnType<typeof lstat>>
        try {
          entry = await lstat(next)
        } catch (error) {
          if (hops > 0) return { ok: false, message: throughLink, missing: true }
          return { ok: false, message: notHere, missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }
        }
        if (!entry.isSymbolicLink()) {
          if (pending.length > 0 && !entry.isDirectory()) {
            if (hops > 0) return { ok: false, message: throughLink, missing: true }
            return { ok: false, message: notHere, missing: false }
          }
          current = next
          continue
        }
        hops += 1
        if (hops > MAX_LINK_HOPS) return { ok: false, message: throughLink, missing: true }
        let text: string
        try {
          text = await readlink(next)
        } catch {
          return { ok: false, message: throughLink, missing: true }
        }
        // Nothing at the target is touched here: an absolute target is checked against the root by its
        // spelling alone; a relative one continues from `current`, the link's folder (inside, link-free),
        // and any '..' in it is checked against the root as it is reached.
        if (isAbsolute(text)) {
          const below = belowRoot(components(text))
          if (below === null) return { ok: false, message: throughLink, missing: true }
          pending.unshift(...below)
          current = realRoot
        } else {
          pending.unshift(...components(text))
        }
      }
      // Every link on the way was followed and checked, so `current` holds none: this only spells the path as on disk.
      const real = await realpathNative(current)
      if (real === realRoot) return { ok: false, message: 'The vault folder itself cannot be pinned.', missing: false }
      if (!inside(real)) return { ok: false, message: throughLink, missing: true }
      const path = relative(realRoot, real).split(sep).join('/')
      const shape = normalisePinPath(path)
      if (!shape.ok) return { ok: false, message: shape.message, missing: false }
      const info = await stat(real)
      let kind: Exclude<VaultPinKind, 'missing'>
      if (info.isDirectory()) kind = 'folder'
      else if (info.isFile() && PIN_DOCUMENT_EXTENSION.test(real)) kind = 'document'
      else return { ok: false, message: `${rel} is not a folder or a Markdown (.md) document, so it cannot be pinned.`, missing: false }
      if (!isListedPath(path, kind === 'folder' ? 'folder' : 'file')) {
        return { ok: false, message: `${rel} is inside a hidden folder the sidebar does not show, so it cannot be pinned.`, missing: true }
      }
      return { ok: true, path, kind }
    } catch {
      return { ok: false, message: notHere, missing: false }
    }
  }

  #caseInsensitive: Promise<boolean> | undefined

  /** Does this root's volume ignore case in names? Probed once per root, without writing; shared with the vault watcher. */
  ignoresCase(): Promise<boolean> {
    this.#caseInsensitive ??= volumeIgnoresCase(this.root)
    return this.#caseInsensitive
  }

  /** How the disk tells two pin names apart: Unicode-normalised always, case-folded when the volume ignores case. */
  async #pinKey(): Promise<(pin: string) => string> {
    const fold = await this.ignoresCase()
    return (pin) => (fold ? pin.normalize('NFC').toLowerCase().normalize('NFC') : pin.normalize('NFC'))
  }
}

/** Loop guard for `#pinTarget`'s hop-by-hop walk (the usual SYMLOOP_MAX order). */
const MAX_LINK_HOPS = 40

const NEWER = 'The vault settings file was written by a newer WriteFlex, so this version leaves it as it is.'

const lossyMessage = (key: string): string =>
  `The vault settings file holds a value under "${key}" that this version of WriteFlex cannot write back exactly (for example a very large or very precise number, or a key written twice), so the file was left as it is.`

/**
 * Does the volume holding `root` ignore case in names? Probed once per root, without writing: the
 * vault's own `.writeflex` folder is looked up in upper case; without one, the root's own real path is.
 * A name with no letters to swap counts as case-sensitive (exact comparison, the safe side for removal).
 */
async function volumeIgnoresCase(root: string): Promise<boolean> {
  try {
    const realRoot = await realpathNative(root)
    const probes: Array<[string, string]> = [[join(realRoot, '.writeflex'), join(realRoot, '.WRITEFLEX')]]
    const swapped = swapCase(realRoot)
    if (swapped !== realRoot) probes.push([realRoot, swapped])
    for (const [actual, other] of probes) {
      const a = await lstat(actual).catch(() => null)
      if (!a) continue
      const b = await lstat(other).catch(() => null)
      return Boolean(b && b.dev === a.dev && b.ino === a.ino)
    }
  } catch {
    // An unreadable root: fall through to exact comparison.
  }
  return false
}

const swapCase = (text: string): string =>
  [...text].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('')

const newerVersion = (raw: Record<string, unknown>): boolean => typeof raw.version === 'number' && raw.version > 1

function writeFailure(error: unknown, vault: VaultView | null): VaultWriteResult {
  if (error instanceof StoreFileChanged) return refusal('changed', 'The vault settings were changed elsewhere while saving; nothing was written.', vault)
  if (error instanceof StoreFileExists) return refusal('exists', 'This folder is already a vault.', vault)
  if (error instanceof StoreWriteRefused) return refusal('refused', error.message, vault)
  if (error instanceof Error && error.name === 'WritesPausedError') return refusal('refused', error.message, vault)
  throw error
}

const stores = new Map<string, VaultStore>()

/** The one store for `root`, shared by every window bound to it. */
export function vaultStoreFor(root: string): VaultStore {
  let store = stores.get(root)
  if (!store) {
    store = new VaultStore(root)
    stores.set(root, store)
  }
  return store
}
