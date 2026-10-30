/**
 * Stand-ins for Zotero, for the WriteFlex plugin's tests and for WriteFlex's own.
 *
 * - `memoryZotero()` — Zotero's database and its in-memory item cache as two separate maps, so a test
 *   can give a cached item an unsaved change the database does not have.
 * - `sqliteZotero(path)` — the same Zotero surface over a Zotero-schema SQLite file (a temp copy of a
 *   fixture), so the plugin's own SQL runs against Zotero's real tables.
 * - `startFakeZoteroPlugin()` — a local HTTP server that answers like Zotero's server with the plugin
 *   installed: the REAL plugin logic (`zotero-plugin/src/writeflex-bridge.js`) behind it, and the
 *   `bridge.json` the plugin writes, in a temp data directory.
 *
 * Nothing here touches a real Zotero data directory.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { SqliteDatabase } from '@readflex/sqlite-driver'

const require = createRequire(import.meta.url)

type Answer = [number, string | Record<string, string>, string]

export type PluginModule = {
  ITEM_ROW_SQL: string
  ITEM_TAGS_SQL: string
  READ_ANNOTATIONS_SQL: string
  READ_TAGS_SQL: string
  PROTOCOL: number
  REASONS: Record<string, string>
  SIGNATURE_WINDOW_MS: number
  constantTimeEqual(left: unknown, right: unknown): boolean
  handleAnnotation(Z: unknown, request: unknown, context: unknown): Promise<Answer>
  handlePing(request: unknown, context: unknown): Promise<Answer>
  handleRead(Z: unknown, request: unknown, context: unknown): Promise<Answer>
  newSessionId(fill: (bytes: Uint8Array) => void): string
  requestMessage(method: string, path: string, timestamp: string, nonce: string, session: string, bodyHash: string): string
  responseMessage(status: number, nonce: string, bodyHash: string): string
  newToken(fill: (bytes: Uint8Array) => void): string
  isValidToken(token: unknown): boolean
}

export const plugin = require('../../zotero-plugin/src/writeflex-bridge.js') as PluginModule

export const TEST_TOKEN = 'a'.repeat(64)
/** The session id the test plugin runs with, unless a test gives another. */
export const TEST_SESSION = '5e55'.repeat(8)

/** What the plugin is given in Zotero: Web Crypto, its nonce memory, this run's session, its own details. */
export function pluginContext(token = TEST_TOKEN, extra: Record<string, unknown> = {}) {
  return {
    crypto: globalThis.crypto, nonces: new Map<string, number>(), pluginVersion: '1.0.0', sessionId: TEST_SESSION, token,
    zoteroVersion: '11.0-beta.1', ...extra,
  }
}

/**
 * The headers WriteFlex signs a request with, computed here independently of WriteFlex's code.
 * `session` is sent (and signed) unless null; it defaults to the test plugin's.
 */
export function signRequest(
  token: string, method: string, path: string, body: string,
  options: { now?: number; nonce?: string; session?: string | null } = {},
) {
  const timestamp = String(options.now ?? Date.now())
  const nonce = options.nonce ?? randomBytes(16).toString('hex')
  const session = options.session === undefined ? TEST_SESSION : options.session
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const message = ['WriteFlex-Request-3', method, path, timestamp, nonce, session ?? '', bodyHash].join('\n')
  const signature = createHmac('sha256', Buffer.from(token, 'hex')).update(message).digest('hex')
  const headers: Record<string, string> = { 'x-writeflex-nonce': nonce, 'x-writeflex-signature': signature, 'x-writeflex-timestamp': timestamp }
  if (session !== null) headers['x-writeflex-session'] = session
  return { headers, nonce }
}

/** Whether an answer carries the plugin's signature for the request with this nonce. */
export function answerIsSigned(token: string, nonce: string, answer: Answer): boolean {
  const headers = answer[1]
  if (typeof headers === 'string') return false
  const bodyHash = createHash('sha256').update(answer[2]).digest('hex')
  const message = ['WriteFlex-Response-3', String(answer[0]), nonce, bodyHash].join('\n')
  const expected = createHmac('sha256', Buffer.from(token, 'hex')).update(message).digest('hex')
  return headers['X-WriteFlex-Signature'] === expected
}

const TYPE_IDS: Record<string, number> = { highlight: 1, note: 2, image: 3, ink: 4, underline: 5, text: 6 }
const TYPE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(TYPE_IDS).map(([name, id]) => [id, name]))

/** Zotero's annotation fields on an item, as `_saveData` writes them. */
const ANNOTATION_FIELDS = [
  'annotationType', 'annotationText', 'annotationComment', 'annotationColor', 'annotationPageLabel',
  'annotationSortIndex', 'annotationPosition', 'annotationIsExternal',
] as const
type AnnotationField = (typeof ANNOTATION_FIELDS)[number]

/** `annotationPageLabel` → `pageLabel`. */
function shortName(field: string): string {
  return field[10]!.toLowerCase() + field.slice(11)
}

export type StoredAnnotation = {
  type: string | null
  text: string | null
  comment: string | null
  color: string | null
  pageLabel: string | null
  sortIndex: string | null
  position: string | null
  isExternal: boolean | null
}

/**
 * A Zotero item's annotation layer, built as `Zotero.Item` and `Zotero.DataObject` build it, because
 * the plugin's guard against swallowing a concurrent edit depends on exactly this machinery:
 *
 * - the getters return `_getLatestField`: the unsaved value in `_changedData`, else the loaded one;
 * - the setters normalise, return when nothing changes, then `_markFieldChange` and set `_changed`;
 * - `save()` reads every field, awaits the write (where `duringWrite` runs, as another caller's
 *   setter could), writes the annotation row only when `_changed.annotation` or
 *   `_changed.annotationDeferred` is set, clears each field's change record, goes on with the rest
 *   of the save (`afterClear` runs there), and reloads from the database, which clears both flags
 *   (`_saveData`, `_finalizeSave`, `Items._loadAnnotations`);
 * - a failed save runs `_recoverFromSaveError`: reload, then every change cleared (dataObject.js);
 * - `erase()` deletes the row, reloads the parent's child items (`_eraseData`:
 *   `parentItem.reload(['primaryData', 'childItems'], true)`) and awaits the rest of the erase
 *   (`duringErase` runs there); the item leaves the cache only when the transaction commits
 *   (`_finalizeErase`'s commit callback). Saving a new annotation reloads the parent the same way, and
 *   a rollback unloads the new item (`_initSave`'s rollback callback). Nothing reloads the parent
 *   after a rollback: its child list stays as the rolled-back transaction left it, as in Zotero;
 * - `reload(null, true)` reloads the row and clears the category flags but not `_changedData`
 *   (`_loadAnnotations` → `_clearChanged('annotation')`);
 * - `hasChanged()` counts truthy `_changed` entries and `_changedData` keys.
 */
abstract class FakeItem {
  libraryID = 0
  key = ''
  parentID = 0
  id = 0
  _changed: Record<string, boolean> = {}
  _changedData: Record<string, unknown> = {}
  loaded: StoredAnnotation = { color: null, comment: null, isExternal: null, pageLabel: null, position: null, sortIndex: null, text: null, type: null }
  /** Runs inside `save()` while Zotero would be awaiting the database write. */
  duringWrite?: () => void | Promise<void>
  /** Thrown by `save()` right after `duringWrite`, as a failed write would. */
  failWrite?: Error
  /** Runs inside `save()` after the change records are cleared, before the reload. */
  afterClear?: () => void | Promise<void>
  /** Runs inside `erase()` after the row is deleted, while the erase still awaits. */
  duringErase?: () => void | Promise<void>
  /** An attachment's cached annotation keys (`_annotations.rows`), as last loaded. */
  childAnnotationKeys: string[] = []
  reloads: string[][] = []
  constructor(readonly itemType: string) {}
  /** `Zotero.DataObject.reload`: annotation fields from the row (flags cleared), child items from the database. */
  async reload(dataTypes: string[] | null = null, _reloadUnchanged = false): Promise<void> {
    this.reloads.push(dataTypes ?? ['all'])
    if ((this.itemType === 'annotation' || this.loaded.type !== null) && (!dataTypes || dataTypes.includes('annotation'))) {
      this.loaded = this.readRow()
      delete this._changed.annotation
      delete this._changed.annotationDeferred
    }
    if (!dataTypes || dataTypes.includes('childItems')) this.childAnnotationKeys = this.readChildKeys()
  }
  clearBestAttachmentState(): void {}
  protected abstract readChildKeys(): string[]
  async loadPrimaryData(): Promise<void> {}
  async loadDataType(): Promise<void> {}
  hasChanged(): boolean {
    return Object.keys(this._changed).some((type) => this._changed[type]) || Object.keys(this._changedData).length > 0
  }
  abstract isPDFAttachment(): boolean
  protected abstract assertInTransaction(): void
  /** Write every field (Zotero's `REPLACE INTO itemAnnotations`); returns the field names written that had changed. */
  protected abstract writeRow(values: StoredAnnotation): Promise<void>
  /** What the database holds for this item now. */
  protected abstract readRow(): StoredAnnotation
  _getLatestField(field: AnnotationField): unknown {
    return this._changedData[field] !== undefined ? this._changedData[field] : this.loaded[shortName(field) as keyof StoredAnnotation]
  }
  _markFieldChange(field: string, value: unknown): void {
    this._changedData[field] = value
  }
  protected setField(field: AnnotationField, raw: unknown): void {
    let value = raw
    if (typeof value === 'string') {
      value = value.trim().normalize()
      if (value === '') value = null
    }
    if (this._getLatestField(field) === value) return
    const type = this._getLatestField('annotationType') as string | null
    if (field !== 'annotationType' && !type) throw new Error('annotationType must be set before other annotation properties')
    if (field === 'annotationType') {
      const bothTextual = ['highlight', 'underline'].includes(value as string) && ['highlight', 'underline'].includes(type ?? '')
      if (type && type !== value && !bothTextual) throw new Error('Only changes between highlight and underline annotation types are permitted')
      if (!(value as string in TYPE_IDS)) throw new Error(`Unknown annotation type '${String(value)}'`)
    }
    if (field === 'annotationText' && !['highlight', 'underline'].includes(type ?? '')) {
      throw new Error("'annotationText' can only be set for highlight and underline annotations")
    }
    if (field === 'annotationColor' && !/#[a-f0-9]{6}/.test(String(value))) throw new Error(`Invalid annotation color '${String(value)}'`)
    if (field === 'annotationPosition' && typeof raw !== 'string') throw new Error('annotationPosition must be a string')
    this._markFieldChange(field, value)
    this._changed[field === 'annotationPosition' ? 'annotationDeferred' : 'annotation'] = true
  }
  get annotationType() { return this._getLatestField('annotationType') as string | null }
  set annotationType(value: unknown) { this.setField('annotationType', value) }
  get annotationIsExternal() { return this._getLatestField('annotationIsExternal') as boolean | null }
  set annotationIsExternal(value: unknown) {
    const current = this._getLatestField('annotationIsExternal')
    if (current !== null && current !== value) throw new Error('Cannot change annotationIsExternal')
    this.setField('annotationIsExternal', value)
  }
  get annotationText() { return this._getLatestField('annotationText') }
  set annotationText(value: unknown) { this.setField('annotationText', value) }
  get annotationComment() { return this._getLatestField('annotationComment') }
  set annotationComment(value: unknown) { this.setField('annotationComment', value) }
  get annotationColor() { return this._getLatestField('annotationColor') }
  set annotationColor(value: unknown) { this.setField('annotationColor', value) }
  get annotationPageLabel() { return this._getLatestField('annotationPageLabel') }
  set annotationPageLabel(value: unknown) { this.setField('annotationPageLabel', value) }
  get annotationSortIndex() { return this._getLatestField('annotationSortIndex') }
  set annotationSortIndex(value: unknown) { this.setField('annotationSortIndex', value) }
  get annotationPosition() { return this._getLatestField('annotationPosition') }
  set annotationPosition(value: unknown) { this.setField('annotationPosition', value) }
  /** The fields this save will write as changed, for the tests' record (isExternal left out). */
  changedFields(): string[] {
    return Object.keys(this._changedData).filter((field) => field !== 'annotationIsExternal').map(shortName).sort()
  }
  async save(): Promise<boolean> {
    this.assertInTransaction()
    if (!this.hasChanged()) return false
    try {
      const values = Object.fromEntries(ANNOTATION_FIELDS.map((field) => [shortName(field), this._getLatestField(field) ?? null])) as StoredAnnotation
      await this.duringWrite?.()
      if (this.failWrite) throw this.failWrite
      // `_saveData` writes the annotation row only when a category flag says something changed.
      if (this._changed.annotation || this._changed.annotationDeferred) await this.writeRow(values)
      for (const field of ANNOTATION_FIELDS) delete this._changedData[field]
      await this.afterClear?.()
      // `_finalizeSave` → `reload()` → `_loadAnnotations`: the row as written, and both flags cleared.
      this.loaded = this.readRow()
      delete this._changed.annotation
      delete this._changed.annotationDeferred
      return true
    } catch (error) {
      // `_recoverFromSaveError`: `reload(null, true)`, then `_clearChanged()`.
      this.loaded = this.readRow()
      this._changed = {}
      this._changedData = {}
      throw error
    }
  }
}

// -------------------------------------------------------------------------------------------------
// In memory
// -------------------------------------------------------------------------------------------------

export type MemoryRow = {
  itemID: number
  libraryID: number
  key: string
  kind: 'pdf' | 'epub' | 'annotation' | 'note'
  parentKey?: string
  type?: number
  text?: string | null
  comment?: string | null
  color?: string | null
  pageLabel?: string | null
  sortIndex?: string
  position?: string
  isExternal?: number
  /** `items.clientDateModified`: Zotero's stamp, whole seconds, bumped by every save. */
  modified?: string
  tags?: string[]
}

/** Zotero's `transactionDateTime`: the current time cut to whole seconds, as SQL text in UTC. */
export function zoteroStamp(now = Date.now()): string {
  return new Date(Math.floor(now / 1000) * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

function storedOf(row: { type?: number | null; text?: string | null; comment?: string | null; color?: string | null; pageLabel?: string | null; sortIndex?: string | null; position?: string | null; isExternal?: number | null } | undefined): StoredAnnotation {
  return {
    color: row?.color ?? null,
    comment: row?.comment ?? null,
    isExternal: row ? !!row.isExternal : null,
    pageLabel: row?.pageLabel ?? null,
    position: row?.position ?? null,
    sortIndex: row?.sortIndex ?? null,
    text: row?.text ?? null,
    type: row?.type ? TYPE_NAMES[row.type] ?? null : null,
  }
}

export function memoryZotero(options: {
  timeout?: boolean; keys?: string[]; userLibraryID?: number; groupLibraryID?: number
  /** Runs after the transaction's work, where Zotero awaits its COMMIT. */
  beforeCommit?: () => void | Promise<void>
} = {}) {
  const userLibraryID = options.userLibraryID ?? 1
  const groupLibraryID = options.groupLibraryID ?? 2
  const rows = new Map<string, MemoryRow>()
  let nextId = 100
  let inTransaction = false
  const saves: Array<{ key: string; fields: string[] }> = []
  const erased: string[] = []
  const onCommit: Array<() => void> = []
  const onRollback: Array<() => void> = []
  const keys = [...(options.keys ?? [])]
  const id = (libraryID: number, key: string) => `${libraryID}:${key}`
  const cache = new Map<string, Item>()
  // Every stamp is a later second than the one before, so a save always moves it, as in Zotero over time.
  let stampSecond = Date.UTC(2026, 0, 1) / 1000
  const stamp = () => zoteroStamp((stampSecond += 1) * 1000)
  const parentOf = (item: Item): Item | false => {
    const parentKey = rows.get(id(item.libraryID, item.key))?.parentKey
      ?? [...rows.values()].find((candidate) => candidate.itemID === item.parentID)?.key
    return parentKey ? cached(item.libraryID, parentKey) : false
  }

  class Item extends FakeItem {
    isPDFAttachment(): boolean {
      return rows.get(id(this.libraryID, this.key))?.kind === 'pdf'
    }
    protected assertInTransaction(): void {
      if (!inTransaction) throw new Error('save() outside a transaction')
    }
    async save(): Promise<boolean> {
      this.assertInTransaction()
      if (this.hasChanged()) saves.push({ fields: this.changedFields(), key: this.key })
      return super.save()
    }
    protected readChildKeys(): string[] {
      return [...rows.values()]
        .filter((row) => row.kind === 'annotation' && row.libraryID === this.libraryID && row.parentKey === this.key)
        .sort((left, right) => (left.sortIndex ?? '').localeCompare(right.sortIndex ?? ''))
        .map((row) => row.key)
    }
    protected async writeRow(values: StoredAnnotation): Promise<void> {
      const key = id(this.libraryID, this.key)
      let row = rows.get(key)
      let isNew = false
      if (!row) {
        const parent = [...rows.values()].find((candidate) => candidate.itemID === this.parentID)!
        row = { isExternal: 0, itemID: nextId++, key: this.key, kind: 'annotation', libraryID: this.libraryID, parentKey: parent.key }
        rows.set(key, row)
        this.id = row.itemID
        cache.set(key, this)
        // `_initSave`: a new object is unloaded again if the transaction rolls back.
        onRollback.push(() => { if (cache.get(key) === this) cache.delete(key) })
        isNew = true
      }
      row.type = TYPE_IDS[values.type ?? '']
      row.text = values.text
      row.comment = values.comment
      row.color = values.color ?? '#ffd400'
      row.pageLabel = values.pageLabel
      row.sortIndex = values.sortIndex ?? undefined
      row.position = values.position ?? undefined
      row.isExternal = values.isExternal ? 1 : 0
      row.modified = stamp()
      // `_saveData`: a new child item reloads its parent's child items.
      if (isNew) {
        const parent = parentOf(this)
        if (parent) await parent.reload(['primaryData', 'childItems'], true)
      }
    }
    protected readRow(): StoredAnnotation {
      return storedOf(rows.get(id(this.libraryID, this.key)))
    }
    async erase(): Promise<void> {
      if (!inTransaction) throw new Error('erase() outside a transaction')
      const key = id(this.libraryID, this.key)
      const parent = parentOf(this)
      rows.delete(key)
      if (parent) await parent.reload(['primaryData', 'childItems'], true)
      await this.duringErase?.()
      onCommit.push(() => {
        cache.delete(key)
        erased.push(this.key)
      })
    }
  }

  function cached(libraryID: number, key: string): Item | false {
    const row = rows.get(id(libraryID, key))
    if (!row) return false
    let item = cache.get(id(libraryID, key))
    if (!item) {
      item = new Item(row.kind === 'annotation' ? 'annotation' : 'attachment')
      item.libraryID = libraryID
      item.key = key
      item.id = row.itemID
      if (row.kind === 'annotation') item.loaded = storedOf(row)
      cache.set(id(libraryID, key), item)
      if (row.kind !== 'annotation') item.childAnnotationKeys = (item as unknown as { readChildKeys(): string[] }).readChildKeys()
    }
    return item
  }

  const Z = {
    DB: {
      async executeTransaction<T>(work: () => Promise<T>): Promise<T> {
        if (options.timeout) {
          const error = new Error('Timed out')
          error.name = 'TimeoutError'
          throw error
        }
        const snapshot = new Map([...rows].map(([key, row]) => [key, { ...row }]))
        inTransaction = true
        onCommit.length = 0
        onRollback.length = 0
        try {
          const result = await work()
          // Zotero awaits its COMMIT here; anything may run meanwhile.
          await options.beforeCommit?.()
          onRollback.length = 0
          for (const callback of onCommit.splice(0)) callback()
          return result
        } catch (error) {
          onCommit.length = 0
          rows.clear()
          for (const [key, row] of snapshot) rows.set(key, row)
          for (const callback of onRollback.splice(0)) callback()
          throw error
        } finally {
          inTransaction = false
        }
      },
      async queryAsync(sql: string, params: [number, string]) {
        if (!inTransaction) throw new Error('read outside the transaction')
        if (sql === plugin.ITEM_TAGS_SQL) {
          const row = [...rows.values()].find((candidate) => candidate.itemID === (params as unknown as [number])[0])
          return [...(row?.tags ?? [])].sort().map((name) => ({ name }))
        }
        if (sql === plugin.READ_TAGS_SQL) {
          return [...rows.values()]
            .filter((row) => row.kind === 'annotation' && row.libraryID === params[0] && row.parentKey === params[1])
            .flatMap((row) => [...(row.tags ?? [])].sort().map((name) => ({ annotationKey: row.key, name })))
        }
        if (sql !== plugin.READ_ANNOTATIONS_SQL) throw new Error(`unexpected SQL: ${sql}`)
        return [...rows.values()]
          .filter((row) => row.kind === 'annotation' && row.libraryID === params[0] && row.parentKey === params[1])
          .sort((left, right) => (left.sortIndex ?? '').localeCompare(right.sortIndex ?? ''))
          .map((row) => ({
            authorName: null, color: row.color ?? null, comment: row.comment ?? null, isExternal: row.isExternal ?? 0, key: row.key,
            modified: row.modified ?? null, pageLabel: row.pageLabel ?? null, parentItemKey: row.parentKey, position: row.position ?? null,
            sortIndex: row.sortIndex ?? null, text: row.text ?? null, type: row.type ?? null,
          }))
      },
      async rowQueryAsync(sql: string, params: [number, string]) {
        if (sql !== plugin.ITEM_ROW_SQL) throw new Error(`unexpected SQL: ${sql}`)
        if (!inTransaction) throw new Error('read outside the transaction')
        const row = rows.get(id(params[0], params[1]))
        if (!row) return false
        const annotation = row.kind === 'annotation'
        return {
          annotationID: annotation ? row.itemID : null,
          color: row.color ?? null,
          comment: row.comment ?? null,
          isExternal: annotation ? row.isExternal ?? 0 : null,
          itemID: row.itemID,
          modified: row.modified ?? null,
          pageLabel: row.pageLabel ?? null,
          parentKey: annotation ? row.parentKey ?? null : null,
          position: row.position ?? null,
          sortIndex: row.sortIndex ?? null,
          text: row.text ?? null,
          type: row.type ?? null,
        }
      },
    },
    DataObjectUtilities: { generateKey: () => keys.shift() ?? 'GENKEY22' },
    Item,
    Items: {
      getByLibraryAndKeyAsync: async (libraryID: number, key: string) => cached(libraryID, key),
      getAsync: async (itemID: number) => {
        const row = [...rows.values()].find((candidate) => candidate.itemID === itemID)
        return row ? cached(row.libraryID, row.key) : false
      },
    },
    Libraries: {
      get: (libraryID: number) => (libraryID === userLibraryID || libraryID === groupLibraryID ? { editable: true } : false),
      userLibraryID,
    },
    /** Open readers: `{ itemID }` per tab or window, as `Zotero.Reader._readers`. */
    Reader: { _readers: [] as Array<{ itemID: number }> },
    Sync: { Runner: { syncInProgress: false } },
  }

  function put(row: Omit<MemoryRow, 'itemID'> & { itemID?: number }): MemoryRow {
    const full = { itemID: nextId++, modified: '2026-01-01 00:00:00', ...row } as MemoryRow
    rows.set(id(full.libraryID, full.key), full)
    return full
  }
  /**
   * He changes the tags in Zotero and Zotero saves: the stamp moves to now, unless `sameSecond` (the
   * save lands in the same whole second as the stamp it already has).
   */
  function tagInZotero(key: string, tags: string[], options: { sameSecond?: boolean } = {}): void {
    const row = rows.get(id(userLibraryID, key))!
    row.tags = [...tags]
    if (!options.sameSecond) row.modified = stamp()
  }
  return { Z, cached, erased, put, row: (key: string, libraryID = userLibraryID) => rows.get(id(libraryID, key)), rows, saves, tagInZotero }
}

// -------------------------------------------------------------------------------------------------
// Over a Zotero-schema SQLite file
// -------------------------------------------------------------------------------------------------

/**
 * Zotero's item surface over a SQLite file with Zotero's tables. Saves write `items` and
 * `itemAnnotations` as `Item._saveData` does for the fields the plugin sets; erase deletes the item
 * row (the annotation row cascades). Sync bookkeeping is Zotero's business and not imitated.
 */
export function sqliteZotero(database: SqliteDatabase) {
  let inTransaction = false
  const cache = new Map<string, Item>()
  const saves: Array<{ key: string; fields: string[] }> = []
  const onCommit: Array<() => void> = []
  const userLibraryID = (database.prepare("SELECT libraryID FROM libraries WHERE type = 'user'").get() as { libraryID: number }).libraryID

  class Item extends FakeItem {
    isPDFAttachment(): boolean {
      const row = database.prepare(
        `SELECT a.contentType AS contentType, a.linkMode AS linkMode FROM items i JOIN itemAttachments a USING (itemID)
         WHERE i.libraryID = ? AND i.key = ?`,
      ).get(this.libraryID, this.key) as { contentType: string | null; linkMode: number } | undefined
      return !!row && row.contentType === 'application/pdf' && row.linkMode !== 3
    }
    protected assertInTransaction(): void {
      if (!inTransaction) throw new Error('save() outside a transaction')
    }
    async save(): Promise<boolean> {
      this.assertInTransaction()
      if (this.hasChanged()) saves.push({ fields: this.changedFields(), key: this.key })
      return super.save()
    }
    protected async writeRow(values: StoredAnnotation): Promise<void> {
      const existing = database.prepare('SELECT itemID FROM items WHERE libraryID = ? AND key = ?')
        .get(this.libraryID, this.key) as { itemID: number } | undefined
      if (!existing) {
        const typeId = (database.prepare("SELECT itemTypeID FROM itemTypes WHERE typeName = 'annotation'").get() as { itemTypeID: number }).itemTypeID
        const inserted = database.prepare('INSERT INTO items (itemTypeID, libraryID, key, version, synced) VALUES (?, ?, ?, 0, 0)')
          .run(typeId, this.libraryID, this.key)
        this.id = Number(inserted.lastInsertRowid)
        cache.set(`${this.libraryID}:${this.key}`, this)
      } else {
        this.id = existing.itemID
        database.prepare('UPDATE items SET synced = 0, clientDateModified = ? WHERE itemID = ?').run(zoteroStamp(), existing.itemID)
      }
      const parentID = existing
        ? (database.prepare('SELECT parentItemID FROM itemAnnotations WHERE itemID = ?').get(this.id) as { parentItemID: number }).parentItemID
        : this.parentID
      database.prepare(
        `REPLACE INTO itemAnnotations (itemID, parentItemID, type, text, comment, color, pageLabel, sortIndex, position, isExternal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(this.id, parentID, TYPE_IDS[values.type ?? ''] ?? 0, values.text, values.comment, values.color ?? '#ffd400',
        values.pageLabel, values.sortIndex, values.position, values.isExternal ? 1 : 0)
    }
    protected readChildKeys(): string[] {
      return (database.prepare(
        `SELECT a.key AS key FROM itemAnnotations n JOIN items a ON a.itemID = n.itemID
         WHERE n.parentItemID = ? ORDER BY n.sortIndex`,
      ).all(this.id) as Array<{ key: string }>).map((row) => row.key)
    }
    protected readRow(): StoredAnnotation {
      return storedOf(database.prepare('SELECT type, text, comment, color, pageLabel, sortIndex, position, isExternal FROM itemAnnotations WHERE itemID = ?')
        .get(this.id) as Parameters<typeof storedOf>[0])
    }
    async erase(): Promise<void> {
      if (!inTransaction) throw new Error('erase() outside a transaction')
      database.prepare('DELETE FROM items WHERE libraryID = ? AND key = ?').run(this.libraryID, this.key)
      await this.duringErase?.()
      const key = `${this.libraryID}:${this.key}`
      onCommit.push(() => cache.delete(key))
    }
  }

  function cached(libraryID: number, key: string): Item | false {
    const row = database.prepare('SELECT itemID FROM items WHERE libraryID = ? AND key = ?').get(libraryID, key) as { itemID: number } | undefined
    if (!row) return false
    let item = cache.get(`${libraryID}:${key}`)
    if (!item) {
      item = new Item('item')
      item.libraryID = libraryID
      item.key = key
      item.id = row.itemID
      const annotation = database.prepare('SELECT type, text, comment, color, pageLabel, sortIndex, position, isExternal FROM itemAnnotations WHERE itemID = ?')
        .get(row.itemID) as Parameters<typeof storedOf>[0]
      if (annotation) item.loaded = storedOf(annotation)
      cache.set(`${libraryID}:${key}`, item)
    }
    return item
  }

  const Z = {
    DB: {
      async executeTransaction<T>(work: () => Promise<T>): Promise<T> {
        database.run('BEGIN IMMEDIATE')
        inTransaction = true
        onCommit.length = 0
        try {
          const result = await work()
          database.run('COMMIT')
          for (const callback of onCommit.splice(0)) callback()
          return result
        } catch (error) {
          onCommit.length = 0
          database.run('ROLLBACK')
          throw error
        } finally {
          inTransaction = false
        }
      },
      async rowQueryAsync(sql: string, params: unknown[]) {
        return database.prepare(sql).get(...(params as never[])) ?? false
      },
      async queryAsync(sql: string, params: unknown[]) {
        return database.prepare(sql).all(...(params as never[]))
      },
    },
    DataObjectUtilities: {
      generateKey: () => {
        const alphabet = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
        return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
      },
    },
    Item,
    Items: {
      getByLibraryAndKeyAsync: async (libraryID: number, key: string) => cached(libraryID, key),
      getAsync: async (itemID: number) => {
        const row = database.prepare('SELECT libraryID, key FROM items WHERE itemID = ?').get(itemID) as { libraryID: number; key: string } | undefined
        return row ? cached(row.libraryID, row.key) : false
      },
    },
    Libraries: {
      get: (libraryID: number) => {
        const row = database.prepare('SELECT editable FROM libraries WHERE libraryID = ?').get(libraryID) as { editable: number } | undefined
        return row ? { editable: row.editable === 1 } : false
      },
      userLibraryID,
    },
    Reader: { _readers: [] as Array<{ itemID: number }> },
    Sync: { Runner: { syncInProgress: false } },
  }
  return { Z, cached, saves }
}

// -------------------------------------------------------------------------------------------------
// A local server that answers like Zotero with the plugin installed
// -------------------------------------------------------------------------------------------------

export type FakePluginRequest = { method: string; path: string; headers: Record<string, string>; body: unknown; text: string }

export type FakeZoteroPlugin = {
  port: number
  requests: FakePluginRequest[]
  /** Zotero restarts: the plugin starts a new run with a fresh session id and an empty nonce memory. */
  restart(sessionId?: string): void
  /** Stop listening: from now on the port refuses connections, as when Zotero quits. */
  stop(): void
}

export function writeBridgeFile(dataDirectory: string, bridge: { token: string; port: number; pluginVersion?: string; protocol?: number }): void {
  mkdirSync(join(dataDirectory, 'writeflex'), { recursive: true })
  writeFileSync(join(dataDirectory, 'writeflex', 'bridge.json'), JSON.stringify({
    pluginVersion: bridge.pluginVersion ?? '1.0.0',
    port: bridge.port,
    protocol: bridge.protocol ?? plugin.PROTOCOL,
    token: bridge.token,
  }))
}

/**
 * Serve the plugin's three endpoints on 127.0.0.1 at a free port, and write `bridge.json` for it.
 * `respond` replaces the plugin for a request (return undefined to let the plugin answer).
 */
export function startFakeZoteroPlugin(options: {
  zotero?: unknown
  dataDirectory?: string
  token?: string
  /** The key written into bridge.json, when it should differ from the plugin's (a stale pairing). */
  bridgeToken?: string
  port?: number
  respond?: (request: FakePluginRequest) => Response | undefined | Promise<Response | undefined>
  sessionId?: string
}): FakeZoteroPlugin {
  const token = options.token ?? TEST_TOKEN
  const requests: FakePluginRequest[] = []
  // One plugin, one nonce memory and one session, for as long as this "Zotero" runs.
  let context = pluginContext(token, options.sessionId ? { sessionId: options.sessionId } : {})
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request) {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value })
      const path = new URL(request.url).pathname
      const text = request.method === 'POST' ? await request.text() : ''
      let body: unknown = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }
      const recorded = { body, headers, method: request.method, path, text }
      requests.push(recorded)
      const replaced = await options.respond?.(recorded)
      if (replaced) return replaced
      let answer: Answer
      if (path === '/writeflex/ping' && request.method === 'GET') {
        answer = await plugin.handlePing({ headers, method: 'GET' }, context)
      } else if (path === '/writeflex/annotations' && request.method === 'POST') {
        // Zotero's server: only the declared type is taken, and a text/plain body arrives as the string.
        if (!(headers['content-type'] ?? '').startsWith('text/plain')) return new Response('Endpoint does not support content-type\n', { status: 400 })
        answer = await plugin.handleAnnotation(options.zotero, { data: text, headers, method: 'POST' }, context)
      } else if (path === '/writeflex/annotations/read' && request.method === 'POST') {
        if (!(headers['content-type'] ?? '').startsWith('text/plain')) return new Response('Endpoint does not support content-type\n', { status: 400 })
        answer = await plugin.handleRead(options.zotero, { data: text, headers, method: 'POST' }, context)
      } else {
        return new Response('No endpoint found\n', { status: 404 })
      }
      const answerHeaders = typeof answer[1] === 'string' ? { 'Content-Type': answer[1] } : answer[1]
      return new Response(answer[2], { headers: answerHeaders, status: answer[0] })
    },
  })
  const port = server.port as number
  if (options.dataDirectory) writeBridgeFile(options.dataDirectory, { port, token: options.bridgeToken ?? token })
  return {
    port,
    requests,
    restart: (sessionId = plugin.newSessionId((bytes) => crypto.getRandomValues(bytes))) => {
      context = pluginContext(token, { sessionId })
    },
    stop: () => { void server.stop(true) },
  }
}
