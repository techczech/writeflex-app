/**
 * The request and reply files by which the command line asks the app to carry out a write while the
 * app has the Collection open (specification section 4). Format version 1.
 *
 *   .writeflex/inbox/<id>.json    written by the command line, removed by the app after it replies
 *   .writeflex/outbox/<id>.json   written by the app, removed by the command line after reading
 *
 * A request is `{ version, id, operation, args }` and nothing else. The inbox is UNTRUSTED: any
 * program running as the user, and on a synced folder any other machine, can put a file there. So a
 * request is validated against a closed schema before anything acts on it: unknown fields, unknown
 * operations, unknown arguments and wrong types are refused. The operations are a closed list, the
 * command line's direct writes to the Collection plus undo (never export), and the shown-first
 * operations, which are never carried out: they become pending Changes in the review ledger
 * (review-format.ts, outside-change.ts). A request has no field for an author or a status. A
 * shown-first request's `source` argument is the caller's statement of who it is, which the app maps
 * to one of a closed list and never copies anywhere. The arguments are those the same operation takes on the command line, and every path among
 * them is judged with the document-path rule by whoever acts on it (request-executor.ts).
 *
 * A reply is `{ version, id, operation, outcome, at }` with the reason when refused, and the result
 * the operation prints when run directly when applied. THE OUTBOX IS UNTRUSTED TOO: any program that
 * can write the folder can place a reply, and what a reply says is printed to a terminal and read by
 * the calling agent. So a reply is checked as strictly as a request (`parseReply`), must carry an HMAC
 * made with a key the app keeps outside every Collection (`mac`; reply-key.ts), and is printed only
 * through the command line's one output place, where a hidden character is shown and never sent to
 * the terminal (terminal-text.ts). A reply's data is not altered on the way: a file name in a result
 * is the file's name. A reason quotes anything that came from the request file shortened, on one
 * line and in quotes.
 *
 * Electron-free; shared by both sides.
 */
import { randomBytes } from 'node:crypto'
import type { Operation, ParsedArgs } from './operation'
import { quoted } from './terminal-text'
import { isErrorCode, type ErrorCode } from './outcome'
import { isShownFirst, type ShownFirstOperation } from './review-format'

export const REQUEST_VERSION = 1
export const INBOX_DIR = '.writeflex/inbox'
export const OUTBOX_DIR = '.writeflex/outbox'
/** A request file, and a reply file, larger than this is refused unread. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024
export const MAX_REPLY_BYTES = 4 * 1024 * 1024
/** How long the command line waits for the reply before reporting "sent, not confirmed". */
export const REPLY_WAIT_MS = 10_000

/**
 * The closed list: ticket 04's direct writes to the Collection, undo, and ticket 07's version save
 * (a request for it names a document path, a name and a note, and nothing else: no author, no store). A test holds it equal to
 * the operation table's writers less `export`. Export is NEVER a request: it writes a file outside
 * the Collection, and a request can arrive from another machine through a synced folder, so a
 * requestable export would let that machine make this app write a file anywhere the user can. The
 * command line exports by itself instead (export-operation.ts).
 */
export const REQUEST_OPERATIONS = ['create', 'create-folder', 'duplicate', 'note', 'scrap', 'create-manifest', 'capture', 'move', 'move-folder', 'trash', 'undo', 'save-version'] as const
export type RequestOperation = (typeof REQUEST_OPERATIONS)[number]

/** Arguments that exist only at the terminal and never travel: piped text arrives as the text itself. */
const NOT_SENT = new Set(['stdin', 'list'])
/** Arguments that carry a document's text; every other string is a name or a path and is kept short.
 *  `target`, `with`, `after` and `value` are a shown-first request's; their own limits are the
 *  validator's (outside-change.ts), which closes an oversized one with its reason. */
const TEXT_ARGS = new Set(['content', 'body', 'text', 'target', 'with', 'after', 'value'])
const MAX_NAME_LENGTH = 4096

const ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{16}$/
/** `<id>.json`, exactly. Anything else in the inbox (a sync conflict copy, a stray file) is not a request. */
export const requestFileName = (id: string): string => `${id}.json`
export const idOfFileName = (name: string): string | null => (name.endsWith('.json') && ID.test(name.slice(0, -5)) ? name.slice(0, -5) : null)
/**
 * A request the app has CLAIMED: before it reads `<id>.json` it renames it to this name, inside the
 * inbox. The rename is the one thing only one side can do to the file, so it settles who has it: the
 * app (the request is being read and added), or `writeflex withdraw`, whose removal of `<id>.json`
 * then fails. Nothing about the request's content changes. The app gives the name back when it leaves
 * the request for a later look, and a claimed file left by an app that stopped is read again at the
 * next look (request-executor.ts).
 */
export const CLAIMED_SUFFIX = '.taken'
export const claimedFileName = (id: string): string => `${requestFileName(id)}${CLAIMED_SUFFIX}`
export const idOfClaimedName = (name: string): string | null => (name.endsWith(CLAIMED_SUFFIX) ? idOfFileName(name.slice(0, -CLAIMED_SUFFIX.length)) : null)
/** A name that carries a request id but is not a request's own name: what a sync conflict copy looks like. */
export const looksLikeConflictCopy = (name: string): boolean => /\d{8}T\d{9}Z-[0-9a-f]{16}/.test(name) && idOfFileName(name) === null && idOfClaimedName(name) === null && !name.endsWith('.tmp')

export function newRequestId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(8).toString('hex')}`
}

/** When the request named by `id` says it was made (the id is the sender's word, not proof). */
export function requestTime(id: string): number | null {
  const m = ID.exec(id)
  if (!m) return null
  const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`)
  return Number.isNaN(at) ? null : at
}

export type WriteRequest = { version: 1; id: string; operation: RequestOperation | ShownFirstOperation; args: ParsedArgs }

/** Every operation a request file may name: the direct writes, and the shown-first ones (review-format.ts). */
export const isRequestable = (operation: string): boolean => (REQUEST_OPERATIONS as readonly string[]).includes(operation) || isShownFirst(operation)

export type Reply = {
  version: 1
  id: string
  /** The operation the request asked for, echoed; absent only when the request could not be read that far. */
  operation?: string
  outcome: 'applied' | 'refused'
  at: string
  /** Refused: why, in words for the person; and the command line's own class of failure. */
  reason?: string
  /** From the closed list in outcome.ts; a reply with any other code is not a reply. */
  code?: ErrorCode
  /** HMAC-SHA-256 (hex) of the rest of the reply under the Collection's reply key (reply-key.ts). */
  mac?: string
  /** Applied: what the same operation prints when run directly (`--json` and plain). */
  result?: unknown
  text?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const onlyKeys = (value: Record<string, unknown>, allowed: string[]): string | null => Object.keys(value).find((key) => !allowed.includes(key)) ?? null

/** The arguments a request for `operation` may carry: the operation's own, less the terminal-only ones. */
export function requestArgSpecs(operation: Operation): Operation['args'] {
  return operation.args.filter((spec) => !NOT_SENT.has(spec.name))
}

/**
 * A valid request, or why not. `id` is the one in the file's name; the content must agree. `table`
 * is the command line's operation table, whose argument schemas are the request's.
 */
export function parseRequest(text: string, id: string, table: Operation[]): { ok: true; request: WriteRequest } | { ok: false; reason: string } {
  const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return no('it is not readable as a request (not JSON)') }
  if (!isRecord(raw)) return no('it is not readable as a request (not an object)')
  if (raw.version !== REQUEST_VERSION) return no(`its format version (${Number.isSafeInteger(raw.version) ? String(raw.version) : 'not a number'}) is not one this WriteFlex knows; it knows version ${REQUEST_VERSION}`)
  const extra = onlyKeys(raw, ['version', 'id', 'operation', 'args'])
  if (extra !== null) return no(`it has a field this format does not have: ${quoted(extra, 40)}`)
  if (raw.id !== id) return no('the identifier inside it is not the one in its file name')
  if (typeof raw.operation !== 'string' || !isRequestable(raw.operation)) return no(`it asks for an operation that cannot be requested: ${quoted(raw.operation, 40)}`)
  const operation = table.find((candidate) => candidate.name === raw.operation)
  if (!operation) return no(`it asks for an operation this WriteFlex does not have: ${raw.operation}`)
  if (!isRecord(raw.args)) return no('its arguments are not an object')
  const specs = requestArgSpecs(operation)
  const unknown = onlyKeys(raw.args, specs.map((spec) => spec.name))
  if (unknown !== null) return no(`${operation.name} takes no argument ${quoted(unknown, 40)}`)
  const args: ParsedArgs = {}
  for (const spec of specs) {
    const value = raw.args[spec.name]
    if (value === undefined) {
      if (spec.required) return no(`${operation.name} needs ${spec.name}`)
      continue
    }
    const fits = spec.type === 'string' ? typeof value === 'string' : spec.type === 'integer' ? Number.isSafeInteger(value) : typeof value === 'boolean'
    if (!fits) return no(`${spec.name} must be ${spec.type === 'string' ? 'text' : spec.type === 'integer' ? 'a whole number' : 'true or false'}`)
    if (typeof value === 'string' && !TEXT_ARGS.has(spec.name) && (value.length > MAX_NAME_LENGTH || value.includes('\0'))) return no(`${spec.name} is not a usable name or path`)
    args[spec.name] = value as string | number | boolean
  }
  return { ok: true, request: { version: 1, id, operation: operation.name as WriteRequest['operation'], args } }
}

/**
 * A well-formed reply to request `id`, or null: version 1, no field the format does not have, the
 * id the request's, the outcome one of the two, a refusal with its reason, a result that is an
 * object. Shape only: whether it is signed is the reader's next question (reply-key.ts).
 */
export function parseReply(text: string, id: string): Reply | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (!isRecord(raw) || raw.version !== REQUEST_VERSION || raw.id !== id) return null
  if (onlyKeys(raw, ['version', 'id', 'operation', 'outcome', 'at', 'reason', 'code', 'result', 'text', 'mac']) !== null) return null
  if ((raw.outcome !== 'applied' && raw.outcome !== 'refused') || typeof raw.at !== 'string' || raw.at.length > 64) return null
  if (raw.operation !== undefined && (typeof raw.operation !== 'string' || raw.operation.length > 64)) return null
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return null
  if (raw.text !== undefined && typeof raw.text !== 'string') return null
  if (raw.code !== undefined && !isErrorCode(raw.code)) return null
  if (raw.outcome === 'refused' && raw.reason === undefined) return null
  if (raw.result !== undefined && !isRecord(raw.result)) return null
  if (raw.mac !== undefined && typeof raw.mac !== 'string') return null
  return raw as Reply
}
