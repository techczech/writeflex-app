// One share: the `SharedPiece` Durable Object, one per share id (TalkWeaver's SharedTalk pattern:
// a SQLite-backed object per share, the published HTML kept in chunks).
//
// What it holds: whether the link is on, the revision last published, the rendered reader page
// (in chunks, as one row may hold at most 2 MB) and the share's images (in 1 MiB chunks).
// Turning the link off deletes the page and every image in one transaction and keeps the share
// row, so turning it on again brings back the same address.
//
// The object is reached only through the entry Worker (index.ts), which always builds a fresh
// request to one of the internal routes below; no reader's or author's request is ever forwarded
// to it as it came. Owner authority is checked in the entry Worker before anything reaches here.
//
// An object for an id that was never made has no tables, and reading it creates none: the reader
// routes catch the missing table and answer "not here", so probing random addresses writes nothing.
//
//   POST /init          {shareId, createdAt}          201, or 409 when the id is taken
//   GET  /page                                         200 the page's HTML, or 404
//   GET  /page/read                                    the same, counting one opening when it answers 200
//   GET  /image/<name>                                 200 the image's bytes, or 404
//   PUT  /image/<name>  raw bytes                      200 {stored}, 404, 409 share_off, 413, 400
//   PUT  /page          the publish JSON               200 {revision, publishedAt}, 400, 404, 409, 413
//   DELETE /images/staged                              200 {deleted}, 404
//   POST /off, POST /on                                200 {status}, 404
//   GET  /status                                       200 {shareId, status, revision, ..., opened}, 404
//
// Openings (how many times the page was opened): one whole number per share, raised by
// one each time a reader's GET of the page is answered with the page. Nothing about the reader is
// kept: no address, no time, no browser. A HEAD, an image, the link-off page and the author's own
// status reads count nothing. A reload counts again. Kept when the link is turned off and on.
//
// The image cap (SHARE_LIMITS.shareImages, shareImageBytes) is counted twice over, once for the
// published images and once for the staged ones (sent, not yet named by a publish), never the two
// together: so a publish can stage a whole new set of pictures beside the copy readers are reading,
// then replace that copy in one page PUT. A publish whose named images come to more than the cap is
// refused (413 share_images_full) and changes nothing. Storage reaches two caps only while a publish
// is on its way; the page PUT deletes every image it does not name, and DELETE /images/staged
// deletes the staged ones left by a publish that never finished.
// Readers' notes (reader-notes.ts). The entry Worker has already checked the body
// and turned the reader's secret into its digest (`readerKey`); the secret never reaches here.
// `network` is the reader's network (networkOf); it is kept only as an HMAC under an hourly key.
//   POST /notes            {readerKey, network, note}  201/200 {note, already}, 404, 403, 429, 503
//   POST /notes/mine       {readerKey}                 200 {notes}, 404
//   GET  /notes/waiting    (owner)                     200 {notes, more, refused, limits}, 404
//   POST /notes/collected  (owner) {keys}              200 {collected, already, unknown}, 404
//   POST /notes/clear      (owner) {keys}              200 {cleared, waiting, unknown}, 404 (collected notes only)
//   POST /notes/raise      (owner)                     200 {limits}, 409 limit_at_most, 404
//   POST /notes/outcomes   (owner) {outcomes}          200 {recorded, waiting, unknown, full}, 400, 404
//
// Hearing back (note-outcomes.ts): each note keeps the author's outcome (`outcome`,
// `outcome_at`; NULL while open) and the author's replies (`note_replies`, one row per reply id, so a
// reply sent twice is kept once). Only a collected note takes them: the app sends them only for notes
// its review list holds. They are returned only by `/notes/mine`, to the reader whose digest wrote
// the note; clearing a note deletes its replies with it.
//
// Notes stay when the link is turned off (notes are kept until collected) and when they are
// collected (the reader still sees them, with their outcome and replies). A reader route on a link that is
// off, never published or never made answers 404, and the entry Worker gives the "turned off" page.
//
// Taking a note, in order: wait for any copy of the same note still on its way; then, with nothing
// awaited in between, check for the note already kept, comments, and every limit of this share
// (counting notes on their way as if kept), and hold the note's place; then ask the service for
// its room (note-budget.ts); then keep the note, or give the room back when it is not kept. So a
// copy of a note, or a note this share would refuse, never spends the service's room.
//
// Refusals are written as they happen, so an object the runtime evicts loses none: one write per
// refusal up to REFUSALS_COUNTED_PER_MINUTE per reason in a minute; past that, one more write marks
// that minute as having refused more than was counted, and nothing more is written that minute. The
// owner sees an exact count, or the count with "more than".
//
// Networks (reader-notes.ts, "The reader's network"): `network_key` holds one random HMAC key per
// clock hour and `network_minute` the notes and new readers per network HMAC per minute. The limit
// counts a sliding hour: the last 60 minutes' counts under this hour's key and the last hour's. A
// key and its counts are deleted when the hour after theirs ends (by the next request or the alarm),
// so nothing about a network is kept for more than two hours.
import { sha256Hex } from './auth.ts'
import { errorResponse, jsonResponse, type Env } from './http.ts'
import { refundNoteBudget, takeNoteBudget, type NoteGrant } from './note-budget.ts'
import { renderReaderPage } from './reader-page.ts'
import { COMMENTS_OFF_MESSAGE, NOTE_LIMITS, NOTES_REFUSED_MESSAGE, NoteProtocolError, REFUSAL_REASONS, type NoteAnchor, type PostedNote, type ReaderNoteView, type RefusalReason } from './reader-notes.ts'
import { OUTCOME_LIMITS, OUTCOMES, parseOutcomes, type NoteOutcome, type ReplyView } from './note-outcomes.ts'
import { ShareProtocolError, SHARE_LIMITS, parseImageName, parsePublishBody } from './share-protocol.ts'

const PAGE_CHUNK_UNITS = 512 * 1024
const IMAGE_CHUNK_BYTES = 1024 * 1024

interface ShareRow {
  share_id: string
  created_at: number
  status: 'on' | 'off'
  revision: number
  published_at: number | null
  saved_at: number | null
  comments: number
  opened?: number
  note_factor?: number
}

interface NoteRow {
  reader_key: string
  id: string
  kind: 'note' | 'edit'
  name: string
  text: string
  quote: string
  before_text: string
  after_text: string
  block: string | null
  start_at: number | null
  end_at: number | null
  written_at: number | null
  revision: number | null
  received_at: number
  collected_at: number | null
  /** The author's outcome and when; NULL while the note is open. */
  outcome?: string | null
  outcome_at?: number | null
}

const NOTE_COLUMNS = 'reader_key, id, kind, name, text, quote, before_text, after_text, block, start_at, end_at, written_at, revision, received_at, collected_at'
/** What a read takes: the columns written when a note is kept, and the author's outcome. */
const NOTE_READ = `${NOTE_COLUMNS}, outcome, outcome_at`
const HOUR = 3_600_000
const MINUTE = 60_000
/**
 * Refusals of one reason counted one by one in a minute. 30 counts exactly a class of 30 each
 * refused once in the same minute, the largest ordinary burst; a flood past it costs one more
 * write that minute (the "more than" mark), so a share writes at most 31 rows a minute per reason.
 */
export const REFUSALS_COUNTED_PER_MINUTE = 30
/** After the service answers that it has no room, this share refuses without asking again for this long. */
const SERVICE_FULL_PAUSE = 60_000
const NETWORK = /^[0-9a-f.:/]{1,64}$|^unknown$/

/** A note on its way: counted against every limit until it is kept or not. */
interface Hold {
  readerKey: string
  /** The network's HMACs under the keys of its window (this hour's and, when there is one, the last hour's). */
  networks: string[]
  newReader: boolean
}

/** The sliding hour a network is counted in: its HMAC under this hour's key and the last hour's. */
interface NetworkWindow {
  hour: number
  /** The HMAC under this hour's key: what a kept note is counted under. */
  current: string
  /** The HMAC under the last hour's key, when that key is still held. */
  previous: string | null
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** How many characters of the reader's digest name the reader to the author. */
const READER_ID_CHARS = 24

function anchorOf(row: NoteRow): NoteAnchor {
  return { quote: row.quote, before: row.before_text, after: row.after_text, block: row.block, start: row.start_at, end: row.end_at }
}

const outcomeOf = (row: NoteRow): NoteOutcome | null => (typeof row.outcome === 'string' && (OUTCOMES as readonly string[]).includes(row.outcome) ? row.outcome as NoteOutcome : null)

/**
 * A note as its own reader sees it: nothing about the reader beyond the name they typed; the author's
 * outcome (open until there is one) and the author's replies, oldest first.
 */
function readerView(row: NoteRow, replies: readonly ReplyView[] = []): ReaderNoteView {
  const outcome = outcomeOf(row)
  return {
    id: row.id, kind: row.kind, name: row.name, text: row.text, anchor: anchorOf(row), writtenAt: row.written_at, receivedAt: row.received_at,
    status: outcome ?? 'open', outcomeAt: outcome ? row.outcome_at ?? null : null, replies: [...replies],
  }
}

/** The author's key for one note: the reader's id and the note's id. Unique in the share. */
function noteKey(row: Pick<NoteRow, 'reader_key' | 'id'>): string {
  return `${row.reader_key.slice(0, READER_ID_CHARS)}.${row.id}`
}

function ownerView(row: NoteRow) {
  return { key: noteKey(row), readerId: row.reader_key.slice(0, READER_ID_CHARS), ...readerView(row), revision: row.revision, collectedAt: row.collected_at }
}

/**
 * Split text into chunks of at most `size` UTF-16 units without separating a surrogate pair, so
 * joining the chunks gives back the exact string. (TalkWeaver's splitOnCodePoints.)
 */
export function splitOnCodePoints(text: string, size: number): string[] {
  if (size < 2) throw new Error('Chunk size must be at least 2.')
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

/** A stored blob as bytes: the Workers runtime gives back an ArrayBuffer. */
function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new Error('A stored image chunk is not bytes.')
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const INTERNAL_ROUTE = /^\/(init|page|page\/read|off|on|status|notes|notes\/mine|notes\/waiting|notes\/collected|notes\/clear|notes\/raise|notes\/outcomes|images\/staged|image\/([^/]+))$/
const READER_KEY = /^[0-9a-f]{64}$/

export class SharedPiece {
  private readonly state: DurableObjectState
  private readonly sql: SqlStorage
  private readonly env: Env
  private notesReady = false
  /** Notes on their way (asked the service for room, not yet kept), and by `<readerKey>.<id>`. */
  private readonly holds = new Set<Hold>()
  private readonly sending = new Map<string, Promise<void>>()
  /** Until when the service is taken to be full (memory only): set by a "no room" answer, ended by a grant. */
  private serviceFullUntil = 0
  /** Network HMAC keys by hour, imported once each. */
  private readonly networkKeys = new Map<number, CryptoKey>()
  /** When the alarm is set for, as far as this object's memory knows. */
  private alarmAt: number | null = null

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state
    this.sql = state.storage.sql
    this.env = env as Env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = INTERNAL_ROUTE.exec(url.pathname)
    if (url.hostname !== 'internal' || !match) return errorResponse('not_found', 'Share route not found.', 404)
    const [, action, imageName] = match
    const method = request.method
    try {
      if (action === 'init' && method === 'POST') return this.init(await request.json().catch(() => null))
      if (action === 'page' && method === 'GET') return this.readPage()
      if (action === 'page/read' && method === 'GET') return this.readPage(true)
      if (action === 'page' && method === 'PUT') return this.publish(new Uint8Array(await request.arrayBuffer()))
      if (imageName !== undefined && method === 'GET') return this.readImage(imageName)
      if (imageName !== undefined && method === 'PUT') return await this.storeImage(imageName, new Uint8Array(await request.arrayBuffer()))
      if (action === 'images/staged' && method === 'DELETE') return this.deleteStaged()
      if ((action === 'off' || action === 'on') && method === 'POST') return this.setStatus(action)
      if (action === 'status' && method === 'GET') return this.status()
      if (action === 'notes' && method === 'POST') return await this.postNote(await request.json().catch(() => null))
      if (action === 'notes/mine' && method === 'POST') return this.readerNotes(await request.json().catch(() => null))
      if (action === 'notes/waiting' && method === 'GET') return this.waitingNotes()
      if (action === 'notes/collected' && method === 'POST') return this.markCollected(await request.json().catch(() => null))
      if (action === 'notes/clear' && method === 'POST') return this.clearNotes(await request.json().catch(() => null))
      if (action === 'notes/raise' && method === 'POST') return this.raiseLimit()
      if (action === 'notes/outcomes' && method === 'POST') return this.recordOutcomes(await request.json().catch(() => null))
    } catch (error) {
      if (error instanceof ShareProtocolError) return errorResponse(error.code, error.message, 400)
      if (error instanceof NoteProtocolError) return errorResponse(error.code, error.message, 400)
      throw error
    }
    return errorResponse('not_found', 'Share route not found.', 404)
  }

  /** The share row, or null when this object was never made a share (no table, no row). */
  private row(): ShareRow | null {
    try {
      const rows = [...this.sql.exec<ShareRow>('SELECT * FROM share WHERE id = 1')]
      const row = rows[0]
      return row ? { ...row, comments: row.comments ?? 0 } : null
    } catch {
      return null
    }
  }

  private init(value: unknown): Response {
    const body = value as { shareId?: unknown; createdAt?: unknown } | null
    if (typeof body?.shareId !== 'string' || !Number.isSafeInteger(body.createdAt)) return errorResponse('invalid_init', 'Init needs a share id and a time.', 400)
    if (this.row()) return errorResponse('already_exists', 'This share id is taken.', 409)
    this.state.storage.transactionSync(() => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS share (id INTEGER PRIMARY KEY CHECK (id = 1), share_id TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, published_at INTEGER, saved_at INTEGER, comments INTEGER NOT NULL DEFAULT 0, opened INTEGER NOT NULL DEFAULT 0)')
      this.sql.exec('CREATE TABLE IF NOT EXISTS page_chunks (idx INTEGER PRIMARY KEY, text TEXT NOT NULL)')
      this.sql.exec('CREATE TABLE IF NOT EXISTS images (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, chunks INTEGER NOT NULL, published INTEGER NOT NULL)')
      this.sql.exec('CREATE TABLE IF NOT EXISTS image_chunks (name TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (name, idx))')
      this.sql.exec("INSERT INTO share (id, share_id, created_at, status, revision, published_at, saved_at) VALUES (1, ?, ?, 'on', 0, NULL, NULL)", body.shareId, body.createdAt)
      this.ensureNotesSchema()
    })
    return jsonResponse({ shareId: body.shareId }, 201)
  }

  /** The page's HTML. `opening`: a reader's GET (index.ts readerRoute): counted once when it answers 200. */
  private readPage(opening = false): Response {
    const row = this.row()
    if (!row || row.status !== 'on' || row.published_at === null) return new Response(null, { status: 404 })
    const chunks = [...this.sql.exec<{ text: string }>('SELECT text FROM page_chunks ORDER BY idx')]
    if (chunks.length === 0) return new Response(null, { status: 404 })
    if (opening) {
      // Not wrapped in transactionSync: from the read above to this update
      // nothing awaits, and a Durable Object runs one request's synchronous code to the end before the
      // next and commits its writes together, so no other request reads or writes between them. The
      // count is atomic as it stands; a transaction would add nothing.
      this.ensureNotesSchema()
      this.sql.exec('UPDATE share SET opened = opened + 1 WHERE id = 1')
    }
    return new Response(chunks.map((chunk) => chunk.text).join(''), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }

  private readImage(name: string): Response {
    const row = this.row()
    if (!row || row.status !== 'on' || !parseImageName(name)) return new Response(null, { status: 404 })
    const image = [...this.sql.exec<{ bytes: number; chunks: number }>('SELECT bytes, chunks FROM images WHERE name = ? AND published = 1', name)][0]
    if (!image) return new Response(null, { status: 404 })
    const bytes = new Uint8Array(image.bytes)
    let offset = 0
    for (const chunk of this.sql.exec<{ data: unknown }>('SELECT data FROM image_chunks WHERE name = ? ORDER BY idx', name)) {
      const part = asBytes(chunk.data)
      bytes.set(part, offset)
      offset += part.byteLength
    }
    if (offset !== image.bytes) throw new Error('A stored image is incomplete.')
    return new Response(bytes, { status: 200 })
  }

  private async storeImage(name: string, bytes: Uint8Array): Promise<Response> {
    const parsed = parseImageName(name)
    if (!parsed) return errorResponse('invalid_image_name', 'An image name is <sha256 of its bytes>.<png|jpg|jpeg|gif|webp|avif|svg>.', 400)
    if (bytes.byteLength === 0) return errorResponse('empty_image', 'The image has no bytes.', 400)
    if (await sha256Hex(bytes) !== parsed.sha256) return errorResponse('image_digest_mismatch', 'The image\'s bytes do not match the SHA-256 in its name.', 400)
    // From here on nothing awaits: the checks and the writes are one stretch no other request enters.
    const row = this.row()
    if (!row) return errorResponse('unknown_share', 'This share does not exist.', 404)
    if (row.status !== 'on') return errorResponse('share_off', 'This link is turned off. Turn it on before publishing.', 409)
    const existing = [...this.sql.exec('SELECT name FROM images WHERE name = ?', name)]
    if (existing.length > 0) return jsonResponse({ stored: name, already: true })
    // Only the staged images count: the published ones are the copy readers have, which the next
    // page PUT replaces (see the header, "The image cap").
    const staged = [...this.sql.exec<{ count: number; total: number | null }>('SELECT COUNT(*) AS count, SUM(bytes) AS total FROM images WHERE published = 0')][0]
    const count = staged?.count ?? 0
    const total = staged?.total ?? 0
    if (count + 1 > SHARE_LIMITS.shareImages) {
      return errorResponse('share_images_full', `A share holds at most ${SHARE_LIMITS.shareImages} images waiting to be published.`, 413, { limit: SHARE_LIMITS.shareImages, count })
    }
    if (total + bytes.byteLength > SHARE_LIMITS.shareImageBytes) {
      return errorResponse('share_images_full', `A share's images waiting to be published may come to at most ${SHARE_LIMITS.shareImageBytes} bytes; with this one they would come to ${total + bytes.byteLength}.`, 413,
        { limit: SHARE_LIMITS.shareImageBytes, size: total + bytes.byteLength })
    }
    const chunkCount = Math.ceil(bytes.byteLength / IMAGE_CHUNK_BYTES)
    this.state.storage.transactionSync(() => {
      for (let index = 0; index < chunkCount; index += 1) {
        const part = bytes.subarray(index * IMAGE_CHUNK_BYTES, Math.min((index + 1) * IMAGE_CHUNK_BYTES, bytes.byteLength))
        this.sql.exec('INSERT INTO image_chunks (name, idx, data) VALUES (?, ?, ?)', name, index, asArrayBuffer(part))
      }
      this.sql.exec('INSERT INTO images (name, bytes, chunks, published) VALUES (?, ?, ?, 0)', name, bytes.byteLength, chunkCount)
    })
    return jsonResponse({ stored: name, already: false })
  }

  private publish(bytes: Uint8Array): Response {
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return errorResponse('invalid_publish', 'The publish body is not JSON.', 400)
    }
    const body = parsePublishBody(value)
    const row = this.row()
    if (!row) return errorResponse('unknown_share', 'This share does not exist.', 404)
    if (row.status !== 'on') return errorResponse('share_off', 'This link is turned off. Turn it on before publishing.', 409)
    if (body.revision !== row.revision + 1) {
      return errorResponse('revision_conflict', `The next revision is ${row.revision + 1}.`, 409, { revision: row.revision })
    }
    const sizes = new Map([...this.sql.exec<{ name: string; bytes: number }>('SELECT name, bytes FROM images')].map((image) => [image.name, image.bytes]))
    const held = new Set(sizes.keys())
    const missing = body.images.filter((name) => !held.has(name))
    if (missing.length > 0) {
      return errorResponse('missing_images', 'Send these images first; nothing was published.', 409, { missing })
    }
    // The count of named images is checked by parsePublishBody; their bytes only here.
    const namedBytes = body.images.reduce((sum, name) => sum + (sizes.get(name) ?? 0), 0)
    if (namedBytes > SHARE_LIMITS.shareImageBytes) {
      return errorResponse('share_images_full', `A published copy's images may come to at most ${SHARE_LIMITS.shareImageBytes} bytes; these come to ${namedBytes}. Nothing was published.`, 413,
        { limit: SHARE_LIMITS.shareImageBytes, size: namedBytes })
    }
    const html = renderReaderPage(body)
    const publishedAt = Date.now()
    const keep = new Set(body.images)
    this.state.storage.transactionSync(() => {
      this.ensureNotesSchema()
      this.sql.exec('UPDATE share SET comments = ? WHERE id = 1', body.comments ? 1 : 0)
      this.sql.exec('DELETE FROM page_chunks')
      splitOnCodePoints(html, PAGE_CHUNK_UNITS).forEach((chunk, index) => {
        this.sql.exec('INSERT INTO page_chunks (idx, text) VALUES (?, ?)', index, chunk)
      })
      for (const name of held) {
        if (keep.has(name)) {
          this.sql.exec('UPDATE images SET published = 1 WHERE name = ?', name)
        } else {
          this.sql.exec('DELETE FROM image_chunks WHERE name = ?', name)
          this.sql.exec('DELETE FROM images WHERE name = ?', name)
        }
      }
      this.sql.exec('UPDATE share SET revision = ?, published_at = ?, saved_at = ? WHERE id = 1', body.revision, publishedAt, body.savedAt)
    })
    return jsonResponse({ revision: body.revision, publishedAt })
  }

  private setStatus(status: 'on' | 'off'): Response {
    const row = this.row()
    if (!row) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.state.storage.transactionSync(() => {
      if (status === 'off') {
        // Removal: the published copy and its images are deleted.
        this.sql.exec('DELETE FROM page_chunks')
        this.sql.exec('DELETE FROM image_chunks')
        this.sql.exec('DELETE FROM images')
        this.sql.exec("UPDATE share SET status = 'off', published_at = NULL WHERE id = 1")
      } else {
        this.sql.exec("UPDATE share SET status = 'on' WHERE id = 1")
      }
    })
    return jsonResponse({ status, revision: row.revision })
  }

  /** Delete the staged images (sent, named by no publish): what a publish that never finished left. */
  private deleteStaged(): Response {
    const row = this.row()
    if (!row) return errorResponse('unknown_share', 'This share does not exist.', 404)
    const names = [...this.sql.exec<{ name: string }>('SELECT name FROM images WHERE published = 0')].map((image) => image.name)
    this.state.storage.transactionSync(() => {
      for (const name of names) {
        this.sql.exec('DELETE FROM image_chunks WHERE name = ?', name)
        this.sql.exec('DELETE FROM images WHERE name = ?', name)
      }
    })
    return jsonResponse({ deleted: names.length })
  }

  private status(): Response {
    const row = this.row()
    if (!row) return errorResponse('unknown_share', 'This share does not exist.', 404)
    const held = [...this.sql.exec<{ count: number; total: number | null }>('SELECT COUNT(*) AS count, SUM(bytes) AS total FROM images')][0]
    const staged = [...this.sql.exec<{ count: number; total: number | null }>('SELECT COUNT(*) AS count, SUM(bytes) AS total FROM images WHERE published = 0')][0]
    this.ensureNotesSchema()
    const notes = [...this.sql.exec<{ waiting: number | null; total: number }>('SELECT SUM(collected_at IS NULL) AS waiting, COUNT(*) AS total FROM notes')][0]
    return jsonResponse({
      shareId: row.share_id,
      status: row.status,
      revision: row.revision,
      publishedAt: row.published_at,
      savedAt: row.saved_at,
      images: held?.count ?? 0,
      imageBytes: held?.total ?? 0,
      staged: staged?.count ?? 0,
      stagedBytes: staged?.total ?? 0,
      comments: row.comments === 1,
      notes: { waiting: notes?.waiting ?? 0, total: notes?.total ?? 0 },
      refused: this.refusals(),
      opened: this.row()?.opened ?? 0,
      limits: this.shareLimits(),
    })
  }

  // ---------------------------------------------------------------- readers' notes

  /**
   * The notes tables, and the `comments` column on a share made by an earlier build. Run inside a
   * transaction or a synchronous stretch; cheap after the first time in an object's life.
   */
  private ensureNotesSchema(): void {
    if (this.notesReady) return
    const columns = [...this.sql.exec<{ name: string }>('PRAGMA table_info(share)')].map((column) => column.name)
    if (columns.length > 0 && !columns.includes('comments')) this.sql.exec('ALTER TABLE share ADD COLUMN comments INTEGER NOT NULL DEFAULT 0')
    // How many times readers opened the page (readPage). A share made by an earlier build starts at 0.
    if (columns.length > 0 && !columns.includes('opened')) this.sql.exec('ALTER TABLE share ADD COLUMN opened INTEGER NOT NULL DEFAULT 0')
    // Build 5: Raise the limit for this link. A share made by an earlier build starts at 1.
    if (columns.length > 0 && !columns.includes('note_factor')) this.sql.exec('ALTER TABLE share ADD COLUMN note_factor INTEGER NOT NULL DEFAULT 1')
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (seq INTEGER PRIMARY KEY AUTOINCREMENT, reader_key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL,
      quote TEXT NOT NULL, before_text TEXT NOT NULL, after_text TEXT NOT NULL, block TEXT, start_at INTEGER, end_at INTEGER, written_at INTEGER, revision INTEGER,
      received_at INTEGER NOT NULL, collected_at INTEGER, UNIQUE (reader_key, id))`)
    // Build 6: the author's outcome on each note. Notes kept by an earlier build start open.
    const noteColumns = [...this.sql.exec<{ name: string }>('PRAGMA table_info(notes)')].map((column) => column.name)
    if (!noteColumns.includes('outcome')) this.sql.exec('ALTER TABLE notes ADD COLUMN outcome TEXT')
    if (!noteColumns.includes('outcome_at')) this.sql.exec('ALTER TABLE notes ADD COLUMN outcome_at INTEGER')
    this.sql.exec(`CREATE TABLE IF NOT EXISTS note_replies (note_seq INTEGER NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY (note_seq, id))`)
    this.sql.exec('CREATE INDEX IF NOT EXISTS notes_by_reader ON notes (reader_key, received_at)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS notes_by_time ON notes (received_at)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS notes_waiting ON notes (collected_at, seq)')
    // note_refusals: per reason, the count; the minute last counted in and how many were counted
    // in it (one past the ceiling once that minute is marked); how many minutes refused more than
    // they counted.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS note_refusals (reason TEXT PRIMARY KEY, count INTEGER NOT NULL, last_at INTEGER NOT NULL,
      minute INTEGER NOT NULL DEFAULT 0, minute_count INTEGER NOT NULL DEFAULT 0, over_minutes INTEGER NOT NULL DEFAULT 0)`)
    const refusalColumns = [...this.sql.exec<{ name: string }>('PRAGMA table_info(note_refusals)')].map((column) => column.name)
    for (const column of ['minute', 'minute_count', 'over_minutes']) {
      if (!refusalColumns.includes(column)) this.sql.exec(`ALTER TABLE note_refusals ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
    }
    this.sql.exec('CREATE TABLE IF NOT EXISTS network_key (hour INTEGER PRIMARY KEY, key TEXT NOT NULL)')
    // An earlier build counted per clock hour; those counts last at most an hour and are not carried over.
    this.sql.exec('DROP TABLE IF EXISTS network_use')
    this.sql.exec(`CREATE TABLE IF NOT EXISTS network_minute (hour INTEGER NOT NULL, network TEXT NOT NULL, minute INTEGER NOT NULL, notes INTEGER NOT NULL, readers INTEGER NOT NULL,
      PRIMARY KEY (hour, network, minute))`)
    this.notesReady = true
  }

  /** The share as a reader may use it: on, published, and taking notes or not; null otherwise. */
  private readable(): ShareRow | null {
    const row = this.row()
    if (!row || row.status !== 'on' || row.published_at === null) return null
    this.ensureNotesSchema()
    return row
  }

  private count(query: string, ...bindings: unknown[]): number {
    return [...this.sql.exec<{ n: number }>(query, ...bindings)][0]?.n ?? 0
  }

  /** Whether this reader has no note in this share yet, kept or on its way. */
  private isNewReader(readerKey: string): boolean {
    if ([...this.holds].some((hold) => hold.readerKey === readerKey)) return false
    return this.count('SELECT COUNT(*) AS n FROM notes WHERE reader_key = ? LIMIT 1', readerKey) === 0
  }

  /** The first limit this note would pass, counting notes on their way as kept, or null. Synchronous. */
  private overLimit(readerKey: string, win: NetworkWindow, newReader: boolean, now: number): RefusalReason | null {
    const hourAgo = now - HOUR
    const L = NOTE_LIMITS
    const holds = [...this.holds]
    const mine = holds.filter((hold) => hold.readerKey === readerKey).length
    if (this.count('SELECT COUNT(*) AS n FROM notes WHERE reader_key = ? AND received_at > ?', readerKey, hourAgo) + mine >= L.readerPerHour) return 'reader_rate'
    if (this.count('SELECT COUNT(*) AS n FROM notes WHERE reader_key = ? AND collected_at IS NULL', readerKey) + mine >= L.readerWaiting) return 'reader_waiting'
    if (this.count('SELECT COUNT(*) AS n FROM notes WHERE reader_key = ?', readerKey) + mine >= L.readerTotal) return 'reader_total'
    // The network's sliding hour, counted by the minute: every minute that began at most 60 minutes
    // before this one (up to 61 minutes, never fewer than 60), under this hour's key and the last's.
    const since = Math.floor(now / MINUTE) - 60
    const use = [...this.sql.exec<{ notes: number | null; readers: number | null }>(
      'SELECT SUM(notes) AS notes, SUM(readers) AS readers FROM network_minute WHERE minute >= ? AND ((hour = ? AND network = ?) OR (hour = ? AND network = ?))',
      since, win.hour, win.current, win.hour - 1, win.previous ?? '',
    )][0]
    const names = [win.current, win.previous].filter((name): name is string => name !== null)
    const ours = holds.filter((hold) => hold.networks.some((name) => names.includes(name)))
    if ((use?.notes ?? 0) + ours.length >= L.networkPerHour) return 'network_rate'
    if (newReader && (use?.readers ?? 0) + ours.filter((hold) => hold.newReader).length >= L.networkNewReadersPerHour) return 'network_readers'
    const all = holds.length
    const share = this.shareLimits()
    if (this.count('SELECT COUNT(*) AS n FROM notes WHERE received_at > ?', hourAgo) + all >= share.perHour) return 'share_rate'
    if (this.count('SELECT COUNT(*) AS n FROM notes WHERE collected_at IS NULL') + all >= share.waiting) return 'share_waiting'
    if (this.count('SELECT COUNT(*) AS n FROM notes') + all >= share.total) return 'share_total'
    return null
  }

  /**
   * Count a refusal, in storage at once. Up to REFUSALS_COUNTED_PER_MINUTE of one reason in a
   * minute are each written; the next marks the minute as having refused more than it counted; the
   * rest of that minute writes nothing. Synchronous.
   */
  private refuse(reason: RefusalReason, now: number): void {
    const minute = Math.floor(now / MINUTE)
    const row = [...this.sql.exec<{ minute: number; minute_count: number }>('SELECT minute, minute_count FROM note_refusals WHERE reason = ?', reason)][0]
    if (!row) {
      this.sql.exec('INSERT INTO note_refusals (reason, count, last_at, minute, minute_count, over_minutes) VALUES (?, 1, ?, ?, 1, 0)', reason, now, minute)
    } else if (row.minute !== minute) {
      this.sql.exec('UPDATE note_refusals SET count = count + 1, last_at = MAX(last_at, ?), minute = ?, minute_count = 1 WHERE reason = ?', now, minute, reason)
    } else if (row.minute_count < REFUSALS_COUNTED_PER_MINUTE) {
      this.sql.exec('UPDATE note_refusals SET count = count + 1, last_at = MAX(last_at, ?), minute_count = minute_count + 1 WHERE reason = ?', now, reason)
    } else if (row.minute_count === REFUSALS_COUNTED_PER_MINUTE) {
      this.sql.exec('UPDATE note_refusals SET last_at = MAX(last_at, ?), minute_count = minute_count + 1, over_minutes = over_minutes + 1 WHERE reason = ?', now, reason)
    }
  }

  /**
   * What was refused, for the owner. `byReason` counts are exact unless the reason is in `more`:
   * then more were refused than counted (a flood past the per-minute ceiling), and the owner is
   * told "more than" the count. Reading writes nothing.
   */
  private refusals(): { total: number; byReason: Record<string, number>; more: string[]; lastAt: number | null } {
    const byReason: Record<string, number> = {}
    const more: string[] = []
    let total = 0
    let lastAt: number | null = null
    for (const row of this.sql.exec<{ reason: string; count: number; last_at: number; over_minutes: number }>('SELECT reason, count, last_at, over_minutes FROM note_refusals ORDER BY reason')) {
      if (!REFUSAL_REASONS.includes(row.reason as RefusalReason)) continue
      byReason[row.reason] = row.count
      if (row.over_minutes > 0) more.push(row.reason)
      total += row.count
      lastAt = Math.max(lastAt ?? 0, row.last_at)
    }
    return { total, byReason, more, lastAt }
  }

  /**
   * This share's own limits now: NOTE_LIMITS' per hour, waiting and kept, times the factor the author
   * raised them by (1, 2 or 4). `most`: the factor cannot go past this.
   */
  private shareLimits(): { factor: number; most: number; perHour: number; waiting: number; total: number } {
    const most = NOTE_LIMITS.shareRaiseMost
    const raw = this.row()?.note_factor
    const factor = Number.isSafeInteger(raw) && (raw as number) >= 1 ? Math.min(raw as number, most) : 1
    return { factor, most, perHour: NOTE_LIMITS.sharePerHour * factor, waiting: NOTE_LIMITS.shareWaiting * factor, total: NOTE_LIMITS.shareTotal * factor }
  }

  /** Make sure the alarm runs by `at`. */
  private alarmBy(at: number): void {
    if (this.alarmAt !== null && this.alarmAt <= at) return
    this.alarmAt = at
    this.state.storage.setAlarm(at).catch(() => { this.alarmAt = null })
  }

  /** The alarm: delete network keys and counts whose following hour has ended. */
  async alarm(): Promise<void> {
    this.alarmAt = null
    if (!this.row()) return
    this.ensureNotesSchema()
    this.dropOldNetworks(Math.floor(Date.now() / HOUR))
  }

  /**
   * Delete network keys and counts of hours before the last one (a key serves its own hour and the
   * next); set the alarm for when the oldest left is due to go.
   */
  private dropOldNetworks(hour: number): void {
    this.sql.exec('DELETE FROM network_minute WHERE hour < ?', hour - 1)
    this.sql.exec('DELETE FROM network_key WHERE hour < ?', hour - 1)
    for (const held of [...this.networkKeys.keys()]) if (held < hour - 1) this.networkKeys.delete(held)
    const oldest = [...this.sql.exec<{ hour: number | null }>('SELECT MIN(hour) AS hour FROM network_key')][0]?.hour ?? null
    if (oldest !== null) this.alarmBy((oldest + 2) * HOUR)
  }

  /**
   * The window a network is counted in at `now`: its HMAC under this hour's key, made at random the
   * first time it is needed in the hour, and under the last hour's key if that is still held. The
   * network itself is not kept anywhere.
   */
  private async networkWindow(network: string, now: number): Promise<NetworkWindow> {
    const hour = Math.floor(now / HOUR)
    const keys = this.state.storage.transactionSync(() => {
      this.dropOldNetworks(hour)
      if ([...this.sql.exec('SELECT hour FROM network_key WHERE hour = ?', hour)].length === 0) {
        this.sql.exec('INSERT INTO network_key (hour, key) VALUES (?, ?)', hour, hex(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer))
        this.alarmBy((hour + 2) * HOUR)
      }
      return [...this.sql.exec<{ hour: number; key: string }>('SELECT hour, key FROM network_key WHERE hour >= ?', hour - 1)]
    })
    const sign = async (held: { hour: number; key: string }) => {
      let key = this.networkKeys.get(held.hour)
      if (!key) {
        const raw = new Uint8Array(held.key.match(/../g)!.map((pair) => parseInt(pair, 16)))
        key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
        this.networkKeys.set(held.hour, key)
      }
      return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(network)))
    }
    const current = keys.find((held) => held.hour === hour)!
    const previous = keys.find((held) => held.hour === hour - 1)
    return { hour, current: await sign(current), previous: previous ? await sign(previous) : null }
  }

  private existing(readerKey: string, id: string): NoteRow | null {
    return [...this.sql.exec<NoteRow>(`SELECT ${NOTE_READ} FROM notes WHERE reader_key = ? AND id = ?`, readerKey, id)][0] ?? null
  }

  private async postNote(value: unknown): Promise<Response> {
    const body = value as { readerKey?: unknown; network?: unknown; note?: PostedNote } | null
    if (typeof body?.readerKey !== 'string' || !READER_KEY.test(body.readerKey) || typeof body.network !== 'string' || !NETWORK.test(body.network) || !body.note) {
      return errorResponse('invalid_note', 'A comment needs a reader, a network and a comment.', 400)
    }
    const readerKey = body.readerKey
    const network = body.network
    const note = body.note
    if (!this.readable()) return new Response(null, { status: 404 })
    // A copy of a note that is still on its way waits for it, then is answered as a resend is.
    const sendingKey = `${readerKey}.${note.id}`
    // The network's window is worked out (an await) before the stretch below, and again if a copy
    // started on its way or the hour turned meanwhile.
    let win!: NetworkWindow
    for (;;) {
      for (let earlier = this.sending.get(sendingKey); earlier; earlier = this.sending.get(sendingKey)) await earlier
      win = await this.networkWindow(network, Date.now())
      if (!this.sending.has(sendingKey) && win.hour === Math.floor(Date.now() / HOUR)) break
    }

    // From here until the note's place is held, nothing is awaited.
    let now = Date.now()
    const row = this.readable()
    if (!row) return new Response(null, { status: 404 })
    const already = this.existing(readerKey, note.id)
    // The same note sent again (a retry after a lost answer) arrives once.
    if (already) return jsonResponse({ note: readerView(already), already: true })
    if (row.comments !== 1) {
      this.refuse('comments_off', now)
      return errorResponse('comments_off', COMMENTS_OFF_MESSAGE, 403)
    }
    const newReader = this.isNewReader(readerKey)
    const over = this.overLimit(readerKey, win, newReader, now) ?? (this.serviceFullUntil > now ? 'service_rate' : null)
    if (over) {
      this.refuse(over, now)
      return errorResponse('notes_refused', NOTES_REFUSED_MESSAGE, 429)
    }
    const hold: Hold = { readerKey, networks: [win.current, win.previous].filter((name): name is string => name !== null), newReader }
    this.holds.add(hold)
    let finished!: () => void
    this.sending.set(sendingKey, new Promise<void>((resolve) => { finished = resolve }))
    let grant: NoteGrant | null = null
    let kept = false
    try {
      // The service-wide room, asked for only once this share's own limits have passed and the
      // note's place is held. While it is asked the link or comments may be turned off.
      const answer = await takeNoteBudget(this.env)
      if (answer === 'unavailable') {
        // No answer is not a "no": no pause, no refusal counted; the page keeps the note and sends it again.
        return errorResponse('notes_unavailable', 'Comments cannot be taken just now. Your comment is kept and sent again.', 503)
      }
      if (answer === 'full') {
        now = Date.now()
        this.serviceFullUntil = now + SERVICE_FULL_PAUSE
        this.refuse('service_rate', now)
        return errorResponse('notes_refused', NOTES_REFUSED_MESSAGE, 429)
      }
      grant = answer
      // The service has room again: whatever pause an earlier "no room" started ends here.
      this.serviceFullUntil = 0
      // The window may have moved on while the service was asked: the note is counted in the window
      // of the moment it is kept, under a key that is live now, never under one already deleted.
      for (let tries = 0; win.hour !== Math.floor(Date.now() / HOUR) && tries < 3; tries += 1) win = await this.networkWindow(network, Date.now())
      now = Date.now()
      const again = this.readable()
      if (!again) return new Response(null, { status: 404 })
      if (again.comments !== 1) {
        this.refuse('comments_off', now)
        return errorResponse('comments_off', COMMENTS_OFF_MESSAGE, 403)
      }
      const live = [...this.sql.exec('SELECT hour FROM network_key WHERE hour = ? AND hour >= ?', win.hour, Math.floor(now / HOUR) - 1)].length > 0
      const a = note.anchor
      this.state.storage.transactionSync(() => {
        this.sql.exec(`INSERT INTO notes (${NOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          readerKey, note.id, note.kind, note.name, note.text, a.quote, a.before, a.after, a.block, a.start, a.end, note.writtenAt, note.revision, now)
        if (live) {
          this.sql.exec('INSERT INTO network_minute (hour, network, minute, notes, readers) VALUES (?, ?, ?, 1, ?) ON CONFLICT(hour, network, minute) DO UPDATE SET notes = notes + 1, readers = readers + excluded.readers',
            win.hour, win.current, Math.floor(now / MINUTE), newReader ? 1 : 0)
        }
      })
      kept = true
      return jsonResponse({ note: readerView(this.existing(readerKey, note.id) as NoteRow), already: false }, 201)
    } finally {
      this.holds.delete(hold)
      this.sending.delete(sendingKey)
      finished()
      // A grant is spent only on a note that is kept.
      if (grant && !kept) await refundNoteBudget(this.env, grant)
    }
  }

  /** One reader's own notes, found by the digest of their secret. Never anyone else's. */
  private readerNotes(value: unknown): Response {
    const body = value as { readerKey?: unknown } | null
    if (typeof body?.readerKey !== 'string' || !READER_KEY.test(body.readerKey)) return errorResponse('invalid_note', 'A reader is needed.', 400)
    if (!this.readable()) return new Response(null, { status: 404 })
    const rows = [...this.sql.exec<NoteRow & { seq: number }>(`SELECT ${NOTE_READ}, seq FROM notes WHERE reader_key = ? ORDER BY seq LIMIT ?`, body.readerKey, NOTE_LIMITS.readerTotal)]
    // The author's replies on these notes only: joined on this reader's digest, never another's.
    const replies = new Map<number, ReplyView[]>()
    for (const reply of this.sql.exec<{ note_seq: number; id: string; text: string; at: number }>(
      'SELECT r.note_seq, r.id, r.text, r.at FROM note_replies r JOIN notes n ON n.seq = r.note_seq WHERE n.reader_key = ? ORDER BY r.at, r.received_at, r.id', body.readerKey,
    )) replies.set(reply.note_seq, [...(replies.get(reply.note_seq) ?? []), { id: reply.id, text: reply.text, at: reply.at }])
    return jsonResponse({ notes: rows.map((row) => readerView(row, replies.get(row.seq) ?? [])) })
  }

  /** For the author's app: notes not collected yet, oldest first, and what was refused. */
  private waitingNotes(): Response {
    if (!this.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.ensureNotesSchema()
    const rows = [...this.sql.exec<NoteRow>(`SELECT ${NOTE_READ} FROM notes WHERE collected_at IS NULL ORDER BY seq LIMIT ?`, NOTE_LIMITS.collectBatch + 1)]
    return jsonResponse({ notes: rows.slice(0, NOTE_LIMITS.collectBatch).map(ownerView), more: rows.length > NOTE_LIMITS.collectBatch, refused: this.refusals(), limits: this.shareLimits() })
  }

  /** For the author's app: mark notes collected. Saying so twice changes nothing. */
  private markCollected(value: unknown): Response {
    if (!this.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.ensureNotesSchema()
    const keys = (value as { keys?: unknown } | null)?.keys
    if (!Array.isArray(keys) || keys.length > NOTE_LIMITS.collectBatch || keys.some((key) => typeof key !== 'string' || key.length > 100)) {
      return errorResponse('invalid_collect', `keys must be a list of at most ${NOTE_LIMITS.collectBatch} note keys.`, 400)
    }
    const now = Date.now()
    const collected: string[] = []
    const already: string[] = []
    const unknown: string[] = []
    this.state.storage.transactionSync(() => {
      for (const key of new Set(keys as string[])) {
        const [readerId, id, extra] = key.split('.')
        const row = readerId && id && extra === undefined && readerId.length === READER_ID_CHARS
          ? [...this.sql.exec<{ seq: number; collected_at: number | null }>('SELECT seq, collected_at FROM notes WHERE substr(reader_key, 1, ?) = ? AND id = ?', READER_ID_CHARS, readerId, id)][0]
          : undefined
        if (!row) { unknown.push(key); continue }
        if (row.collected_at !== null) { already.push(key); continue }
        this.sql.exec('UPDATE notes SET collected_at = ? WHERE seq = ?', now, row.seq)
        collected.push(key)
      }
    })
    return jsonResponse({ collected, already, unknown })
  }
  /**
   * For the author's app, Clear handled notes (the Limits panel): delete the notes named
   * that the app has collected. A note not collected yet is never deleted (it is not in the app yet);
   * it is listed as `waiting`. Deleting makes room under the share's and the readers' limits; the
   * reader no longer sees a deleted note on the page. Saying so twice changes nothing.
   */
  private clearNotes(value: unknown): Response {
    if (!this.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.ensureNotesSchema()
    const keys = (value as { keys?: unknown } | null)?.keys
    if (!Array.isArray(keys) || keys.length > NOTE_LIMITS.collectBatch || keys.some((key) => typeof key !== 'string' || key.length > 100)) {
      return errorResponse('invalid_clear', `keys must be a list of at most ${NOTE_LIMITS.collectBatch} note keys.`, 400)
    }
    const cleared: string[] = []
    const waiting: string[] = []
    const unknown: string[] = []
    this.state.storage.transactionSync(() => {
      for (const key of new Set(keys as string[])) {
        const [readerId, id, extra] = key.split('.')
        const row = readerId && id && extra === undefined && readerId.length === READER_ID_CHARS
          ? [...this.sql.exec<{ seq: number; collected_at: number | null }>('SELECT seq, collected_at FROM notes WHERE substr(reader_key, 1, ?) = ? AND id = ?', READER_ID_CHARS, readerId, id)][0]
          : undefined
        if (!row) { unknown.push(key); continue }
        if (row.collected_at === null) { waiting.push(key); continue }
        this.sql.exec('DELETE FROM note_replies WHERE note_seq = ?', row.seq)
        this.sql.exec('DELETE FROM notes WHERE seq = ?', row.seq)
        cleared.push(key)
      }
    })
    return jsonResponse({ cleared, waiting, unknown })
  }

  /**
   * For the author's app (hearing back): the outcome of each note named, and the author's
   * replies on it. Only a collected note takes them (`waiting` otherwise: the app has not got it yet);
   * a note not here (cleared, or never) is `unknown`. The outcome is set as sent, so a decision taken
   * back (null) makes the note open again. A reply id already kept is kept once; a note with
   * OUTCOME_LIMITS.repliesPerNote replies takes no new one and is listed in `full` (its outcome is still
   * recorded). `replies` answers for each reply sent on a recorded note: `kept` (stored now), `already`
   * (stored before) or `full` (refused for the limit, never stored), so the app marks sent only what
   * is held. Saying the same thing twice changes nothing.
   */
  private recordOutcomes(value: unknown): Response {
    if (!this.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.ensureNotesSchema()
    const outcomes = parseOutcomes(value)
    const recorded: string[] = []
    const waiting: string[] = []
    const unknown: string[] = []
    const full: string[] = []
    const replies: Array<{ key: string; kept: string[]; already: string[]; full: string[] }> = []
    const now = Date.now()
    this.state.storage.transactionSync(() => {
      for (const item of outcomes) {
        const [readerId, id] = item.key.split('.')
        const row = [...this.sql.exec<{ seq: number; collected_at: number | null; outcome: string | null; outcome_at: number | null }>(
          'SELECT seq, collected_at, outcome, outcome_at FROM notes WHERE substr(reader_key, 1, ?) = ? AND id = ?', READER_ID_CHARS, readerId, id,
        )][0]
        if (!row) { unknown.push(item.key); continue }
        if (row.collected_at === null) { waiting.push(item.key); continue }
        if (row.outcome !== item.outcome || (item.outcome !== null && row.outcome_at !== item.at)) {
          this.sql.exec('UPDATE notes SET outcome = ?, outcome_at = ? WHERE seq = ?', item.outcome, item.outcome === null ? null : item.at, row.seq)
        }
        let kept = this.count('SELECT COUNT(*) AS n FROM note_replies WHERE note_seq = ?', row.seq)
        const answer = { key: item.key, kept: [] as string[], already: [] as string[], full: [] as string[] }
        for (const reply of item.replies) {
          if (this.count('SELECT COUNT(*) AS n FROM note_replies WHERE note_seq = ? AND id = ?', row.seq, reply.id) > 0) { answer.already.push(reply.id); continue }
          if (kept >= OUTCOME_LIMITS.repliesPerNote) { answer.full.push(reply.id); continue }
          this.sql.exec('INSERT INTO note_replies (note_seq, id, text, at, received_at) VALUES (?, ?, ?, ?, ?)', row.seq, reply.id, reply.text, reply.at, now)
          answer.kept.push(reply.id)
          kept += 1
        }
        if (answer.full.length > 0) full.push(item.key)
        if (item.replies.length > 0) replies.push(answer)
        recorded.push(item.key)
      }
    })
    return jsonResponse({ recorded, waiting, unknown, full, replies })
  }

  /**
   * For the author's app, Raise the limit for this link: the share's own limits doubled,
   * up to NOTE_LIMITS.shareRaiseMost times the defaults. At the most already: 409 `limit_at_most`,
   * nothing changes. The limits per reader, per network and for the service stay.
   */
  private raiseLimit(): Response {
    if (!this.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.ensureNotesSchema()
    const now = this.shareLimits()
    if (now.factor >= now.most) return errorResponse('limit_at_most', 'The limit for this link is already as high as it goes.', 409, { limits: now })
    this.sql.exec('UPDATE share SET note_factor = ? WHERE id = 1', Math.min(now.factor * 2, now.most))
    return jsonResponse({ limits: this.shareLimits() })
  }
}
