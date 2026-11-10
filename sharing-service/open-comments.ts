// Visibility and thread addressing live beside storage. Reader ids never serve as public thread ids.
import { NoteProtocolError } from './reader-notes.ts'

export const READER_ID_CHARS = 24
export const OPEN_COMMENTS_LIMIT = 200
// On open links readers see each other's proposed edits as well as comments.
export const openCommentPredicate = (): string => "visibility = 'open'"

export type CommentsMode = 'private' | 'open'
export const commentsMode = (value: unknown): CommentsMode => value === 'open' ? 'open' : 'private'

export function parseCommentsMode(value: unknown): CommentsMode {
  if (value !== 'private' && value !== 'open') throw new NoteProtocolError('invalid_settings', 'Comments must be private or open.')
  return value
}

export function ensureOpenCommentsSchema(sql: SqlStorage): void {
  const columns = (table: string) => [...sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)].map((c) => c.name)
  if (!columns('share').includes('comments_mode')) sql.exec("ALTER TABLE share ADD COLUMN comments_mode TEXT NOT NULL DEFAULT 'private'")
  const notes = columns('notes')
  if (!notes.includes('visibility')) sql.exec("ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'")
  if (!notes.includes('public_id')) sql.exec('ALTER TABLE notes ADD COLUMN public_id TEXT')
  if (!notes.includes('parent_id')) sql.exec('ALTER TABLE notes ADD COLUMN parent_id TEXT')
  if (!notes.includes('parent_context')) sql.exec('ALTER TABLE notes ADD COLUMN parent_context TEXT')
  if (!columns('note_replies').includes('visibility')) sql.exec("ALTER TABLE note_replies ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'")
  sql.exec('CREATE INDEX IF NOT EXISTS notes_visible ON notes (visibility, seq)')
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS notes_public_id ON notes (public_id)')
}

export type ThreadRow = { visibility?: string; public_id?: string | null; parent_id?: string | null; parent_context?: string | null }

/** Recheck after every await: a switch to private or a cleared target closes replies immediately. */
export function replyTarget(sql: SqlStorage, mode: unknown, id: string): { anchor: Record<string, unknown>; root: string; parent: { key: string; name: string; text: string } } {
  const fail = (): never => { throw new NoteProtocolError('reply_unavailable', 'This comment cannot be replied to.') }
  if (mode !== 'open') return fail()
  const row = [...sql.exec<{ public_id: string; parent_id: string | null; quote: string; before_text: string; after_text: string; block: string | null; start_at: number | null; end_at: number | null }>(
    `SELECT public_id, parent_id, quote, before_text, after_text, block, start_at, end_at FROM notes WHERE public_id = ? AND ${openCommentPredicate()}`, id,
  )][0]
  if (!row) return fail()
  const root = row.parent_id ?? row.public_id
  const parent = [...sql.exec<{ reader_key: string; id: string; name: string; text: string }>(`SELECT reader_key, id, name, text FROM notes WHERE public_id = ? AND ${openCommentPredicate()}`, root)][0]
  if (!parent) return fail()
  return { root, parent: { key: `${parent.reader_key.slice(0, READER_ID_CHARS)}.${parent.id}`, name: parent.name, text: parent.text }, anchor: { quote: row.quote, before: row.before_text, after: row.after_text, block: row.block, start: row.start_at, end: row.end_at } }
}
