/**
 * The read-only SlideWell adapter (ticket 05), adapted from TalkWeaver's SlideWell provider
 * and picture-query client (slidewell-provider.ts, slidewell-query.ts — the contract both
 * apps share). Two different things are kept apart, as the design requires:
 *
 *   - the readable CATALOGUE (`well.db` / `triage.db` in SlideWell's well folder), word-searched
 *     and browsed with the app closed, through the app's existing read-only SQLite driver.
 *     Every connection is opened read-only, waits at most 250 ms for SlideWell's lock, and is
 *     closed after one bounded read; nothing SlideWell owns is ever written. What SlideWell
 *     hides stays hidden: emptied items and screenshots whose 30-day Bin clock ran out are
 *     excluded by the same rule its review uses, and when the decisions that say what is
 *     emptied cannot be read, anything that could be emptied is left out (fail closed).
 *   - the SEMANTIC picture service, which needs SlideWell's running process and model: one
 *     bounded request line over its user-owned Unix socket (`picture-query.sock`, contract
 *     v1: 4 KB request, 1 MB response, one line each way), never a network or cloud call, and
 *     SlideWell is never launched from here.
 *
 * A result's file is resolved only from its own catalogue row — SlideWell's well folder, the
 * one vault root SlideWell's snapshot scanned (`talk_usage_meta`), or a screenshot's own
 * source folder — and read through the contained no-follow reader. Serving and importing
 * re-read the item's listed state at that moment, never the search-time copy.
 */
import { lstatSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, isAbsolute, join, posix } from 'node:path'
import type { SqliteDatabase, SqliteDriver } from '@readflex/sqlite-driver'
import { readContainedFile } from './widget-file'
import { scratchpadSourceHome } from './scratchpad-source-home'
import { EXTERNAL_ASSET_MAX_BYTES } from './scratchpad-talkweaver'

export const PICTURE_QUERY_SOCKET = 'picture-query.sock'
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_REQUEST_BYTES = 4096
const READ_BUSY_MS = 250
const LIMIT = 60
const BIN_AFTER_DAYS = 30
const CONFIG_MAX_BYTES = 1024 * 1024
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'svg'])

export type SlideWellLocation = { wellRoot: string; socketPath: string }

export type SlideWellCandidate = {
  /** SlideWell's own identity: `well:<id>` or `triage:<hash>`. */
  providerId: string
  fileName: string
  ext: string
  title: string
  detail: string
  /** Where SlideWell says it came from (`screenshot`, `added-image`, `talk-image`). */
  origin: string
  score?: number
}

type TriageRow = { hash: string; rel_path: string; filename: string | null; ocr_text: string | null; source: string | null; taken_at: string | null; app: string | null; window_title: string | null; mtime: string | null; well_id: string | null }
type WellRow = { id: string; slug: string | null; rel_path: string; root: string | null; source: string | null; tags: string | null; ocr_text: string | null; added_at: string | null; source_hash: string | null }

type Ctx = {
  wellRoot: string
  wellDb: string | null
  triageDb: string | null
  /** 'unknown': triage.db is there but unreadable now — what is emptied is unknown. */
  triageState: 'ok' | 'absent' | 'unknown'
  hasDecisions: boolean
  hasProposals: boolean
  hasSince: boolean
  hasWellSources: boolean
  hasUsageMeta: boolean
  emptiedHashes: ReadonlySet<string> | null // null: the emptied set could not be read
}

/** SlideWell's user-data folders (packaged name first, then the dev name). */
export function slidewellUserDataDirs(home: string): string[] {
  const support = join(home, 'Library', 'Application Support')
  return [join(support, 'SlideWell'), join(support, 'slidewell')]
}

/** One request line, or null when the request would break the v1 contract. */
export function encodePictureRequest(text: string, limit: number): string | null {
  const clean = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim()
  if (!clean) return null
  const n = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 60)))
  const line = JSON.stringify({ v: 1, op: 'picture-query', text: clean, limit: n }) + '\n'
  return Buffer.byteLength(line) <= MAX_REQUEST_BYTES ? line : null
}

export type PictureHit = { id: string; score: number }
export type PictureAnswer =
  | { ok: true; hits: PictureHit[] }
  | { ok: false; reason: 'not-running' | 'refused' | 'timeout' | 'model-not-ready' | 'busy' | 'bad-request' | 'bad-response' }

/** Parse one response line strictly: wrong shapes become bad-response, never thrown. */
export function decodePictureResponse(line: string): PictureAnswer {
  let msg: unknown
  try { msg = JSON.parse(line) } catch { return { ok: false, reason: 'bad-response' } }
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'bad-response' }
  const m = msg as { v?: unknown; ok?: unknown; hits?: unknown; reason?: unknown }
  if (m.v !== 1) return { ok: false, reason: 'bad-response' }
  if (m.ok === false) {
    const reason = m.reason === 'model-not-ready' || m.reason === 'busy' || m.reason === 'bad-request' ? m.reason : 'bad-response'
    return { ok: false, reason }
  }
  if (m.ok !== true || !Array.isArray(m.hits)) return { ok: false, reason: 'bad-response' }
  const hits: PictureHit[] = []
  for (const h of m.hits as unknown[]) {
    const x = h as { id?: unknown; score?: unknown }
    if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 512) continue
    const score = typeof x.score === 'number' && Number.isFinite(x.score) ? Math.max(0, Math.min(1, x.score)) : null
    if (score === null) continue
    hits.push({ id: x.id, score })
  }
  return { ok: true, hits }
}

/** Is this path a socket owned by the current user? (Anything else is refused, unconnected.) */
export function socketIsOurs(path: string): boolean {
  try {
    const st = lstatSync(path)
    if (!st.isSocket()) return false
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || st.uid === uid
  } catch { return false }
}

/** Ask SlideWell's running picture service for matches. Never throws; silence is an answer. */
export function askPictureQuery(socketPath: string, text: string, limit = 60, timeoutMs = 2000): Promise<PictureAnswer> {
  const request = encodePictureRequest(text, limit)
  if (!request) return Promise.resolve({ ok: false, reason: 'bad-request' })
  try { lstatSync(socketPath) } catch { return Promise.resolve({ ok: false, reason: 'not-running' }) }
  if (!socketIsOurs(socketPath)) return Promise.resolve({ ok: false, reason: 'refused' })
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    let size = 0
    const sock = connect({ path: socketPath })
    const done = (answer: PictureAnswer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs)
    sock.on('connect', () => sock.write(request))
    sock.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) return done({ ok: false, reason: 'bad-response' })
      chunks.push(chunk)
      if (chunk.indexOf(10) >= 0) {
        const all = Buffer.concat(chunks).toString('utf8')
        done(decodePictureResponse(all.slice(0, all.indexOf('\n'))))
      }
    })
    sock.on('end', () => {
      const all = Buffer.concat(chunks).toString('utf8').trim()
      done(all ? decodePictureResponse(all) : { ok: false, reason: 'bad-response' })
    })
    sock.on('error', () => done({ ok: false, reason: 'not-running' }))
  })
}

/** FTS5 query: each word quoted (never syntax) and prefix-matched; '' when nothing is left. */
export function ftsQuery(words: string[]): string {
  return words.map((w) => w.replace(/"/g, '').trim()).filter(Boolean).map((w) => `"${w}"*`).join(' ')
}

const queryWords = (query: string): string[] => query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12)
const extOf = (path: string): string => (path.split('.').pop() || '').toLowerCase()
const isoDay = (s: string | null | undefined): string | undefined => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined)

export type SlideWellAdapterOptions = {
  home?: string
  /** The read-only SQLite driver (production: node:sqlite through the shared driver; tests: bun's). */
  driver: () => SqliteDriver
  askPictures?: (socketPath: string, text: string, limit: number) => Promise<PictureAnswer>
  now?: () => number
}

export class SlideWellAdapter {
  readonly home: string
  readonly #driver: () => SqliteDriver
  readonly #ask: (socketPath: string, text: string, limit: number) => Promise<PictureAnswer>
  readonly #now: () => number

  constructor(options: SlideWellAdapterOptions) {
    this.home = options.home ?? scratchpadSourceHome()
    this.#driver = options.driver
    this.#ask = options.askPictures ?? ((socket, text, limit) => askPictureQuery(socket, text, limit))
    this.#now = options.now ?? Date.now
  }

  /** SlideWell's store from its own config (`wellRoot`), else its default; null when absent. */
  async locate(): Promise<SlideWellLocation | null> {
    for (const dir of slidewellUserDataDirs(this.home)) {
      let dirReal: string
      try { dirReal = await realpath(dir) } catch { continue }
      let wellRoot = join(this.home, 'SlideWell', 'well')
      let configured = false
      const config = await readContainedFile(dirReal, 'config.json', CONFIG_MAX_BYTES)
      if (config.ok) {
        try {
          const cfg = JSON.parse(config.bytes.toString('utf8')) as { wellRoot?: unknown }
          configured = true
          if (typeof cfg.wellRoot === 'string' && isAbsolute(cfg.wellRoot)) wellRoot = cfg.wellRoot
        } catch { /* an unreadable config still proves the app is here; the default root decides */ }
      }
      const hasStore = ['well.db', 'triage.db'].some((name) => { try { return lstatSync(join(wellRoot, name)).isFile() } catch { return false } })
      if (hasStore) return { wellRoot, socketPath: join(dir, PICTURE_QUERY_SOCKET) }
      if (configured) return null
    }
    return null
  }

  /** Whether the readable catalogue answers now (its schema can be read), without any query text. */
  async catalogueReadable(location: SlideWellLocation): Promise<boolean> {
    return (await this.#context(location)) !== null
  }

  /** Whether the semantic picture service is running (its user-owned socket is there). */
  semanticRunning(location: SlideWellLocation): boolean {
    return socketIsOurs(location.socketPath)
  }

  #open(dbPath: string): SqliteDatabase {
    const db = this.#driver().open(dbPath, { readonly: true })
    try { db.run(`PRAGMA busy_timeout=${READ_BUSY_MS}`) } catch { /* a refused pragma must not fail the read */ }
    return db
  }

  async #context(location: SlideWellLocation): Promise<Ctx | null> {
    const wellDb = (() => { try { return lstatSync(join(location.wellRoot, 'well.db')).isFile() ? join(location.wellRoot, 'well.db') : null } catch { return null } })()
    const triageDbPath = (() => { try { return lstatSync(join(location.wellRoot, 'triage.db')).isFile() ? join(location.wellRoot, 'triage.db') : null } catch { return null } })()
    if (!wellDb && !triageDbPath) return null
    const ctx: Ctx = {
      wellRoot: location.wellRoot, wellDb, triageDb: triageDbPath,
      triageState: triageDbPath ? 'ok' : 'absent',
      hasDecisions: false, hasProposals: false, hasSince: false, hasWellSources: false, hasUsageMeta: false,
      emptiedHashes: new Set(),
    }
    const names = (dbPath: string | null): Set<string> | null => {
      if (!dbPath) return new Set()
      let db: SqliteDatabase | null = null
      try {
        db = this.#open(dbPath)
        const rows = db.all("SELECT name FROM sqlite_master WHERE type IN ('table','view')") as Array<{ name: string }>
        return new Set(rows.map((r) => r.name))
      } catch { return null } finally { try { db?.close() } catch { /* closed */ } }
    }
    const wellNames = names(wellDb)
    const triageNames = names(triageDbPath)
    if (!wellNames || !wellNames.has('well_fts')) ctx.wellDb = null
    ctx.hasWellSources = !!wellNames?.has('well_sources')
    ctx.hasUsageMeta = !!wellNames?.has('talk_usage_meta')
    if (triageDbPath && !triageNames) {
      ctx.triageState = 'unknown'
      ctx.triageDb = null
      ctx.emptiedHashes = null
    } else if (triageDbPath && triageNames) {
      ctx.hasDecisions = triageNames.has('triage_decisions')
      if (!ctx.hasDecisions) ctx.triageState = 'absent'
      if (!triageNames.has('triage_fts') || !ctx.hasDecisions) ctx.triageDb = null
      if (ctx.hasDecisions) {
        // The emptied identities, read once per context (bounded): well items are hidden by
        // content identity, as SlideWell hides them. An unreadable set fails closed below.
        let db: SqliteDatabase | null = null
        try {
          db = this.#open(triageDbPath)
          const rows = db.all("SELECT hash FROM triage_decisions WHERE state = 'emptied' LIMIT 20000") as Array<{ hash: string }>
          ctx.emptiedHashes = new Set(rows.map((r) => r.hash))
        } catch { ctx.emptiedHashes = null } finally { try { db?.close() } catch { /* closed */ } }
      }
      if (ctx.triageDb && triageNames.has('sorter_proposals')) {
        ctx.hasProposals = true
        let db: SqliteDatabase | null = null
        try {
          db = this.#open(ctx.triageDb)
          const cols = db.all("SELECT name FROM pragma_table_info('sorter_proposals')") as Array<{ name: string }>
          ctx.hasSince = cols.some((c) => c.name === 'throwaway_since')
        } catch { ctx.triageDb = null } finally { try { db?.close() } catch { /* closed */ } }
      }
    }
    return ctx.wellDb || ctx.triageDb ? ctx : null
  }

  /** A screenshot SlideWell no longer lists: emptied, or in the Bin (30 days in Throwaway). */
  #hiddenTriageSql(ctx: Ctx, nowIso: string): { sql: string; params: string[] } {
    const clock = `julianday(?) - ${BIN_AFTER_DAYS}`
    let sql = `COALESCE(d.state, 'undecided') = 'emptied' OR (d.state = 'excluded' AND julianday(d.decided_at) <= ${clock})`
    const params = [nowIso]
    if (ctx.hasProposals) {
      const since = ctx.hasSince ? 'COALESCE(p.throwaway_since, p.proposed_at)' : 'p.proposed_at'
      sql += ` OR (COALESCE(d.state, 'undecided') NOT IN ('selected', 'included', 'excluded', 'emptied') AND p.proposal = 'throwaway' AND julianday(${since}) <= ${clock})`
      params.push(nowIso)
    }
    return { sql: `COALESCE((${sql}), 0)`, params }
  }

  #triageRows(ctx: Ctx, where: string, params: Array<string | number>, order: string, limit = LIMIT): TriageRow[] {
    if (!ctx.triageDb) return []
    const hidden = this.#hiddenTriageSql(ctx, new Date(this.#now()).toISOString())
    const joinSql = `triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash${ctx.hasProposals ? ' LEFT JOIN sorter_proposals p ON p.hash = triage_fts.hash' : ''}`
    let db: SqliteDatabase | null = null
    try {
      db = this.#open(ctx.triageDb)
      return db.all(
        `SELECT triage_fts.hash, triage_fts.rel_path, triage_fts.filename, triage_fts.ocr_text, triage_fts.source, triage_fts.taken_at, triage_fts.app, triage_fts.window_title, triage_fts.mtime, d.well_id
         FROM ${joinSql}
         WHERE ${where} AND triage_fts.kind = 'image' AND triage_fts.offline != '1' AND NOT ${hidden.sql}
         ${order} LIMIT ?`,
        ...params, ...hidden.params, limit,
      ) as TriageRow[]
    } catch { return [] } finally { try { db?.close() } catch { /* closed */ } }
  }

  #wellRows(ctx: Ctx, where: string, params: Array<string | number>, order: string, limit = LIMIT): WellRow[] {
    if (!ctx.wellDb) return []
    const sourceHash = ctx.hasWellSources ? '(SELECT ws.source_hash FROM well_sources ws WHERE ws.well_id = well_fts.id LIMIT 1)' : 'NULL'
    // When the emptied set could not be read, no screenshot-backed well item is listed at all.
    const unknowable = ctx.hasWellSources && ctx.emptiedHashes === null
      ? ' AND well_fts.id NOT IN (SELECT ws.well_id FROM well_sources ws)' : ''
    let db: SqliteDatabase | null = null
    try {
      db = this.#open(ctx.wellDb)
      const rows = db.all(
        `SELECT well_fts.id, well_fts.slug, well_fts.rel_path, well_fts.root, well_fts.source, well_fts.tags, well_fts.ocr_text, well_fts.added_at, ${sourceHash} AS source_hash
         FROM well_fts WHERE ${where}${unknowable} ${order} LIMIT ?`,
        ...params, limit,
      ) as WellRow[]
      const emptied = ctx.emptiedHashes
      return emptied ? rows.filter((row) => !(row.source_hash && emptied.has(row.source_hash))) : rows
    } catch { return [] } finally { try { db?.close() } catch { /* closed */ } }
  }

  /** The one vault root SlideWell's snapshot scanned, when its catalogue says so. */
  #scannedVaultRoot(ctx: Ctx): string | null {
    if (!ctx.wellDb || !ctx.hasUsageMeta) return null
    let db: SqliteDatabase | null = null
    try {
      db = this.#open(ctx.wellDb)
      const row = db.get("SELECT value FROM talk_usage_meta WHERE key = 'vault_root'") as { value?: string } | undefined
      return typeof row?.value === 'string' && isAbsolute(row.value) ? row.value : null
    } catch { return null } finally { try { db?.close() } catch { /* closed */ } }
  }

  /** Where a catalogue row's file is, as (root, relative path) for the contained reader. */
  #fileOf(ctx: Ctx, row: WellRow | TriageRow, scannedVault: string | null): { root: string; rel: string } | null {
    const containedRel = (relPath: string): string | null => {
      if (!relPath || relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/')) return null
      const normal = posix.normalize(relPath)
      return normal === relPath && !normal.startsWith('../') && normal !== '..' ? normal : null
    }
    if ('hash' in row) {
      if (!row.source || !isAbsolute(row.source)) return null
      const rel = containedRel(row.rel_path)
      return rel && IMAGE_EXTS.has(extOf(rel)) ? { root: row.source, rel } : null
    }
    const rel = containedRel(row.rel_path)
    if (!rel || !IMAGE_EXTS.has(extOf(rel))) return null
    if (row.root === 'vault') return scannedVault ? { root: scannedVault, rel } : null
    return { root: ctx.wellRoot, rel }
  }

  async #candidates(ctx: Ctx, triage: TriageRow[], well: WellRow[], scoreOf: (providerId: string) => number | undefined): Promise<SlideWellCandidate[]> {
    const scannedVault = this.#scannedVaultRoot(ctx)
    const wellById = new Map(well.map((row) => [row.id, row]))
    const missing = [...new Set(triage.map((row) => row.well_id || '').filter((id) => id && !wellById.has(id)))]
    if (missing.length) {
      for (const row of this.#wellRows(ctx, `well_fts.id IN (${missing.map(() => '?').join(',')})`, missing, '', missing.length * 2)) wellById.set(row.id, row)
    }
    const out: SlideWellCandidate[] = []
    const taken = new Set<string>()
    const usable = async (where: { root: string; rel: string } | null): Promise<boolean> => {
      if (!where) return false
      let realRoot: string
      try { realRoot = await realpath(where.root) } catch { return false }
      const read = await readContainedFile(realRoot, where.rel, 1)
      // 'too-large' here only means "a real contained file exists" (the cap is one byte on
      // purpose: existence is judged now, the bytes are read when a handle is issued).
      return read.ok || read.reason === 'too-large'
    }
    for (const row of triage) {
      const wellRow = row.well_id ? wellById.get(row.well_id) : undefined
      const providerId = row.well_id ? `well:${row.well_id}` : `triage:${row.hash}`
      if (taken.has(providerId) || taken.has(`triage:${row.hash}`)) continue
      const where = (wellRow ? this.#fileOf(ctx, wellRow, scannedVault) : null) ?? this.#fileOf(ctx, row, scannedVault)
      if (!(await usable(where))) continue
      taken.add(providerId); taken.add(`triage:${row.hash}`)
      const fileName = basename(where!.rel)
      const date = isoDay(row.taken_at) ?? (Number(row.mtime) ? new Date(Number(row.mtime)).toISOString().slice(0, 10) : undefined)
      out.push({
        providerId, fileName, ext: extOf(fileName), origin: 'screenshot',
        title: row.window_title || row.filename || fileName,
        detail: [row.app || '', date || ''].filter(Boolean).join(' · '),
        ...(scoreOf(providerId) !== undefined ? { score: scoreOf(providerId) } : {}),
      })
    }
    for (const row of well) {
      const providerId = `well:${row.id}`
      if (taken.has(providerId) || (row.source_hash && taken.has(`triage:${row.source_hash}`))) continue
      const where = this.#fileOf(ctx, row, scannedVault)
      if (!(await usable(where))) continue
      taken.add(providerId)
      if (row.source_hash) taken.add(`triage:${row.source_hash}`)
      const fileName = basename(where!.rel)
      const talk = row.root === 'vault' || row.source === 'talkweaver'
      out.push({
        providerId, fileName, ext: extOf(fileName), origin: talk ? 'talk-image' : 'added-image',
        title: (row.slug || '').replace(/-/g, ' ').trim() || fileName,
        detail: isoDay(row.added_at) ?? '',
        ...(scoreOf(providerId) !== undefined ? { score: scoreOf(providerId) } : {}),
      })
    }
    return out
  }

  /** Word search over the readable catalogue; an empty query browses the newest entries. */
  async searchWords(location: SlideWellLocation, query: string): Promise<SlideWellCandidate[] | null> {
    const ctx = await this.#context(location)
    if (!ctx) return null
    const words = queryWords(query)
    const fts = ftsQuery(words)
    let triage: TriageRow[]
    let well: WellRow[]
    if (fts === '') {
      triage = this.#triageRows(ctx, '1 = 1', [], 'ORDER BY triage_fts.taken_at DESC')
      well = this.#wellRows(ctx, '1 = 1', [], 'ORDER BY well_fts.added_at DESC')
    } else {
      triage = this.#triageRows(ctx, 'triage_fts MATCH ?', [fts], 'ORDER BY rank')
      const byText = this.#wellRows(ctx, 'well_fts MATCH ?', [fts], 'ORDER BY rank')
      const byNameWhere = words.map(() => "(lower(COALESCE(well_fts.slug, '')) LIKE ? OR lower(COALESCE(well_fts.rel_path, '')) LIKE ?)").join(' AND ')
      const byNameParams = words.flatMap((word) => [`%${word.replace(/[\\%_]/g, (m) => '\\' + m)}%`, `%${word.replace(/[\\%_]/g, (m) => '\\' + m)}%`])
      const byName = this.#wellRows(ctx, byNameWhere, byNameParams, 'ORDER BY well_fts.added_at DESC')
      const seen = new Set(byText.map((row) => row.id))
      well = [...byText, ...byName.filter((row) => !seen.has(row.id))]
    }
    return (await this.#candidates(ctx, triage, well, () => undefined)).slice(0, LIMIT)
  }

  /** Semantic search: the running service ranks; the catalogue still vouches for every file. */
  async searchMeaning(location: SlideWellLocation, query: string): Promise<{ candidates: SlideWellCandidate[] } | { refusal: string }> {
    const answer = await this.#ask(location.socketPath, query, LIMIT).catch((): PictureAnswer => ({ ok: false, reason: 'not-running' }))
    if (!answer.ok) {
      return {
        refusal: answer.reason === 'model-not-ready' ? 'SlideWell is running, but its picture model is not ready yet.'
          : answer.reason === 'busy' ? 'SlideWell is busy just now. Try again in a moment.'
          : answer.reason === 'timeout' ? 'SlideWell did not answer in time.'
          : 'SlideWell is not running, so semantic picture search is unavailable. Word search over its catalogue still works.',
      }
    }
    const ctx = await this.#context(location)
    if (!ctx) return { refusal: 'SlideWell answered, but its catalogue could not be read, so nothing was shown.' }
    const scores = new Map<string, number>()
    const wellIds: string[] = []
    const hashes: string[] = []
    for (const hit of answer.hits) {
      if (scores.has(hit.id)) continue
      const colon = hit.id.indexOf(':')
      const kind = hit.id.slice(0, colon)
      const id = hit.id.slice(colon + 1)
      if (kind === 'well' && /^[0-9a-f]{7,64}$/i.test(id)) wellIds.push(id)
      else if (kind === 'triage' && /^[0-9a-f]{6,64}$/i.test(id)) hashes.push(id)
      else continue // old slides and unknown kinds are not this surface's to import
      scores.set(hit.id, hit.score)
    }
    if (scores.size === 0) return { candidates: [] }
    const inList = (n: number): string => Array.from({ length: n }, () => '?').join(',')
    const well = wellIds.length ? this.#wellRows(ctx, `well_fts.id IN (${inList(wellIds.length)})`, wellIds, '', wellIds.length * 2) : []
    for (const row of well) if (row.source_hash && !hashes.includes(row.source_hash)) hashes.push(row.source_hash)
    const triage = hashes.length ? this.#triageRows(ctx, `triage_fts.hash IN (${inList(hashes.length)})`, hashes, '', hashes.length * 2) : []
    const rank = new Map([...scores.keys()].map((id, i) => [id, i]))
    const candidates = await this.#candidates(ctx, triage, well, (providerId) => scores.get(providerId))
    return { candidates: candidates.sort((a, b) => (rank.get(a.providerId) ?? Infinity) - (rank.get(b.providerId) ?? Infinity)) }
  }

  /**
   * The checked bytes behind one SlideWell identity, re-derived now: the item must still be
   * listed (not emptied, not in the Bin) and its file a plain contained file. Duplicate ids
   * across the two stores stay distinct — `well:` and `triage:` are different identities, and
   * a well item behind a screenshot resolves to the well's own copy first, as SlideWell serves it.
   */
  async readChecked(location: SlideWellLocation, providerId: string): Promise<{ ok: true; bytes: Buffer; candidate: SlideWellCandidate } | { ok: false; error: string }> {
    const parsed = parseSlideWellProviderId(providerId)
    if (!parsed) return { ok: false, error: 'That SlideWell result cannot be read safely.' }
    const ctx = await this.#context(location)
    if (!ctx) return { ok: false, error: 'SlideWell’s catalogue could not be read.' }
    const well = parsed.kind === 'well'
      ? this.#wellRows(ctx, 'well_fts.id = ?', [parsed.id], '', 2)
      : []
    // A kept screenshot matched by its well id still shows its app, window and date.
    const triage = parsed.kind === 'triage'
      ? this.#triageRows(ctx, 'triage_fts.hash = ?', [parsed.id], '', 2)
      : well[0]?.source_hash ? this.#triageRows(ctx, 'triage_fts.hash = ?', [well[0].source_hash], '', 2) : []
    const wellRows = parsed.kind === 'well' ? well
      : triage[0]?.well_id ? this.#wellRows(ctx, 'well_fts.id = ?', [triage[0].well_id], '', 2) : []
    // A triage identity whose screenshot has since been kept into the well is served as the
    // well item; its canonical identity for the candidate becomes the well one.
    const candidates = await this.#candidates(ctx, triage, wellRows, () => undefined)
    const candidate = candidates.find((entry) => entry.providerId === providerId)
      ?? (parsed.kind === 'triage' ? candidates[0] : undefined)
    if (!candidate) return { ok: false, error: 'SlideWell no longer lists that picture (it may have been emptied or moved to the Bin).' }
    const scannedVault = this.#scannedVaultRoot(ctx)
    const wellRow = wellRows[0]
    const where = (wellRow ? this.#fileOf(ctx, wellRow, scannedVault) : null) ?? (triage[0] ? this.#fileOf(ctx, triage[0], scannedVault) : null)
    if (!where) return { ok: false, error: 'That picture’s file is not where SlideWell’s catalogue puts it.' }
    let realRoot: string
    try { realRoot = await realpath(where.root) } catch { return { ok: false, error: 'That picture’s file is not where SlideWell’s catalogue puts it.' } }
    const read = await readContainedFile(realRoot, where.rel, EXTERNAL_ASSET_MAX_BYTES)
    if (!read.ok) {
      return { ok: false, error: read.reason === 'missing' ? 'That picture’s file has gone since SlideWell indexed it.' : read.reason === 'too-large' ? 'That file is too large for the Scratchpad.' : 'That SlideWell file cannot be read safely (it may have been replaced by a link).' }
    }
    return { ok: true, bytes: read.bytes, candidate }
  }
}

export function parseSlideWellProviderId(providerId: string): { kind: 'well' | 'triage'; id: string } | null {
  const well = /^well:([0-9a-f]{7,64})$/i.exec(providerId)
  if (well) return { kind: 'well', id: well[1] }
  const triage = /^triage:([0-9a-f]{6,64})$/i.exec(providerId)
  if (triage) return { kind: 'triage', id: triage[1] }
  return null
}
