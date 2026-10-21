// The service-wide limit on readers' notes (limits apply per reader, per share and in total). Per-reader and per-share limits live in each share's object (shared-piece.ts); this is
// the one count across every share, kept in the `SharingRegistry` singleton beside the signing
// key, in its own table (`note_budget`). Nothing here reads or touches the signing key.
//
// A share's object asks for one note's room after its own limits have passed and the note's place
// in them is held, so a share refused by its own limits, or a copy of a note already on its way,
// never spends the service's room. A grant is spent only on a note that is kept: when the note is
// not kept after all (the link or comments turned off meanwhile), the share gives the grant back.
// The count is a sliding hour of per-minute buckets; buckets older than an hour are deleted as new
// ones are written.
//
//   POST /internal/note-budget          → 200 {granted: true, minute} | {granted: false}; refusals are counted.
//   POST /internal/note-budget/refund   {minute} → 200 {refunded}: one grant of that minute given back.
import { errorResponse, jsonResponse, registryStub, type Env } from './http.ts'
import { NOTE_LIMITS } from './reader-notes.ts'

export const NOTE_BUDGET_PATH = '/internal/note-budget'
const REFUND_PATH = '/internal/note-budget/refund'
const MINUTE = 60_000

export class NoteBudgetTable {
  private readonly sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.sql = sql
    sql.exec('CREATE TABLE IF NOT EXISTS note_budget (minute INTEGER PRIMARY KEY, granted INTEGER NOT NULL, refused INTEGER NOT NULL)')
  }

  /** Room for one more note now? Synchronous: the read and the write are one stretch. */
  take(now = Date.now(), perHour: number = NOTE_LIMITS.servicePerHour): boolean {
    return this.grant(now, perHour) !== null
  }

  /** The minute a grant was counted in, or null when there is no room. */
  grant(now = Date.now(), perHour: number = NOTE_LIMITS.servicePerHour): number | null {
    const minute = Math.floor(now / MINUTE)
    const since = minute - 59
    this.sql.exec('DELETE FROM note_budget WHERE minute < ?', since)
    const used = [...this.sql.exec<{ n: number | null }>('SELECT SUM(granted) AS n FROM note_budget WHERE minute >= ?', since)][0]?.n ?? 0
    const granted = used < perHour
    this.sql.exec(
      'INSERT INTO note_budget (minute, granted, refused) VALUES (?, ?, ?) ON CONFLICT(minute) DO UPDATE SET granted = granted + excluded.granted, refused = refused + excluded.refused',
      minute, granted ? 1 : 0, granted ? 0 : 1,
    )
    return granted ? minute : null
  }

  /** Give back one grant counted in `minute`. A minute that has left the hour has nothing to give back. */
  refund(minute: number): boolean {
    const before = [...this.sql.exec<{ granted: number }>('SELECT granted FROM note_budget WHERE minute = ?', minute)][0]?.granted ?? 0
    if (before < 1) return false
    this.sql.exec('UPDATE note_budget SET granted = granted - 1 WHERE minute = ?', minute)
    return true
  }

  async route(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== NOTE_BUDGET_PATH && url.pathname !== REFUND_PATH) return null
    if (request.method !== 'POST') return errorResponse('not_found', 'Registry route not found.', 404)
    if (url.pathname === NOTE_BUDGET_PATH) {
      const minute = this.grant()
      return jsonResponse(minute === null ? { granted: false } : { granted: true, minute })
    }
    const minute = ((await request.json().catch(() => null)) as { minute?: unknown } | null)?.minute
    if (!Number.isSafeInteger(minute)) return errorResponse('invalid_refund', 'A refund names the minute of its grant.', 400)
    return jsonResponse({ refunded: this.refund(minute as number) })
  }
}

/** A grant of one note's room: the minute it was counted in, to give it back by. */
export interface NoteGrant { minute: number }

/**
 * Ask the registry for one note's room: a grant, `'full'` when the registry answered that there is
 * no room, or `'unavailable'` when it gave no usable answer (an error is not a "no").
 */
export async function takeNoteBudget(env: Env): Promise<NoteGrant | 'full' | 'unavailable'> {
  try {
    const response = await registryStub(env).fetch(new Request(`https://internal${NOTE_BUDGET_PATH}`, { method: 'POST' }))
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return 'unavailable'
    }
    const body = await response.json().catch(() => null) as { granted?: unknown; minute?: unknown } | null
    if (body?.granted === true && Number.isSafeInteger(body.minute)) return { minute: body.minute as number }
    return body?.granted === false ? 'full' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** Give a grant back for a note that was not kept. A refund that does not arrive leaves the grant spent. */
export async function refundNoteBudget(env: Env, grant: NoteGrant): Promise<void> {
  try {
    const response = await registryStub(env).fetch(new Request(`https://internal${REFUND_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minute: grant.minute }),
    }))
    await response.body?.cancel().catch(() => {})
  } catch {
    // The grant stays spent: the service's hour is a little shorter, never longer.
  }
}
