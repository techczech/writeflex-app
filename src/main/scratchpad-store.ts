/**
 * The floating Scratchpad's store (ADR-0050, spec §7). New text is kept as an EXACT Markdown payload
 * plus a small metadata record, both directly inside the Collection's `.writeflex` folder:
 *
 *   .writeflex/scratchpad-item-<id>.md     the bytes as captured, never reparsed or trimmed
 *   .writeflex/scratchpad-item-<id>.json   id, capture kind, origin, group, status, uses, payload digest
 *   .writeflex/scratchpad-index.json       named groups, and status/group/uses for legacy scraps
 *
 * Why not the SCRAPS.md grammar: its reader trims boundary blank lines and splits at a `## s_…` line
 * even inside a fence, so arbitrary sections would not survive it. Existing SCRAPS.md files are read
 * through ScrapStore unchanged (no migration); what this feature adds to a legacy scrap (reject, group,
 * uses) lives in the index, and done/colour still go to its own heading line as before.
 *
 * Every write asks the Collection's write gate, runs as one turn of the Workspace's write turn, and goes
 * through checked-store-write.ts (no link followed, a new file never replaces another writer's, an
 * update only over the version read). The payload is written before its record, so a record always
 * names bytes that exist; an item exists when its record does.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Workspace } from './workspace'
import type { ScrapStore } from './scraps'
import { assertCollectionWritable } from './collection-write-gate'
import { queueThenTurn } from './collection-write-order'
import { readStoreFile, removeStoreFile, writeStoreFile, type StoreFileVersion } from './checked-store-write'
import { readCheckedScratchWidget, validateScratchAsset } from './scratchpad-assets'
import { documentAssets } from '../shared/scratchpad-inventory'
import { currentScratchpadHolders } from './scratchpad-holders'
import { readDestination, rebaseRelativeLinks, unescapeDestination } from './relative-link-rebase'
import { scanMarkdownCodeRanges } from './rename-repair'
import { parseMarkdown } from '../shared/markdown/dialect'
import { embedLine } from '../shared/markdown/embed-line'
import { MANIFEST_NAME } from '../shared/folio-constants'
import { fragmentTitle, isPlaced, unverifiedNote, type ScratchAssetKind, type ScratchExternalRef, type ScratchKind, type ScratchGroup, type ScratchItem, type ScratchSnapshot, type ScratchSourceRef, type ScratchStatus, type ScratchUse } from '../shared/scratchpad-items'

const STORE = '.writeflex'
const INDEX = `${STORE}/scratchpad-index.json`
const ITEM_PREFIX = 'scratchpad-item-'
const ITEM_ID = /^p_[0-9a-z]{6,40}$/
const LEGACY_ID = /^legacy:(.+)#(s_[0-9a-z]+)$/
const MARKDOWN = /\.(md|markdown|mdx)$/i
/** A fragment larger than this is not a scrap; refused rather than written. */
export const MAX_FRAGMENT_BYTES = 4 * 1024 * 1024

type ItemRecord = {
  version: 1
  /** Private copy-Undo state. Payload and record are retained; no public status is added. */
  withdrawn?: true
  /** Private capture reservation: prevents copy withdrawal until removal is confirmed or cancelled. */
  cutClaim?: string
  id: string
  kind: ScratchKind
  how: 'cut' | 'copy'
  by: 'writer' | 'agent'
  createdAt: string
  /** `base`: the folder the payload's relative links resolve from, when it is no longer the origin's own
   *  (the document moved without its pictures). Absent: the origin's folder. */
  origin: { path: string; heading: string | null; base?: string; capturedSpan?: { from: number; to: number; line: number } }
  group: string | null
  status: ScratchStatus
  done: boolean
  colour: string | null
  uses: ScratchUse[]
  payload: { bytes: number; sha256: string }
  /** Additive pointer for Reference/Evidence items (ticket 03): the canonical evidence identity this
   *  candidate collects. The payload is only its preview; actions re-read the canonical record. */
  sourceRef?: ScratchSourceRef
  /** Additive pointer for a collected TalkWeaver/SlideWell candidate (ticket 05): the source
   *  app's identity and the shown version's digest. The payload is only its preview; insertion
   *  revalidates the pointer in main and copies the checked bytes into this workspace. Records
   *  written before ticket 05 carry no `external` field and read exactly as before. */
  external?: ScratchExternalRef
}
type LegacyOverlay = { status?: ScratchStatus; group?: string | null; uses?: ScratchUse[] }
type IndexRecord = { version: 1; groups: ScratchGroup[]; legacy: Record<string, LegacyOverlay> }

const payloadName = (id: string): string => `${STORE}/${ITEM_PREFIX}${id}.md`
const recordName = (id: string): string => `${STORE}/${ITEM_PREFIX}${id}.json`
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const dirOf = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))

/** @internal Test seams: each runs at the named point of a store operation, never in production. */
export const scratchpadStoreSeams: { afterDiscardRead?: () => Promise<void> | void; afterDeleteRead?: () => Promise<void> | void } = {}

export type ScratchpadStoreOptions = {
  /** The editor sessions alive now (see `recordUse`'s holder). A put-back made by a session that is gone
   *  can no longer be confirmed: it is reported unverified and no longer holds the item out of
   *  Candidates. Absent: use the same main-derived registry as read-only adapters; headless readers have no live editors. */
  liveHolders?: () => ReadonlySet<string>
}

export type AddTextInput = { origin: string; markdown: string; how: 'copy'; by: 'writer' | 'agent'; heading?: string | null; group?: string | null }
export type PreparedInsert = { ok: true; markdown: string; rewritten: number } | { ok: false; error: string }
export type PreparedWidgetPreview = { ok: true; html: string; title: string; markdown: string } | { ok: false; error: string }

export class ScratchpadStore {
  constructor(private readonly ws: Workspace, private readonly scraps: Pick<ScrapStore, 'list' | 'toggleDone' | 'setColour' | 'remove' | 'removeAtOrigin' | 'exclusive'> | null, private readonly options: ScratchpadStoreOptions = {}) {}

  /** A workspace-relative Markdown document path, or a thrown refusal. The renderer's word is never taken
   *  for where a path points: it is resolved and contained by the Workspace guard. */
  documentPath(path: unknown): string {
    if (typeof path !== 'string' || path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/')) throw new Error('Not a document in this workspace.')
    const normal = posix.normalize(path)
    if (normal.startsWith('../') || normal === '..' || !MARKDOWN.test(normal)) throw new Error('Not a document in this workspace.')
    this.ws.absolute(normal) // containment and symlink escape; throws outside the workspace
    return normal
  }

  /** The Folio folder `path` belongs to: the nearest folder upwards holding a manifest. */
  folioDirFor(path: string | null): string | null {
    if (path === null) return null
    let dir = dirOf(path)
    for (;;) {
      const manifest = dir === '' ? MANIFEST_NAME : `${dir}/${MANIFEST_NAME}`
      try { if (existsSync(this.ws.absolute(manifest))) return dir } catch { return null }
      if (dir === '') return null
      dir = dirOf(dir)
    }
  }

  async list(options: { activePath: string | null }): Promise<ScratchSnapshot> {
    const notices: string[] = []
    const legacyScraps = this.scraps ? await this.scraps.list() : []
    const index = await this.#readIndex(notices)
    const items: ScratchItem[] = []
    const live = this.options.liveHolders ? this.options.liveHolders() : currentScratchpadHolders(this.ws.root)
    for (const scrap of legacyScraps) {
      const id = `legacy:${scrap.origin}#${scrap.id}`
      const overlay = index.value.legacy[id] ?? {}
      items.push({
        id, source: 'legacy', kind: 'text', how: null, by: 'writer', createdAt: null,
        origin: { path: scrap.origin, heading: null }, title: fragmentTitle(scrap.text), markdown: scrap.text,
        group: overlay.group ?? null, status: overlay.status ?? 'active', done: scrap.done,
        ...(scrap.colour ? { colour: scrap.colour } : {}), ...(scrap.expandTrigger !== undefined ? { expandTrigger: scrap.expandTrigger } : {}),
        uses: markUses(overlay.uses ?? [], live),
        version: sha256(scrap.text),
      })
    }
    items.push(...await this.listLossless(notices))
    const activePath = options.activePath === null ? null : this.#safeDocumentPath(options.activePath)
    return { items, groups: index.value.groups, notices, folioDir: this.folioDirFor(activePath) }
  }

  /** The lossless items alone (no legacy scraps), with notices for anything that could not be read.
   *  What the Board, the agent's scrap list and the command line read through `readLosslessItems`. */
  async listLossless(notices: string[]): Promise<ScratchItem[]> {
    const items: ScratchItem[] = []
    const names = await this.#storeNames(notices)
    const records = new Set<string>()
    for (const name of names) {
      if (!name.startsWith(ITEM_PREFIX) || !name.endsWith('.json')) continue
      const id = name.slice(ITEM_PREFIX.length, -'.json'.length)
      records.add(id)
      const item = await this.#readItem(id, notices)
      if (item) items.push(item)
    }
    for (const name of names) {
      if (!name.startsWith(ITEM_PREFIX) || !name.endsWith('.md')) continue
      const id = name.slice(ITEM_PREFIX.length, -'.md'.length)
      if (!records.has(id)) notices.push(`A saved fragment has no record: ${STORE}/${name}. It was left as it is.`)
    }
    return items
  }

  async get(id: string): Promise<ScratchItem> {
    if (ITEM_ID.test(id)) {
      const notices: string[] = []
      const item = await this.#readItem(id, notices)
      if (!item) throw new Error(notices[0] ?? 'This Scratchpad item is not there any more.')
      return item
    }
    const legacy = (await this.list({ activePath: null })).items.find((item) => item.id === id)
    if (!legacy) throw new Error('This Scratchpad item is not there any more.')
    return legacy
  }

  /** Keep `markdown` exactly. Always a copy: a cut is confirmed only after its text left the editor. */
  async addText(input: AddTextInput): Promise<ScratchItem> { return this.#add(input, 'text') }

  async addAsset(input: { origin: string; markdown: string; kind: ScratchAssetKind; heading?: string | null; capturedSpan?: { from: number; to: number; line: number } }): Promise<ScratchItem> {
    const origin = this.documentPath(input.origin)
    if (input.capturedSpan !== undefined && !validCapturedSpan(input.capturedSpan)) throw new Error('Not a source position.')
    await validateScratchAsset(this.ws.root, origin, input.kind, input.markdown)
    return this.#add({ ...input, origin, how: 'copy', by: 'writer' }, input.kind)
  }

  /** Keep a pointer to a canonical Folio source. The stored payload is its preview only; the
   *  canonical evidence record is not copied, migrated or rewritten by collecting. */
  async addSource(input: { origin: string; markdown: string; kind: 'ref' | 'evidence'; heading?: string | null; sourceRef: ScratchSourceRef; by?: 'writer' | 'agent' }): Promise<ScratchItem> {
    if (!validSourceRef(input.sourceRef)) throw new Error('That source cannot be collected safely.')
    return this.#add({ origin: input.origin, markdown: input.markdown, how: 'copy', by: input.by ?? 'writer', heading: input.heading ?? null, sourceRef: input.sourceRef }, input.kind)
  }

  /** Keep a pointer to one shown TalkWeaver/SlideWell asset (ticket 05). The stored payload is
   *  its preview only; no source bytes enter this workspace by collecting. The pointer is the
   *  external service's own validated record — never renderer-supplied paths. */
  async addExternal(input: { origin: string; markdown: string; kind: 'pic' | 'widget'; heading?: string | null; external: ScratchExternalRef; by?: 'writer' | 'agent'; group?: string | null }): Promise<ScratchItem> {
    if (!validExternalRef(input.external) || input.external.kind !== input.kind) throw new Error('That source result cannot be collected safely.')
    return this.#add({ origin: input.origin, markdown: input.markdown, how: 'copy', by: input.by ?? 'writer', heading: input.heading ?? null, group: input.group ?? null, external: input.external }, input.kind)
  }

  /** Record the local owned copy an insertion made of an external candidate, through the same
   *  checked record writer as every other record change. The copy's digest must be the shown
   *  version's; a different digest is a different asset and is never recorded as this one. */
  async recordExternalImport(id: string, importedPath: string, importedSha256: string): Promise<void> {
    const path = typeof importedPath === 'string' ? posix.normalize(importedPath) : ''
    if (!isImportedAssetPath(path) || !/^[0-9a-f]{64}$/.test(importedSha256)) throw new Error('That copied file cannot be recorded safely.')
    await this.#update(id, (record) => {
      if (!record.external) throw new Error('That item did not come from a connected source.')
      if (record.external.sha256 !== importedSha256) throw new Error('The copied file is not the version that was shown, so it was not recorded.')
      record.external = { ...record.external, importedPath: path, importedSha256 }
    })
  }

  /** Take back a recorded local copy — only while the record still points at exactly that copy
   *  (the conditional half of an accept rollback; a later copy is never silently unrecorded). */
  async clearExternalImport(id: string, importedPath: string, importedSha256: string): Promise<boolean> {
    let cleared = false
    await this.#update(id, (record) => {
      if (!record.external || record.external.importedPath !== importedPath || record.external.importedSha256 !== importedSha256) return
      const { importedPath: _path, importedSha256: _sha, ...rest } = record.external
      record.external = rest
      cleared = true
    })
    return cleared
  }

  /** The current pointer of a collected Reference/Evidence item, refreshed in place after an action
   *  re-read the canonical record (state, quote and attachment facts move with the record). */
  async refreshSourceRef(id: string, sourceRef: ScratchSourceRef): Promise<void> {
    if (!validSourceRef(sourceRef)) throw new Error('That source cannot be recorded safely.')
    await this.#update(id, (record) => {
      if ((record.kind !== 'ref' && record.kind !== 'evidence') || record.sourceRef?.sourceId !== sourceRef.sourceId) throw new Error('That source pointer changed, so nothing was recorded.')
      record.sourceRef = sourceRef
    })
  }

  async #add(input: AddTextInput & { capturedSpan?: { from: number; to: number; line: number }; sourceRef?: ScratchSourceRef; external?: ScratchExternalRef }, kind: ScratchKind): Promise<ScratchItem> {
    const origin = this.documentPath(input.origin)
    if (typeof input.markdown !== 'string') throw new Error('Nothing to keep.')
    const bytes = Buffer.from(input.markdown, 'utf8')
    if (bytes.length === 0) throw new Error('Nothing to keep.')
    if (bytes.length > MAX_FRAGMENT_BYTES) throw new Error('This selection is too large for the Scratchpad.')
    const heading = typeof input.heading === 'string' ? input.heading.slice(0, 300) : null
    return this.#write(async () => {
      const group = input.group ?? null
      if (group !== null) {
        const index = await this.#readIndex([])
        if (!index.value.groups.some((g) => g.id === group)) throw new Error('That group is not there any more.')
      }
      const id = `p_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`
      const record: ItemRecord = {
        version: 1, id, kind, how: 'copy', by: input.by === 'agent' ? 'agent' : 'writer', createdAt: new Date().toISOString(),
        origin: { path: origin, heading, ...(input.capturedSpan ? { capturedSpan: { from: input.capturedSpan.from, to: input.capturedSpan.to, line: input.capturedSpan.line } } : {}) }, group, status: 'active', done: false, colour: null, uses: [],
        payload: { bytes: bytes.length, sha256: sha256(bytes) },
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...(input.external ? { external: input.external } : {}),
      }
      await writeStoreFile(this.ws.root, payloadName(id), input.markdown, { mode: 'create' })
      // A failed record create leaves the payload intact. Listing reports the orphan or unreadable
      // record; copy Undo and failed creation never physically delete captured text.
      await writeStoreFile(this.ws.root, recordName(id), `${JSON.stringify(record, null, 2)}\n`, { mode: 'create' })
      return itemOf(record, input.markdown)
    })
  }

  /** Copy Undo withdraws an unused copy through the expected-version checked writer. Both files
   * remain for recovery. A changed payload or a completed concurrent promotion/use refuses withdrawal.
   * The dependent payload check and record replacement retain the writer's final-syscall limits. */
  async discardCopy(id: string): Promise<void> {
    if (!ITEM_ID.test(id)) throw new Error('Only a copy sent just now can be taken back.')
    await this.#write(async () => {
      const notices: string[] = []
      const loaded = await this.#readRecord(id, notices)
      if (!loaded) throw new Error(notices[0] ?? 'This Scratchpad item is not there any more.')
      if (loaded.record.how !== 'copy' || loaded.record.uses.length > 0 || loaded.record.cutClaim !== undefined) throw new Error('Only a copy that has not been used can be taken back.')
      const validate = await this.#payloadAuthority(id, loaded.record)
      await scratchpadStoreSeams.afterDiscardRead?.()
      try {
        await writeStoreFile(this.ws.root, recordName(id), `${JSON.stringify({ ...loaded.record, withdrawn: true }, null, 2)}\n`, {
          mode: 'replace', expect: loaded.version, validate,
        })
      } catch (error) {
        throw new Error(`This copy changed since it was sent (another window may have used it), so it was kept. ${(error as Error).message}`)
      }
    })
  }

  /** The record file of item `id` (workspace-relative), derived from the id alone. */
  recordPathFor(id: string): string {
    if (!ITEM_ID.test(id)) throw new Error('This Scratchpad item is not there any more.')
    return recordName(id)
  }

  /**
   * The item a Board text step (offcut to idea, add to end of piece) may take: a lossless TEXT item
   * still waiting to be used — active, not put back, not reserved by an in-flight cut. References,
   * evidence, pictures, tables and widgets never travel these text-only steps; their previews are
   * not payloads. A changed payload (the digest no longer matches the record) refuses here too.
   */
  async boardTextItem(id: string): Promise<ScratchItem> {
    const item = await this.get(id)
    if (item.source !== 'lossless' || item.kind !== 'text') throw new Error('Only text kept in the Scratchpad can take this step. Pictures, tables, widgets, references and evidence stay in the Scratchpad, where their own actions use them.')
    if (item.status !== 'active') throw new Error('That item was rejected. Move it back to Candidates before using it on the Board.')
    if (isPlaced(item)) throw new Error('That text was put back in a document, so it is no longer waiting on the Board.')
    const loaded = await this.#readRecord(id, [])
    if (!loaded || loaded.record.cutClaim !== undefined) throw new Error('That text is being cut right now, so the Board left it as it is.')
    await this.#payloadAuthority(id, loaded.record)
    return item
  }

  /**
   * The scrap half of a Board/agent copy-for-reuse step (spec P4, coordinator resolution): after the
   * receiving document was written under the step's own restore ownership, record the actual copy as
   * a HISTORICAL use (item id + destination, no editor holder, no put-back claim) through the same
   * checked record writer and payload authority as every other record change. The candidate is
   * RETAINED — exact payload, id, group, status and provenance untouched — so it can be used again;
   * Undo of the receiving step restores the document bytes only and never rolls this record back
   * over outside metadata edits. `expectedMarkdown` is the payload the step was prepared from: the
   * copy is recorded only while the checked payload is still exactly those bytes, so a stale
   * prepared payload cannot be re-authorised by a later, different read. Placement is this record,
   * never matching prose.
   */
  async recordBoardCopy(id: string, destination: string, useId: string, expectedMarkdown: string): Promise<void> {
    if (!ITEM_ID.test(id)) throw new Error('This Scratchpad item is not there any more.')
    if (typeof useId !== 'string' || !/^u_[0-9a-z]{4,40}$/.test(useId)) throw new Error('Not a use record.')
    if (typeof expectedMarkdown !== 'string') throw new Error('Not a use record.')
    const path = this.documentPath(destination)
    await this.#write(async () => {
      const notices: string[] = []
      const loaded = await this.#readRecord(id, notices)
      if (!loaded) throw new Error(notices[0] ?? 'This Scratchpad item is not there any more.')
      const { record } = loaded
      if (record.kind !== 'text' || record.status !== 'active' || record.cutClaim !== undefined) {
        throw new Error('That Scratchpad item changed while the step was being prepared, so it was left as it is.')
      }
      const validate = await this.#payloadAuthority(id, record)
      const payload = await readStoreFile(this.ws.root, payloadName(id))
      if (payload.state !== 'present' || payload.bytes.toString('utf8') !== expectedMarkdown) {
        throw new Error('That Scratchpad item changed while the step was being prepared, so it was left as it is.')
      }
      record.uses = [...record.uses.filter((u) => u.useId !== useId), { useId, path, mode: 'copy', at: new Date().toISOString(), historical: true }]
      await writeStoreFile(this.ws.root, recordName(id), `${JSON.stringify(record, null, 2)}\n`, { mode: 'replace', expect: loaded.version, validate })
    })
  }

  /**
   * The use an ACCEPTED agent Scratchpad proposal records (spec §8): the same checked record
   * writer and payload authority as `recordBoardCopy`, for every insertable kind. A copy is
   * HISTORICAL (no editor anchor claims its place) and the candidate is retained byte for byte;
   * a put-back is recorded under the live window's main-derived holder, exactly as the writer's
   * own put-back is, and only for a genuine recorded cut. `expectedMarkdown` is the payload the
   * reviewed proposal was prepared from: the use is recorded only while the checked payload is
   * still exactly those bytes. Undo of the receiving step never rolls this record back over
   * outside metadata edits. A legacy scrap can only be copied; its body is checked against
   * `expectedMarkdown` in the same snapshot that files the use.
   */
  async recordAgentUse(id: string, use: { useId: string; path: string; mode: 'copy' | 'put-back'; holder?: string; expectedMarkdown: string }): Promise<void> {
    if (typeof use.useId !== 'string' || !/^u_[0-9a-z]{4,40}$/.test(use.useId)) throw new Error('Not a use record.')
    if (use.mode !== 'copy' && use.mode !== 'put-back') throw new Error('Not a use record.')
    if (typeof use.expectedMarkdown !== 'string') throw new Error('Not a use record.')
    const path = this.documentPath(use.path)
    const entry: ScratchUse = {
      useId: use.useId, path, mode: use.mode, at: new Date().toISOString(),
      ...(use.mode === 'put-back' ? { holder: use.holder } : { historical: true as const }),
    }
    if (use.mode === 'put-back' && (typeof use.holder !== 'string' || use.holder === '')) throw new Error('Not a use record.')
    if (LEGACY_ID.test(id)) {
      if (use.mode === 'put-back') throw new Error('Put back is only for a recorded cut.')
      const scrap = (await this.#legacy().list()).find((candidate) => `legacy:${candidate.origin}#${candidate.id}` === id)
      if (!scrap || scrap.text !== use.expectedMarkdown) throw new Error('That Scratchpad item changed while the proposal was waiting, so it was left as it is.')
      await this.#overlay([id], (overlay) => { overlay.uses = [...(overlay.uses ?? []).filter((u) => u.useId !== entry.useId), entry] })
      return
    }
    if (!ITEM_ID.test(id)) throw new Error('This Scratchpad item is not there any more.')
    await this.#write(async () => {
      const notices: string[] = []
      const loaded = await this.#readRecord(id, notices)
      if (!loaded) throw new Error(notices[0] ?? 'This Scratchpad item is not there any more.')
      const { record } = loaded
      // A copy use is recorded for reference acts too, as the writer's controller records them;
      // the generic insert's own refusal of ref/evidence kinds lives in prepareInsert.
      if (record.status !== 'active' || record.cutClaim !== undefined) throw new Error('That Scratchpad item changed while the proposal was waiting, so it was left as it is.')
      if (use.mode === 'put-back' && (record.kind !== 'text' || record.how !== 'cut')) throw new Error('Put back is only for a recorded cut.')
      const validate = await this.#payloadAuthority(id, record)
      const payload = await readStoreFile(this.ws.root, payloadName(id))
      if (payload.state !== 'present' || payload.bytes.toString('utf8') !== use.expectedMarkdown) {
        throw new Error('That Scratchpad item changed while the proposal was waiting, so it was left as it is.')
      }
      record.uses = [...record.uses.filter((u) => u.useId !== entry.useId), entry]
      await writeStoreFile(this.ws.root, recordName(id), `${JSON.stringify(record, null, 2)}\n`, { mode: 'replace', expect: loaded.version, validate })
    })
  }

  /**
   * Delete forever (spec §6, only from Rejected, behind the panel's confirmation): the one removal
   * in this store. A lossless item is removed only while its record and payload are still exactly
   * the versions read here — owner (this workspace's `.writeflex`, by item id), status (rejected),
   * no in-flight cut, no confirmed put-back, and the payload's digest still the record's. Both files
   * go through `removeStoreFile`'s expected-version unlink; a link, a wrong root (the IPC binds the
   * store to the calling window's folder) or a concurrent edit refuses and keeps the item. The
   * canonical sources a Reference/Evidence item points at are never touched: only this candidate's
   * own record and preview payload are removed. A legacy scrap leaves through
   * `ScrapStore.removeAtOrigin` — origin-qualified and expected-version, never the global-id
   * `remove` (copied legacy files may share an id) — and its index overlay entry goes with it, after
   * the targeted removal is confirmed. Nothing here can name a source document: removal paths are
   * derived from the item id alone (a legacy origin is re-validated as a document of this workspace).
   *
   * The legacy branch holds the scrap queue and then the write turn (`queueThenTurn`, the one order)
   * from its snapshot to the removal, so no writer in this app can change the candidate's status or
   * body between the checks and the write. Its rejected/placement status is read from one checked
   * index read whose version (folder and file identity, bytes and stamp, through `readStoreFile`)
   * is captured as the authority for the whole removal: a synchronous re-read of that same checked
   * file must still match it in the tick of the scraps file's rename (`beforeCommit`, carried
   * through `removeAtOrigin`), so an outside program that restores the candidate — or edits the
   * index at all, or replaces `.writeflex` or the index with a link — refuses the deletion whole
   * and keeps both the scrap and the outside edit. That is deliberately conservative: an unrelated
   * index change also refuses. It is not a transaction over the two files; between the synchronous
   * check and the rename syscall an outside program could still act (the guarded writer's
   * documented final-syscall limit).
   *
   * `expectedVersion` is the `version` the listing showed when the writer confirmed (the panel and
   * the approval-bound delete verb carry it back): a body changed while the confirmation waited
   * refuses here instead of being silently authorised by this fresh read. Internal callers that
   * read and delete in one breath may omit it; the read inside the write then governs.
   */
  async deleteRejected(id: string, expectedVersion?: string): Promise<void> {
    if (expectedVersion !== undefined && (typeof expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(expectedVersion))) {
      throw new Error('That item changed since it was shown, so it was kept.')
    }
    const legacy = LEGACY_ID.exec(id)
    if (legacy) {
      // The origin comes from the composite identity, never from a caller-named path; it must still
      // name a Markdown document inside this workspace (containment and symlink escape included).
      const origin = this.documentPath(legacy[1])
      const legacyStore = this.#legacy()
      // Queue first, then turn (collection-write-order.ts): the snapshot, the origin-qualified
      // removal and the overlay cleanup run as one held stretch, and everything they call that
      // asks for either lock again runs inside it. Never the turn and then the queue.
      await queueThenTurn(legacyStore, this.ws, async () => {
        assertCollectionWritable(this.ws.root)
        // One snapshot: the checked index first, its version captured, then the legacy scraps,
        // then the index authority checked again synchronously — so the rejected/placement status
        // and the body version below were read while that one index version stood. A refused or
        // unreadable index (a link at `.writeflex` or at the index name included) establishes no
        // rejected status and deletes nothing.
        const index = await this.#readIndex([], true)
        const captured = index.version
        // The authority carried to the scraps write's commit tick: the checked index file, read
        // synchronously by the same guard, must still be the captured version — same folder and
        // file identity (the guard itself), same bytes, same stamp. Any difference refuses.
        const validateIndex = (): void => {
          const changed = new Error('That item changed while it was being deleted, so it was kept.')
          const now = readStoreFile(this.ws.root, INDEX, { sync: true })
          if (captured === null) {
            if (now.state !== 'absent') throw changed
            return
          }
          if (now.state !== 'present' || !now.bytes.equals(captured.bytes)
            || now.stamp.dev !== captured.stamp.dev || now.stamp.ino !== captured.stamp.ino
            || now.stamp.size !== captured.stamp.size || now.stamp.mtimeNs !== captured.stamp.mtimeNs
            || now.stamp.ctimeNs !== captured.stamp.ctimeNs) throw changed
        }
        const scrap = (await legacyStore.list()).find((entry) => `legacy:${entry.origin}#${entry.id}` === id)
        if (!scrap) throw new Error('This Scratchpad item is not there any more.')
        validateIndex()
        const overlay = index.value.legacy[id] ?? {}
        if ((overlay.status ?? 'active') !== 'rejected') throw new Error('Only a rejected item can be deleted forever. Reject it first; rejecting deletes nothing.')
        const live = this.options.liveHolders ? this.options.liveHolders() : currentScratchpadHolders(this.ws.root)
        if (isPlaced({ uses: markUses(overlay.uses ?? [], live) })) throw new Error('That text is in a document now, so it was kept.')
        // Legacy scraps carry no cut reservation (that state lives on lossless records); rejected
        // status and placement above are theirs. The version shown is the body's digest.
        const version = sha256(scrap.text)
        const shown = expectedVersion ?? version
        if (shown !== version) throw new Error('That item changed since it was shown, so it was kept.')
        await legacyStore.removeAtOrigin(origin, legacy[2], { bodySha256: shown, beforeCommit: validateIndex })
        // Overlay cleanup only after the targeted removal is confirmed, over a freshly read index
        // version each attempt, so a concurrent index edit is never clobbered.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await this.#write(async () => {
              const fresh = await this.#readIndex([], true)
              if (!(id in fresh.value.legacy)) return
              const next = { ...fresh.value.legacy }
              delete next[id]
              await this.#writeIndex({ ...fresh.value, legacy: next }, fresh.version)
            })
            break
          } catch (error) {
            if (attempt >= 2 || !(error instanceof Error) || !/was changed by another program/.test(error.message)) throw error
          }
        }
      })
      return
    }
    if (!ITEM_ID.test(id)) throw new Error('This Scratchpad item is not there any more.')
    await this.#write(async () => {
      const notices: string[] = []
      const loaded = await this.#readRecord(id, notices)
      if (!loaded) throw new Error(notices[0] ?? 'This Scratchpad item is not there any more.')
      const { record } = loaded
      if (record.status !== 'rejected') throw new Error('Only a rejected item can be deleted forever. Reject it first; rejecting deletes nothing.')
      if (record.cutClaim !== undefined) throw new Error('That text is being cut right now, so it was kept.')
      const live = this.options.liveHolders ? this.options.liveHolders() : currentScratchpadHolders(this.ws.root)
      if (markUses(record.uses, live).some((use) => use.mode === 'put-back' && !use.unverified)) throw new Error('That text is in a document now, so it was kept.')
      const payload = await readStoreFile(this.ws.root, payloadName(id))
      if (payload.state !== 'present') throw new Error(payload.state === 'refused' ? payload.message : 'The saved text of this item is missing, so its record was kept as it is.')
      if (payload.bytes.length !== record.payload.bytes || sha256(payload.bytes) !== record.payload.sha256) {
        throw new Error('This text was changed outside WriteFlex after it was set aside, so it was kept.')
      }
      if (expectedVersion !== undefined && sha256(Buffer.concat([loaded.version.bytes, Buffer.from([0]), payload.bytes])) !== expectedVersion) {
        throw new Error('That item changed since it was shown, so it was kept.')
      }
      await scratchpadStoreSeams.afterDeleteRead?.()
      // Both files are re-read before either is removed, so a concurrent edit refuses whole.
      const again = await readStoreFile(this.ws.root, payloadName(id))
      if (again.state !== 'present' || !again.bytes.equals(payload.bytes)) throw new Error('This item changed while it was being deleted, so it was kept.')
      await removeStoreFile(this.ws.root, recordName(id), loaded.version)
      try {
        await removeStoreFile(this.ws.root, payloadName(id), { bytes: payload.bytes, stamp: payload.stamp })
      } catch (error) {
        throw new Error(`The item was removed from the Scratchpad, but its saved text was kept in ${payloadName(id)} because it changed while it was being deleted.`)
      }
    })
  }

  /** Private capture phase, not an insertion/use or a cutting. Main derives its holder from sender. */
  async reserveCut(id: string, holder: string): Promise<void> {
    await this.#update(id, (record) => {
      if (record.kind !== 'text' || record.how !== 'copy' || record.uses.length || record.cutClaim !== undefined) throw new Error('This copy cannot be reserved for a cut now.')
      record.cutClaim = holder
    }, true)
  }

  /** Only the reserving editor may release a capture that left its document unchanged. */
  async cancelCut(id: string, holder: string): Promise<void> {
    await this.#update(id, (record) => {
      if (record.how !== 'copy' || record.cutClaim !== holder) throw new Error('That capture belongs to another editor session or is already a cutting.')
      delete record.cutClaim
    })
  }

  /** The text left the editor after reservation: only now is the saved copy a cutting. */
  async confirmCut(id: string, holder?: string): Promise<void> {
    await this.#update(id, (record) => {
      if (record.kind !== 'text') throw new Error('Only text can be a cutting.')
      if (record.cutClaim !== undefined && record.cutClaim !== holder) throw new Error('That capture belongs to another editor session.')
      record.how = 'cut'
      delete record.cutClaim
    }, true)
  }

  async setStatus(ids: readonly string[], status: ScratchStatus): Promise<void> {
    if (status !== 'active' && status !== 'rejected') throw new Error('Unknown status.')
    await this.#each(ids, (record) => { record.status = status }, (overlay) => { overlay.status = status })
  }

  async setGroup(ids: readonly string[], group: string | null): Promise<void> {
    if (group !== null) {
      const index = await this.#readIndex([])
      if (!index.value.groups.some((g) => g.id === group)) throw new Error('That group is not there any more.')
    }
    await this.#each(ids, (record) => { record.group = group }, (overlay) => { overlay.group = group })
  }

  async createGroup(name: string): Promise<ScratchGroup> {
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
    if (clean === '' || clean.length > 60) throw new Error('A group name is 1 to 60 characters.')
    return this.#write(async () => {
      const index = await this.#readIndex([])
      const existing = index.value.groups.find((g) => g.name.toLowerCase() === clean.toLowerCase())
      if (existing) return existing
      const group = { id: `g_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, name: clean }
      await this.#writeIndex({ ...index.value, groups: [...index.value.groups, group] }, index.version)
      return group
    })
  }

  /** Rename one group in the checked index (the same writer `createGroup` uses). A name another
   *  group already carries (case-insensitively) refuses; items keep the group id, so nothing else
   *  is rewritten. */
  async renameGroup(id: string, name: string): Promise<ScratchGroup> {
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
    if (clean === '' || clean.length > 60) throw new Error('A group name is 1 to 60 characters.')
    return this.#write(async () => {
      const index = await this.#readIndex([], true)
      const group = index.value.groups.find((g) => g.id === id)
      if (!group) throw new Error('That group is not there any more.')
      if (index.value.groups.some((g) => g.id !== id && g.name.toLowerCase() === clean.toLowerCase())) throw new Error('Another group already has that name.')
      if (group.name === clean) return group
      const renamed = { ...group, name: clean }
      await this.#writeIndex({ ...index.value, groups: index.value.groups.map((g) => (g.id === id ? renamed : g)) }, index.version)
      return renamed
    })
  }

  async toggleDone(id: string): Promise<void> {
    const legacy = LEGACY_ID.exec(id)
    if (legacy) { await this.#legacy().toggleDone(legacy[2]); return }
    await this.#update(id, (record) => { record.done = !record.done })
  }

  async setColour(id: string, colour: string | null): Promise<void> {
    if (colour !== null && !/^[^\s()]{1,32}$/.test(colour)) throw new Error('A colour must be a single short token.')
    const legacy = LEGACY_ID.exec(id)
    if (legacy) { await this.#legacy().setColour(legacy[2], colour); return }
    await this.#update(id, (record) => { record.colour = colour })
  }

  /** An explicit insertion the editor made. Put back is accepted only for a recorded cut. `holder` names
   *  the editor session whose anchor stands for this use (main supplies it, never the renderer). */
  async recordUse(id: string, use: { useId: string; path: string; mode: 'copy' | 'put-back'; holder?: string }): Promise<void> {
    if (typeof use.useId !== 'string' || !/^u_[0-9a-z]{4,40}$/.test(use.useId)) throw new Error('Not a use record.')
    if (use.mode !== 'copy' && use.mode !== 'put-back') throw new Error('Not a use record.')
    const path = this.documentPath(use.path)
    const entry: ScratchUse = { useId: use.useId, path, mode: use.mode, at: new Date().toISOString(), ...(typeof use.holder === 'string' ? { holder: use.holder } : {}) }
    const add = (uses: ScratchUse[]): ScratchUse[] => {
      if (uses.some((u) => u.useId === entry.useId && u.holder !== entry.holder)) throw new Error('That placement belongs to another editor session.')
      return [...uses.filter((u) => u.useId !== entry.useId), entry]
    }
    if (LEGACY_ID.test(id)) {
      if (use.mode === 'put-back') throw new Error('Put back is only for a recorded cut.')
      await this.#overlay([id], (overlay) => { overlay.uses = add(overlay.uses ?? []) })
      return
    }
    await this.#update(id, (record) => {
      if (use.mode === 'put-back' && (record.kind !== 'text' || record.how !== 'cut')) throw new Error('Put back is only for a recorded cut.')
      record.uses = add(record.uses)
    })
  }

  async dropUse(id: string, useId: string, holder?: string): Promise<void> {
    const drop = (uses: ScratchUse[]): ScratchUse[] => {
      if (holder !== undefined && uses.some((u) => u.useId === useId && u.holder !== holder)) throw new Error('That placement belongs to another editor session.')
      return uses.filter((u) => u.useId !== useId)
    }
    if (LEGACY_ID.test(id)) {
      await this.#overlay([id], (overlay) => { overlay.uses = drop(overlay.uses ?? []) })
      return
    }
    await this.#update(id, (record) => { record.uses = drop(record.uses) })
  }

  /**
   * The editor session `holder` has opened `path` afresh: of the uses it recorded there, only those in
   * `keep` (the anchors its editor holds now) still stand. The rest lost their anchor when the document
   * was closed or reloaded, so their claim cannot be checked any more and is dropped (conservative
   * invalidation, never a guess from matching prose): the item is a candidate again, its text untouched.
   */
  async releaseUses(path: string, holder: string, keep: readonly string[]): Promise<number> {
    const doc = this.documentPath(path)
    const kept = new Set(keep)
    const stale = (use: ScratchUse): boolean => use.path === doc && use.holder === holder && !kept.has(use.useId)
    let dropped = 0
    for (const id of await this.#recordIds()) {
      const loaded = await this.#readRecord(id, [])
      if (!loaded || !loaded.record.uses.some(stale)) continue
      await this.#update(id, (record) => { const before = record.uses.length; record.uses = record.uses.filter((u) => !stale(u)); dropped += before - record.uses.length })
    }
    const index = await this.#readIndex([])
    if (Object.values(index.value.legacy).some((overlay) => overlay.uses?.some(stale))) {
      await this.#overlay(Object.keys(index.value.legacy), (overlay) => {
        if (!overlay.uses) return
        const before = overlay.uses.length
        overlay.uses = overlay.uses.filter((u) => !stale(u))
        dropped += before - overlay.uses.length
      })
    }
    return dropped
  }

  /**
   * An app-owned rename or move of a document or folder (`from` → `to`): every item's origin and every
   * recorded use follow it, so the item keeps its id and stays with its document. The payload's bytes are
   * never rewritten: its relative links keep resolving from the folder they were written in (`base`),
   * which moves only when that folder itself moved; inserting rebases them from there as before.
   */
  async followRename(from: string, to: string): Promise<number> {
    const moved = (path: string): string | null => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null)
    const movedDir = (dir: string): string => (dir === '' ? dir : moved(dir) ?? dir)
    const follow = (uses: ScratchUse[]): ScratchUse[] => uses.map((use) => { const next = moved(use.path); return next ? { ...use, path: next } : use })
    let changed = 0
    for (const id of await this.#recordIds()) {
      const loaded = await this.#readRecord(id, [])
      if (!loaded) continue
      const { record } = loaded
      const origin = moved(record.origin.path)
      const base = record.origin.base ?? dirOf(record.origin.path)
      const nextBase = movedDir(base)
      const uses = follow(record.uses)
      if (!origin && nextBase === base && uses.every((use, i) => use === record.uses[i]) && !(record.sourceRef?.sourcePath && moved(record.sourceRef.sourcePath)) && !(record.external?.importedPath && moved(record.external.importedPath))) continue
      await this.#update(id, (current) => {
        const path = moved(current.origin.path) ?? current.origin.path
        const was = current.origin.base ?? dirOf(current.origin.path)
        const now = movedDir(was)
        current.origin = { ...current.origin, path, heading: current.origin.heading, ...(now !== dirOf(path) ? { base: now } : {}) }
        current.uses = follow(current.uses)
        // Path-based canonical identity follows an app-owned source move too, so the next
        // action can re-read the renamed source and collecting it remains idempotent. The
        // saved preview bytes and highlight key stay unchanged.
        if (current.sourceRef?.sourcePath) {
          const ref = current.sourceRef
          const nextSource = moved(ref.sourcePath!)
          if (nextSource) {
            const oldKey = `path:${ref.sourcePath}`
            const nextKey = `path:${nextSource}`
            const sourceId = ref.citationId === oldKey
              ? ref.sourceId === `ref:${oldKey}` ? `ref:${nextKey}`
                : ref.sourceId.startsWith(`ev:${oldKey}#`) ? `ev:${nextKey}${ref.sourceId.slice(`ev:${oldKey}`.length)}` : ref.sourceId
              : ref.sourceId
            current.sourceRef = { ...ref, sourcePath: nextSource, sourceId, citationId: ref.citationId === oldKey ? nextKey : ref.citationId }
          }
        }
        // A local copy imported from a connected source is an ordinary workspace asset:
        // an app-owned folder move carries it, and the record follows it.
        if (current.external?.importedPath) {
          const nextImported = moved(current.external.importedPath)
          if (nextImported) current.external = { ...current.external, importedPath: nextImported }
        }
      })
      changed += 1
    }
    const index = await this.#readIndex([])
    if (Object.values(index.value.legacy).some((overlay) => overlay.uses?.some((use) => moved(use.path)))) {
      await this.#overlay(Object.keys(index.value.legacy), (overlay) => { if (overlay.uses) overlay.uses = follow(overlay.uses) })
    }
    return changed
  }

  /**
   * The item's Markdown as it should be written into `destination`. Relative links and images resolve
   * from the recorded origin; for another folder they are rewritten to point at the same files, or the
   * insert is refused (and nothing is written anywhere) when a link cannot be carried.
   */
  async prepareInsert(id: string, destination: string): Promise<PreparedInsert> {
    let dest: string
    try { dest = this.documentPath(destination) } catch (error) { return { ok: false, error: (error as Error).message } }
    const item = await this.get(id)
    if (item.status !== 'active') return { ok: false, error: 'Move this item back to Candidates before inserting it.' }
    // A reference is never inserted as content (spec §5): its acts are Cite, Insert link and Attach,
    // and quoted evidence goes in only as Insert quote with citation. The generic insert refuses
    // both kinds rather than write their preview into the text.
    if (item.kind === 'ref') return { ok: false, error: 'A reference is cited, linked or attached, not inserted. Use Cite, Insert link or Attach to part.' }
    if (item.kind === 'evidence') return { ok: false, error: 'Use Insert quote with citation for quoted evidence.' }
    // An external candidate's payload is only its preview: inserting it first copies the
    // checked source bytes into this workspace (the external service's import path). The
    // generic preparation must never write the preview into a document as if it were the asset.
    if (item.external) return { ok: false, error: `This came from ${item.external.source === 'talkweaver' ? 'TalkWeaver' : 'SlideWell'}. Insert a copy in the Scratchpad copies the file into the document first.` }
    const fromDir = linkBase(item)
    if (item.kind !== 'text') {
      try { await validateScratchAsset(this.ws.root, fromDir ? `${fromDir}/_` : '_', item.kind, item.markdown) }
      catch (error) { return { ok: false, error: (error as Error).message } }
    }
    if (fromDir === dirOf(dest)) return { ok: true, markdown: item.markdown, rewritten: 0 }
    const escaping = escapingRelativeTargets(item.markdown, fromDir)
    if (escaping.length > 0) {
      return { ok: false, error: `This text links to ${escaping[0]}, outside this workspace, so it cannot be moved to another folder. Insert it into ${item.origin.path.split('/').pop()} or a document beside it.` }
    }
    const rebased = rebaseRelativeLinks(item.markdown, fromDir === '' ? '_' : `${fromDir}/_`, dest, (path) => path)
    return { ok: true, markdown: rebased.text, rewritten: rebased.rewritten }
  }

  /**
   * The sealed preview's bytes for a saved widget: the store's CURRENT payload (never the
   * panel's possibly stale copy) names the file, which is read once and compatibility-checked;
   * the returned html is exactly the checked page. `markdown` reports the payload the bytes
   * belong to, so the panel can refuse-and-refresh when its snapshot no longer matches.
   */
  async prepareWidgetPreview(id: string): Promise<PreparedWidgetPreview> {
    const item = await this.get(id)
    if (item.kind !== 'widget') return { ok: false, error: 'Only a widget can be run here.' }
    // An external widget's bytes live in its source (or its recorded local copy): the IPC
    // routes those through the external service's checked read. This backstop keeps the
    // store from ever treating the preview payload as a workspace widget line.
    if (item.external) return { ok: false, error: 'This widget is read from its source when it runs.' }
    if (item.status !== 'active') return { ok: false, error: 'Move this item back to Candidates before running it.' }
    const fromDir = linkBase(item)
    try {
      const checked = await readCheckedScratchWidget(this.ws.root, fromDir ? `${fromDir}/_` : '_', item.markdown)
      return { ok: true, ...checked, markdown: item.markdown }
    } catch (error) { return { ok: false, error: (error as Error).message } }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  #legacy(): Pick<ScrapStore, 'list' | 'toggleDone' | 'setColour' | 'remove' | 'removeAtOrigin' | 'exclusive'> {
    if (!this.scraps) throw new Error('Older scraps are not available here.')
    return this.scraps
  }

  #safeDocumentPath(path: string): string | null {
    try { return this.documentPath(path) } catch { return null }
  }

  #write<T>(op: () => Promise<T>): Promise<T> {
    return this.ws.exclusiveAll(async () => {
      assertCollectionWritable(this.ws.root)
      return op()
    })
  }

  async #recordIds(): Promise<string[]> {
    return (await this.#storeNames([])).filter((name) => name.endsWith('.json')).map((name) => name.slice(ITEM_PREFIX.length, -'.json'.length)).filter((id) => ITEM_ID.test(id))
  }

  async #storeNames(notices: string[]): Promise<string[]> {
    const folder = join(this.ws.root, STORE)
    try {
      const entry = lstatSync(folder)
      if (!entry.isDirectory()) { notices.push(`${STORE} is not an ordinary folder; the Scratchpad did not read it.`); return [] }
    } catch { return [] }
    return (await readdir(folder)).filter((name) => name.startsWith(ITEM_PREFIX)).sort()
  }

  async #readItem(id: string, notices: string[]): Promise<ScratchItem | null> {
    const loaded = await this.#readRecord(id, notices)
    if (!loaded) return null
    const payload = await readStoreFile(this.ws.root, payloadName(id))
    if (payload.state !== 'present') {
      notices.push(`The saved text of a Scratchpad item is missing: ${payloadName(id)}. Its record was left as it is.`)
      return null
    }
    const text = payload.bytes.toString('utf8')
    const item = itemOf(loaded.record, text)
    item.version = sha256(Buffer.concat([loaded.version.bytes, Buffer.from([0]), payload.bytes]))
    item.uses = markUses(item.uses, (this.options.liveHolders ? this.options.liveHolders() : currentScratchpadHolders(this.ws.root)))
    if (payload.bytes.length !== loaded.record.payload.bytes || sha256(payload.bytes) !== loaded.record.payload.sha256) {
      item.problem = 'This text was changed outside WriteFlex after it was set aside. It is shown as it is now.'
    }
    if ((item.kind === 'pic' || item.kind === 'svg' || item.kind === 'table' || item.kind === 'widget') && !item.external) {
      const base = linkBase(item)
      try { await validateScratchAsset(this.ws.root, base ? `${base}/_` : '_', item.kind, text) }
      catch (error) { item.problem = (error as Error).message }
    }
    if (item.external) {
      // Listing never touches the source apps (a disabled source must see no discovery at
      // all): the card carries its recorded compatibility verdict, and only the item's own
      // local copy — a file in THIS workspace — is checked for still being there.
      if (item.external.incompatible) item.problem = item.external.incompatible
      else if (item.external.importedPath) {
        let there = false
        try { const entry = lstatSync(join(this.ws.root, ...item.external.importedPath.split('/'))); there = entry.isFile() } catch { there = false }
        if (!there) item.problem = 'The copied file is not at its last known place in this workspace. The card keeps its source; inserting again will check the source first.'
      }
    }
    const lost = unverifiedNote(item)
    if (lost) item.problem = item.problem ? `${item.problem} ${lost}` : lost
    return item
  }

  async #readRecord(id: string, notices: string[]): Promise<{ record: ItemRecord; version: StoreFileVersion } | null> {
    if (!ITEM_ID.test(id)) { notices.push(`A Scratchpad record has an unexpected name: ${recordName(id)}. It was left as it is.`); return null }
    const read = await readStoreFile(this.ws.root, recordName(id))
    if (read.state === 'absent') return null
    if (read.state === 'refused') { notices.push(`${recordName(id)}: ${read.message}`); return null }
    const record = parseRecord(read.bytes.toString('utf8'), id)
    if (!record) { notices.push(`A Scratchpad record could not be read: ${recordName(id)}. It was left as it is.`); return null }
    if (record.withdrawn) return null
    return { record, version: { bytes: read.bytes, stamp: read.stamp } }
  }

  /** Read-only dependent authority, repeated inside the checked writer after staging metadata.
   * Keeps the writer's final-check/syscall limits; it is not a transaction over two files. */
  async #payloadAuthority(id: string, record: ItemRecord): Promise<() => Promise<void>> {
    const payload = await readStoreFile(this.ws.root, payloadName(id))
    const validate = async (): Promise<void> => {
      const now = await readStoreFile(this.ws.root, payloadName(id))
      if (payload.state !== 'present' || now.state !== 'present' ||
          !now.bytes.equals(payload.bytes) || now.bytes.length !== record.payload.bytes || sha256(now.bytes) !== record.payload.sha256 ||
          Object.keys(payload.stamp).some((key) => payload.stamp[key as keyof typeof payload.stamp] !== now.stamp[key as keyof typeof now.stamp])) {
        throw new Error('This copy was changed outside WriteFlex after it was sent, so it was kept.')
      }
    }
    await validate()
    return validate
  }

  async #update(id: string, mutate: (record: ItemRecord) => void, checkPayload = false): Promise<void> {
    if (!ITEM_ID.test(id)) throw new Error('This Scratchpad item is not there any more.')
    await this.#write(async () => {
      const notices: string[] = []
      const loaded = await this.#readRecord(id, notices)
      if (!loaded) throw new Error(notices[0] ?? 'This Scratchpad item is not there any more.')
      const validate = checkPayload ? await this.#payloadAuthority(id, loaded.record) : undefined
      mutate(loaded.record)
      await writeStoreFile(this.ws.root, recordName(id), `${JSON.stringify(loaded.record, null, 2)}\n`, { mode: 'replace', expect: loaded.version, validate })
    })
  }

  async #each(ids: readonly string[], record: (record: ItemRecord) => void, overlay: (overlay: LegacyOverlay) => void): Promise<void> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('Not a list of Scratchpad items.')
    const legacy = ids.filter((id) => LEGACY_ID.test(id))
    for (const id of ids) if (!LEGACY_ID.test(id)) await this.#update(id, record)
    if (legacy.length) await this.#overlay(legacy, overlay)
  }

  async #overlay(ids: readonly string[], mutate: (overlay: LegacyOverlay) => void): Promise<void> {
    await this.#write(async () => {
      const index = await this.#readIndex([], true)
      const legacy = { ...index.value.legacy }
      for (const id of ids) {
        const next = { ...(legacy[id] ?? {}) }
        mutate(next)
        legacy[id] = next
      }
      await this.#writeIndex({ ...index.value, legacy }, index.version)
    })
  }

  async #readIndex(notices: string[], strict = false): Promise<{ value: IndexRecord; version: StoreFileVersion | null }> {
    const empty: IndexRecord = { version: 1, groups: [], legacy: {} }
    const read = await readStoreFile(this.ws.root, INDEX)
    if (read.state === 'absent') return { value: empty, version: null }
    if (read.state === 'refused') {
      if (strict) throw new Error(read.message)
      notices.push(`${INDEX}: ${read.message}`)
      return { value: empty, version: null }
    }
    const value = parseIndex(read.bytes.toString('utf8'))
    if (!value) {
      // Never written over: the groups and legacy statuses it holds are the writer's.
      if (strict) throw new Error(`${INDEX} could not be read, so it was not changed. Groups and statuses of older scraps are unavailable until it is repaired.`)
      notices.push(`${INDEX} could not be read. It was left as it is; groups and statuses of older scraps are not shown.`)
      return { value: empty, version: null }
    }
    return { value, version: { bytes: read.bytes, stamp: read.stamp } }
  }

  async #writeIndex(value: IndexRecord, version: StoreFileVersion | null): Promise<void> {
    await writeStoreFile(this.ws.root, INDEX, `${JSON.stringify(value, null, 2)}\n`, version ? { mode: 'replace', expect: version } : { mode: 'create' })
  }
}

/** The folder an item's relative links resolve from. */
const linkBase = (item: Pick<ScratchItem, 'origin'>): string => item.origin.base ?? dirOf(item.origin.path)

/** A use whose editor session is gone (or that predates sessions) cannot be confirmed: said so on the use. */
function markUses(uses: ScratchUse[], live: ReadonlySet<string>): ScratchUse[] {
  return uses.map((use) => (use.holder !== undefined && live.has(use.holder) ? use : { ...use, unverified: true }))
}

/** Read-only: the lossless items of `ws`, for the Board, the agent's scrap list and the command line. */
export async function readLosslessItems(ws: Workspace, notices: string[] = []): Promise<ScratchItem[]> {
  return new ScratchpadStore(ws, null).listLossless(notices)
}

function itemOf(record: ItemRecord, markdown: string): ScratchItem {
  const title = record.external
    ? record.external.title
    : record.sourceRef
      ? (record.sourceRef.sourceTitle?.trim() || record.sourceRef.label || fragmentTitle(markdown))
      : record.kind === 'text' ? fragmentTitle(markdown) : documentAssets(record.origin.path, markdown, 'disk')[0]?.title ?? fragmentTitle(markdown)
  return {
    id: record.id, source: 'lossless', kind: record.kind, how: record.how, by: record.by, createdAt: record.createdAt,
    origin: record.origin, title, markdown, group: record.group, status: record.status,
    done: record.done, ...(record.colour ? { colour: record.colour } : {}), uses: record.uses,
    ...(record.sourceRef ? { ref: record.sourceRef } : {}),
    ...(record.external ? { external: record.external } : {}),
  }
}

/** A workspace-relative imported-asset path: a plain file directly inside an `assets/` folder. */
export const isImportedAssetPath = (path: string): boolean =>
  typeof path === 'string' && !path.includes('\0') && !path.includes('\\') && !path.startsWith('/')
  && /^(?:[^/.][^/]*\/)*assets\/[^/]+$/.test(path) && !path.split('/').includes('..')

function validExternalRef(ref: unknown): ref is ScratchExternalRef {
  const r = ref as ScratchExternalRef | null
  return !!r && typeof r === 'object'
    && (r.source === 'talkweaver' || r.source === 'slidewell')
    && isString(r.providerId) && r.providerId.length > 0 && r.providerId.length <= 2000 && !/[\r\n\0]/.test(r.providerId)
    && (r.kind === 'pic' || r.kind === 'widget')
    && isString(r.fileName) && r.fileName.length > 0 && r.fileName.length <= 300 && !/[/\\\r\n\0]/.test(r.fileName)
    && isString(r.title) && r.title.length <= 500
    && isString(r.provenance) && r.provenance.length <= 500 && !/[\r\n\0]/.test(r.provenance)
    && isString(r.sha256) && /^[0-9a-f]{64}$/.test(r.sha256)
    && typeof r.bytes === 'number' && Number.isSafeInteger(r.bytes) && r.bytes >= 0
    && (r.score === undefined || (typeof r.score === 'number' && Number.isFinite(r.score) && r.score >= 0 && r.score <= 1))
    && isNullableString(r.incompatible)
    && (r.previewDataUri === undefined || (isString(r.previewDataUri) && r.previewDataUri.length <= 600_000 && r.previewDataUri.startsWith('data:image/')))
    && (r.importedPath === undefined || isImportedAssetPath(r.importedPath))
    && (r.importedSha256 === undefined || (isString(r.importedSha256) && /^[0-9a-f]{64}$/.test(r.importedSha256)))
    && (r.importedPath === undefined) === (r.importedSha256 === undefined)
}

const isNullableString = (v: unknown): v is string | null | undefined => v === undefined || v === null || typeof v === 'string'
function validSourceRef(ref: unknown): ref is ScratchSourceRef {
  const r = ref as ScratchSourceRef | null
  return !!r && typeof r === 'object' && isString(r.sourceId) && r.sourceId.length > 0 && r.sourceId.length <= 8000
    && isString(r.citationId) && r.citationId.length > 0 && r.citationId.length <= 4000
    && ['file', 'note', 'zotero', 'archive'].includes(r.evidenceKind)
    && isString(r.target) && r.target.length > 0 && r.target.length <= 4000 && !/[\r\n\0]/.test(r.target)
    && isString(r.label) && r.label.length <= 1000
    && isNullableString(r.sourceTitle) && isNullableString(r.highlightTarget) && isNullableString(r.highlightLabel)
    && (r.quote === undefined || r.quote === null || (isString(r.quote) && r.quote.length <= 100000))
    && isNullableString(r.sourcePath) && isNullableString(r.sourcePart) && isNullableString(r.state)
    && (r.attachedParts === undefined || (Array.isArray(r.attachedParts) && r.attachedParts.length <= 200 && r.attachedParts.every(isString)))
}

const validCapturedSpan = (span: unknown): span is { from: number; to: number; line: number } => {
  const value = span as { from: number; to: number; line: number } | undefined
  return !!value && Number.isSafeInteger(value.from) && value.from >= 0 && Number.isSafeInteger(value.to) && value.to >= value.from && Number.isSafeInteger(value.line) && value.line >= 1
}
const isString = (v: unknown): v is string => typeof v === 'string'
const isUse = (v: unknown): v is ScratchUse => {
  const u = v as ScratchUse
  return !!u && isString(u.useId) && isString(u.path) && isString(u.at) && (u.mode === 'copy' || u.mode === 'put-back') && (u.holder === undefined || isString(u.holder)) && (u.historical === undefined || u.historical === true)
}

function parseRecord(text: string, id: string): ItemRecord | null {
  let raw: Partial<ItemRecord>
  try { raw = JSON.parse(text) as Partial<ItemRecord> } catch { return null }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || raw.id !== id || !['text', 'pic', 'svg', 'table', 'widget', 'ref', 'evidence'].includes(raw.kind ?? '')) return null
  if ((raw.kind === 'ref' || raw.kind === 'evidence') ? !validSourceRef(raw.sourceRef) : raw.sourceRef !== undefined) return null
  // Additive (ticket 05): an external pointer belongs only on a picture/widget candidate and
  // never beside a canonical source pointer. A record without one reads exactly as before.
  if (raw.external !== undefined && (!validExternalRef(raw.external) || (raw.kind !== 'pic' && raw.kind !== 'widget') || raw.external.kind !== raw.kind || raw.sourceRef !== undefined)) return null
  if (raw.withdrawn !== undefined && raw.withdrawn !== true) return null
  if (raw.cutClaim !== undefined && !isString(raw.cutClaim)) return null
  // An unshipped draft `consumed` field, if a draft record still carries one, is dropped on read:
  // copy-for-reuse retains the candidate, so the item is simply a candidate again.
  if (raw.how !== 'cut' && raw.how !== 'copy') return null
  if (raw.by !== 'writer' && raw.by !== 'agent') return null
  if (!isString(raw.createdAt) || !raw.origin || !isString(raw.origin.path)) return null
  if (raw.status !== 'active' && raw.status !== 'rejected') return null
  if (!Array.isArray(raw.uses) || !raw.uses.every(isUse)) return null
  if (!raw.payload || typeof raw.payload.bytes !== 'number' || !isString(raw.payload.sha256)) return null
  return {
    version: 1, ...(raw.withdrawn === true ? { withdrawn: true as const } : {}), ...(isString(raw.cutClaim) ? { cutClaim: raw.cutClaim } : {}), id, kind: raw.kind!, how: raw.how, by: raw.by, createdAt: raw.createdAt,
    origin: { path: raw.origin.path, heading: isString(raw.origin.heading) ? raw.origin.heading : null, ...(isString(raw.origin.base) ? { base: raw.origin.base } : {}), ...(validCapturedSpan(raw.origin.capturedSpan) ? { capturedSpan: raw.origin.capturedSpan } : {}) },
    group: isString(raw.group) ? raw.group : null, status: raw.status, done: raw.done === true,
    colour: isString(raw.colour) ? raw.colour : null, uses: raw.uses, payload: { bytes: raw.payload.bytes, sha256: raw.payload.sha256 },
    ...(raw.sourceRef ? { sourceRef: raw.sourceRef } : {}),
    ...(raw.external ? { external: raw.external } : {}),
  }
}

function parseIndex(text: string): IndexRecord | null {
  let raw: Partial<IndexRecord>
  try { raw = JSON.parse(text) as Partial<IndexRecord> } catch { return null }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.groups) || !raw.legacy || typeof raw.legacy !== 'object') return null
  if (!raw.groups.every((g) => g && isString(g.id) && isString(g.name))) return null
  const legacy: Record<string, LegacyOverlay> = {}
  for (const [key, value] of Object.entries(raw.legacy)) {
    if (!value || typeof value !== 'object') return null
    const v = value as LegacyOverlay
    legacy[key] = {
      ...(v.status === 'active' || v.status === 'rejected' ? { status: v.status } : {}),
      ...(isString(v.group) || v.group === null ? { group: v.group } : {}),
      ...(Array.isArray(v.uses) ? { uses: v.uses.filter(isUse) } : {}),
    }
  }
  return { version: 1, groups: raw.groups, legacy }
}

/** Relative link, image and embed targets in `source` that, read from `fromDir`, leave the workspace. */
export function escapingRelativeTargets(source: string, fromDir: string): string[] {
  const out: string[] = []
  const escapes = (decoded: string): boolean => {
    const resolved = posix.normalize(posix.join(fromDir === '' ? '.' : fromDir, decoded))
    return resolved === '..' || resolved.startsWith('../')
  }
  const cursor = parseMarkdown(source).cursor()
  do {
    if (cursor.name !== 'URL') continue
    const parent = cursor.node.parent?.name
    if (parent !== 'Link' && parent !== 'Image' && parent !== 'LinkReference') continue
    const raw = source.slice(cursor.from, cursor.to)
    const inner = raw.startsWith('<') && raw.endsWith('>') && raw.length >= 2 ? raw.slice(1, -1) : raw
    const read = readDestination(inner)
    if (read && escapes(read.segments.map((s) => s.name).join('/'))) out.push(unescapeDestination(inner))
  } while (cursor.next())
  const code = scanMarkdownCodeRanges(source)
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g
  for (let match = linePattern.exec(source); match && match[0] !== ''; match = linePattern.exec(source)) {
    const embed = embedLine(match[0].replace(/[\r\n]+$/, ''))
    if (!embed || embed.refusal || code.some((range) => match!.index >= range.from && match!.index < range.to)) continue
    if (!/^(?:[a-z][a-z0-9+.-]*:|[/#?])/i.test(embed.path) && escapes(embed.path)) out.push(embed.path)
  }
  return out
}
