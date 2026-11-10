import { READER_CLAIM_RELEASE_MS } from './share-protocol.ts'
// Per-item owner state: collection, outcomes, replies and exclusive edit claims. All operations
// are synchronous after the Worker has authenticated and bounded the request.
import { commentsMode, READER_ID_CHARS, type ThreadRow } from './open-comments.ts'
import { errorResponse, jsonResponse } from './http.ts'
import { NOTE_LIMITS, type NoteAnchor, type ReaderNoteView } from './reader-notes.ts'
import { OUTCOME_LIMITS, OUTCOMES, parseOutcomes, type NoteOutcome, type ReplyView } from './note-outcomes.ts'

export interface NoteRow extends ThreadRow {
  person_id?: string | null
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

export const NOTE_COLUMNS = 'reader_key, id, kind, name, text, quote, before_text, after_text, block, start_at, end_at, written_at, revision, received_at, collected_at, visibility, public_id, parent_id, parent_context, person_id'
/** What a read takes: the columns written when a note is kept, and the author's outcome. */
export const NOTE_READ = `${NOTE_COLUMNS}, outcome, outcome_at`
function anchorOf(row: NoteRow): NoteAnchor {
  return { quote: row.quote, before: row.before_text, after: row.after_text, block: row.block, start: row.start_at, end: row.end_at }
}

const outcomeOf = (row: NoteRow): NoteOutcome | null => (typeof row.outcome === 'string' && (OUTCOMES as readonly string[]).includes(row.outcome) ? row.outcome as NoteOutcome : null)

/**
 * A note as its own reader sees it: nothing about the reader beyond the name they typed; the author's
 * outcome (open until there is one) and the author's replies, oldest first.
 */
export function readerView(row: NoteRow, replies: readonly ReplyView[] = []): ReaderNoteView {
  const outcome = outcomeOf(row)
  return {
    id: row.id, kind: row.kind, name: row.name, text: row.text, anchor: anchorOf(row), writtenAt: row.written_at, receivedAt: row.received_at,
    threadId: row.public_id ?? null, replyTo: row.parent_id ?? null, visibility: commentsMode(row.visibility),
    status: outcome ?? 'open', outcomeAt: outcome ? row.outcome_at ?? null : null, replies: [...replies],
  }
}

/** The author's key for one note: the reader's id and the note's id. Unique in the share. */
function noteKey(row: Pick<NoteRow, 'reader_key' | 'id'>): string {
  return `${row.reader_key.slice(0, READER_ID_CHARS)}.${row.id}`
}

export function ownerView(row: NoteRow) {
  return { key: noteKey(row), readerId: row.reader_key.slice(0, READER_ID_CHARS), ...readerView(row), revision: row.revision, collectedAt: row.collected_at }
}

type NotesContext = {
  row(): { comments_mode?: 'private' | 'open' } | null
  ensure(): void
  limits(): unknown
  refusals(): unknown
}

export class ShareNoteState {
  private readonly sql: SqlStorage
  constructor(private readonly state: DurableObjectState, private readonly context: NotesContext) { this.sql = state.storage.sql }
  private ownerView(row: NoteRow) {
    const person = row.person_id ? [...this.sql.exec<{ id: string; name: string; email: string }>('SELECT id, name, email FROM people WHERE id = ?', row.person_id)][0] : null
    return { ...ownerView(row), ...(person ? { person } : {}) }
  }
  private count(query: string, ...bindings: unknown[]): number { return [...this.sql.exec<{ n: number }>(query, ...bindings)][0]?.n ?? 0 }
  private ensureClaims(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS note_apply_claims (key TEXT PRIMARY KEY, claim TEXT NOT NULL, at INTEGER NOT NULL, computer_id TEXT)')
    if (![...this.sql.exec<{ name: string }>('PRAGMA table_info(note_apply_claims)')].some((c) => c.name === 'computer_id')) this.sql.exec('ALTER TABLE note_apply_claims ADD COLUMN computer_id TEXT')
  }

  /** For the author's app: notes not collected yet, oldest first, and what was refused. */
  waitingNotes(): Response {
    if (!this.context.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.context.ensure()
    const rows = [...this.sql.exec<NoteRow>(`SELECT ${NOTE_READ} FROM notes WHERE collected_at IS NULL ORDER BY seq LIMIT ?`, NOTE_LIMITS.collectBatch + 1)]
    return jsonResponse({ notes: rows.slice(0, NOTE_LIMITS.collectBatch).map((row) => ({ ...this.ownerView(row), ...(row.parent_context ? { replyTo: JSON.parse(row.parent_context) } : {}) })), more: rows.length > NOTE_LIMITS.collectBatch, refused: this.context.refusals(), limits: this.context.limits() })
  }

  /** Build 15: a paged view of all retained items, including those collected by another Mac. */
  ownerNotesState(value: unknown, computer: string | null = null): Response {
    this.context.ensure()
    this.ensureClaims()
    const after = (value as { after?: unknown } | null)?.after
    if (!Number.isSafeInteger(after) || (after as number) < 0) return errorResponse('invalid_cursor', 'A non-negative cursor is required.', 400)
    const rows = [...this.sql.exec<NoteRow & { seq: number }>(`SELECT ${NOTE_READ}, seq FROM notes WHERE seq > ? ORDER BY seq LIMIT 201`, after as number)]
    const page = rows.slice(0, 200)
    const replies = new Map<number, Array<ReplyView & { visibility: 'private' | 'open' }>>()
    for (const reply of this.sql.exec<{ note_seq: number; id: string; text: string; at: number; visibility: string }>(
      'SELECT r.note_seq, r.id, r.text, r.at, r.visibility FROM note_replies r WHERE note_seq IN (SELECT seq FROM notes WHERE seq > ? ORDER BY seq LIMIT 200) ORDER BY at, received_at, id', after as number,
    )) replies.set(reply.note_seq, [...(replies.get(reply.note_seq) ?? []), { id: reply.id, text: reply.text, at: reply.at, visibility: commentsMode(reply.visibility) }])
    const claims = new Map([...this.sql.exec<{ key: string; at: number; computer_id: string | null }>('SELECT key, at, computer_id FROM note_apply_claims')].map((c) => [c.key, c]))
    return jsonResponse({ notes: page.map((row) => {
      const claim = row.outcome === null ? claims.get(noteKey(row)) : null
      return { ...this.ownerView(row), stateVersion: 1, status: row.outcome ?? 'open', outcomeAt: row.outcome_at ?? null, replies: replies.get(row.seq) ?? [], ...(claim ? { claim: { at: claim.at, mine: computer !== null && claim.computer_id === computer } } : {}), ...(row.parent_context ? { replyTo: JSON.parse(row.parent_context) } : {}) }
    }), more: rows.length > 200, cursor: page.at(-1)?.seq ?? after, refused: this.context.refusals(), limits: this.context.limits() })
  }

  /** A claim never expires: after a crash we cannot prove that the edit was not already written. */
  claimNote(value: unknown, computer: string | null = null): Response {
    this.context.ensure()
    const v = value as { key?: unknown; claim?: unknown; release?: unknown; force?: unknown; expectedAt?: unknown } | null
    if (typeof v?.key !== 'string' || !/^[0-9a-f]{24}\.[A-Za-z0-9_-]{8,64}$/.test(v.key) || typeof v.claim !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(v.claim)) return errorResponse('invalid_claim', 'An item and operation identity are required.', 400)
    this.ensureClaims()
    const [readerId, id] = v.key.split('.')
    const row = [...this.sql.exec<{ outcome: string | null }>('SELECT outcome FROM notes WHERE substr(reader_key, 1, ?) = ? AND id = ?', READER_ID_CHARS, readerId, id)][0]
    if (!row) return errorResponse('unknown_note', 'This item is no longer held.', 404)
    const old = [...this.sql.exec<{ claim: string; at: number; computer_id: string | null }>('SELECT claim, at, computer_id FROM note_apply_claims WHERE key = ?', v.key)][0]
    if (v.release === true) {
      if (v.force === true) {
        if (!old || row.outcome !== null || !computer || old.computer_id === computer || Date.now() - old.at <= READER_CLAIM_RELEASE_MS || v.expectedAt !== undefined && v.expectedAt !== old.at) return errorResponse('claim_not_releasable', 'This item is being handled on another Mac.', 409)
        this.state.storage.transactionSync(() => {
          this.sql.exec('CREATE TABLE IF NOT EXISTS note_claim_releases (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, claimed_at INTEGER NOT NULL, released_at INTEGER NOT NULL, released_by TEXT NOT NULL)')
          if (![...this.sql.exec<{ name: string }>('PRAGMA table_info(note_claim_releases)')].some((c) => c.name === 'claimed_by')) this.sql.exec('ALTER TABLE note_claim_releases ADD COLUMN claimed_by TEXT')
          this.sql.exec('INSERT INTO note_claim_releases (key, claimed_at, released_at, released_by, claimed_by) VALUES (?, ?, ?, ?, ?)', v.key, old.at, Date.now(), computer, old.computer_id)
          this.sql.exec('DELETE FROM note_apply_claims WHERE key = ?', v.key)
        })
      } else if (old?.claim === v.claim && old.computer_id === computer && row.outcome !== 'accepted') this.sql.exec('DELETE FROM note_apply_claims WHERE key = ? AND claim = ?', v.key, v.claim)
      return jsonResponse({ allowed: false })
    }
    if (row.outcome !== null) return jsonResponse({ allowed: false, status: row.outcome })
    // A lost response is retried only by the same in-memory operation, before its file write.
    if (old) return jsonResponse({ allowed: old.claim === v.claim && old.computer_id === computer, status: 'applying' })
    this.sql.exec('INSERT INTO note_apply_claims (key, claim, at, computer_id) VALUES (?, ?, ?, ?)', v.key, v.claim, Date.now(), computer)
    return jsonResponse({ allowed: true })
  }

  /** For the author's app: mark notes collected. Saying so twice changes nothing. */
  markCollected(value: unknown): Response {
    if (!this.context.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.context.ensure()
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
  clearNotes(value: unknown): Response {
    if (!this.context.row()) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.context.ensure()
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
  recordOutcomes(value: unknown, computer: string | null = null): Response {
    const share = this.context.row()
    if (!share) return errorResponse('unknown_share', 'This share does not exist.', 404)
    this.context.ensure()
    this.ensureClaims()
    const outcomes = parseOutcomes(value)
    const rawItems = (value as { outcomes: Array<{ key: string; baseOutcomeAt?: number | null }> }).outcomes
    const recorded: string[] = []
    const conflicts: string[] = []
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
        const raw = rawItems.find((r) => r.key === item.key)
        const claimed = [...this.sql.exec<{ computer_id: string | null }>('SELECT computer_id FROM note_apply_claims WHERE key = ?', item.key)][0]
        // Nothing from a different Mac, including replies that close a thread, may change this item
        // while its file edit is reserved. Old claims without an owner also fail closed.
        if (claimed && (!computer || claimed.computer_id !== computer) && row.outcome === null) { conflicts.push(item.key); continue }
        const stale = raw && Object.hasOwn(raw, 'baseOutcomeAt') && raw.baseOutcomeAt !== row.outcome_at && !(row.outcome === item.outcome && row.outcome_at === (item.outcome === null ? null : item.at))
        const finalAccept = claimed && row.outcome === 'accepted' && item.outcome !== 'accepted'
        if (!stale && !finalAccept && (row.outcome !== item.outcome || (item.outcome !== null && row.outcome_at !== item.at))) {
          this.sql.exec('UPDATE notes SET outcome = ?, outcome_at = ? WHERE seq = ?', item.outcome, item.outcome === null ? null : item.at, row.seq)
        }
        let kept = this.count('SELECT COUNT(*) AS n FROM note_replies WHERE note_seq = ?', row.seq)
        const answer = { key: item.key, kept: [] as string[], already: [] as string[], full: [] as string[] }
        for (const reply of item.replies) {
          if (this.count('SELECT COUNT(*) AS n FROM note_replies WHERE note_seq = ? AND id = ?', row.seq, reply.id) > 0) { answer.already.push(reply.id); continue }
          if (kept >= OUTCOME_LIMITS.repliesPerNote) { answer.full.push(reply.id); continue }
          this.sql.exec('INSERT INTO note_replies (note_seq, id, text, at, received_at, visibility) VALUES (?, ?, ?, ?, ?, ?)', row.seq, reply.id, reply.text, reply.at, now, reply.visibility === 'open' && share.comments_mode === 'open' ? 'open' : 'private')
          answer.kept.push(reply.id)
          kept += 1
        }
        if (answer.full.length > 0) full.push(item.key)
        if (item.replies.length > 0) replies.push(answer)
        if (stale || finalAccept) conflicts.push(item.key)
        else recorded.push(item.key)
      }
    })
    return jsonResponse({ recorded, waiting, unknown, full, replies, ...(conflicts.length ? { conflicts, problem: 'This item is being handled on another Mac.' } : {}) })
  }

}
