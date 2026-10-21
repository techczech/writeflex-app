/**
 * The command line's half of "the app carries out the write" (specification sections 4 and 5): when
 * the app owns the Collection, a write operation becomes ONE request file in `.writeflex/inbox/`,
 * created whole, and the command line waits for the app's reply in `.writeflex/outbox/`. It writes
 * nothing else: no document, no journal entry (the app, which makes the change, records it in the
 * journal so that undo has the content before), no lock.
 *
 * THE REPLY IS UNTRUSTED: any program that can write the outbox can place one, and it is printed to a
 * terminal and read by the calling agent. So:
 *  - it is read from a held, verified outbox, without following a link, only if a regular file, under
 *    a size cap (request-files.ts);
 *  - it must fit the version-1 reply format exactly (no unknown field, the request's id, an outcome
 *    from the closed list) and echo the operation that was sent;
 *  - it must be SIGNED with this Collection's reply key, which the app keeps in its own
 *    application-data folder, outside every Collection (reply-key.ts, which says what the key does and
 *    does not stop). The key is read before the request is sent; the HMAC is recomputed over what was
 *    parsed and compared in constant time;
 *  - a reply that fails any of these is removed, none of it is printed, and the wait goes on for the
 *    app's own reply; if none comes the result is "sent, not confirmed", exit code 3, saying whether
 *    a reply was unreadable or could not be verified;
 *  - what is printed of an accepted reply goes through the one output place (run.ts), where hidden
 *    characters are shown, not sent to the terminal.
 *
 * THE OWNER LOCK IS THE ROUTING DECISION ONLY. It says who should carry out the write (the app, by
 * request; or the command line, under the lock). It is a file inside the Collection and proves
 * nothing about a reply; it is not looked at when a reply is read. A lock that names a live app when
 * there is no key (a lock forged or synced in, or an app on another computer) gets a refusal that
 * says so and how to proceed. Nothing is sent, and the command line does not write directly while a
 * lock claims a live owner: a forged lock can delay a write and nothing more.
 *
 * With no acceptable reply inside the wait, the request is left for the app.
 */
import { hostname } from 'node:os'
import { inspectOwnerLock, type OwnerLockEnv } from '../owner-lock'
import { readReplyKeys, replyIsSigned } from '../reply-key'
import { CliError, type Operation, type OperationResult, type ParsedArgs } from './operation'
import { quoted } from './terminal-text'
import { coarseOf } from './outcome'
import { isShownFirst } from './review-format'
import { FolderNotUsableError, holdFolder, type HeldFolder } from './request-files'
import {
  INBOX_DIR, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, OUTBOX_DIR, REPLY_WAIT_MS, isRequestable,
  newRequestId, parseReply, requestArgSpecs, requestFileName, type Reply,
} from './request-format'

export type RequestSurroundings = {
  stdin: () => Promise<string>
  lockEnv?: OwnerLockEnv
  /** The folders that may hold this Collection's reply key (reply-key.ts): the release app's and the beta's. */
  keyFolders: string[]
  now?: () => Date
  waitMs?: number
  pollMs?: number
}

const TEXT_ARGS = ['content', 'body', 'text']
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS'])
const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms) })

/** The arguments as the request carries them: piped text arrives as the text itself. */
async function requestArgs(operation: Operation, args: ParsedArgs, surroundings: RequestSurroundings): Promise<ParsedArgs> {
  const sent: ParsedArgs = {}
  for (const spec of requestArgSpecs(operation)) if (args[spec.name] !== undefined) sent[spec.name] = args[spec.name]
  if (args.stdin === true) {
    const name = operation.args.find((spec) => TEXT_ARGS.includes(spec.name))?.name
    if (!name) throw new CliError(`${operation.name} takes no text from standard input.`, 'usage')
    if (args[name] !== undefined) throw new CliError(`Give --${name} or --stdin, not both.`, 'usage')
    sent[name] = await surroundings.stdin()
  }
  return sent
}

/**
 * The refusal when the owner lock says an app has the Collection and there is no reply key for it.
 * Nothing is sent, and nothing is written directly either: a lock that claims a live owner is never
 * overridden, whoever wrote it. A forged lock can therefore delay a write (until it goes stale, or
 * the user removes it) and can do nothing else.
 */
async function unverifiedOwner(root: string, lockEnv: OwnerLockEnv = {}): Promise<string> {
  const status = await inspectOwnerLock(root, lockEnv).catch(() => null)
  const owner = status && status.state === 'held' ? status.owner : null
  const elsewhere = owner !== null && owner.host.toLowerCase() !== (lockEnv.host ?? hostname()).toLowerCase()
  const start = 'WriteFlex appears to have this Collection open, but that could not be verified, so nothing was sent and nothing was changed. '
  if (elsewhere) {
    return `${start}The Collection's lock names WriteFlex on another computer (${quoted(owner.host, 80)}), which this command line cannot ask. `
      + 'Run the command on that computer, or close the Collection there and run it again here once the lock has cleared (within two minutes).'
  }
  return `${start}The Collection's lock names a running WriteFlex${owner ? ` (process ${owner.pid})` : ''}, but WriteFlex has left no key for this Collection in its own application-data folder, as it does for every Collection it opens. `
    + 'If WriteFlex does have this Collection open, close the Collection there and open it again (or update WriteFlex), then run the command again. '
    + 'If it does not, the lock was left or put there by something else: it clears by itself within two minutes if nothing keeps renewing it, after which the command will write directly; '
    + `if it does not clear, check what is writing ${root}/.writeflex/owner.lock before removing it.`
}

/**
 * Write ONE request file for `operation` into the inbox, whole, and return its id. Nothing else is
 * written. Used for a request the app will answer (`sendToApp`) and for a shown-first request left to
 * wait while no app has the Collection open (review-route.ts).
 */
export async function fileRequest(root: string, operation: Operation, args: ParsedArgs, surroundings: Pick<RequestSurroundings, 'stdin' | 'now'>): Promise<string> {
  const id = newRequestId(surroundings.now?.())
  const body = `${JSON.stringify({ version: 1, id, operation: operation.name, args: await requestArgs(operation, args, { keyFolders: [], ...surroundings }) })}\n`
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw new CliError(`This is too large to pass to WriteFlex as one request (the limit is ${MAX_REQUEST_BYTES / (1024 * 1024)} MB). Nothing was sent. A direct change of this size can be made with the Collection closed in WriteFlex.`, 'refused', 'request-too-large')
  }
  try {
    const inbox = (await holdFolder(root, INBOX_DIR, true))!
    try { await inbox.write(requestFileName(id), body) } finally { await inbox.close() }
  } catch (error) {
    if (error instanceof FolderNotUsableError) throw new CliError(`The request could not be sent: ${error.message}`)
    const code = (error as NodeJS.ErrnoException).code
    if (code && DENIED.has(code)) throw new CliError(`The command line is not allowed to write in this Collection (${code}). If it runs in a sandbox, allow writing to this folder: ${root}`, 'refused', 'write-not-permitted')
    throw error
  }
  return id
}

/** Not confirmed: the outcome is then `sent-not-confirmed` (no answer) or `not-verified` (an answer that could not be taken). */
export type RouteResult = { confirmed: true; result: OperationResult } | { confirmed: false; result: OperationResult }

/**
 * Ask the app that owns the Collection at `root` to carry out `operation`. Resolves with the app's
 * result, or with "sent, not confirmed"; throws the app's refusal as a `CliError`.
 */
export async function sendToApp(root: string, operation: Operation, args: ParsedArgs, surroundings: RequestSurroundings): Promise<RouteResult> {
  if (!isRequestable(operation.name)) {
    throw new CliError(`WriteFlex has this Collection open, and ${operation.name} cannot be passed to it. Close the Collection in WriteFlex and run the command again.`, 'refused', 'not-passable-to-app')
  }
  // No key, no request: without the key no reply could ever be verified, and the owner lock that sent
  // us here is a file inside the Collection that anything able to write the Collection could have put there.
  const keys = await readReplyKeys(surroundings.keyFolders, root)
  if (keys.length === 0) throw new CliError(await unverifiedOwner(root, surroundings.lockEnv), 'refused', 'owner-not-verified', false)
  const id = await fileRequest(root, operation, args, surroundings)

  const waitMs = surroundings.waitMs ?? REPLY_WAIT_MS
  const pollMs = surroundings.pollMs ?? 100
  const deadline = Date.now() + waitMs
  // The outbox is the app's to make; once it is there it is opened once and held for the wait.
  let outbox: HeldFolder | null = null
  /** What stood at the reply's name and was not taken: it is removed, and the wait goes on for the app's own. */
  let turnedAway: 'unreadable' | 'unverified' | null = null
  try {
    for (;;) {
      outbox ??= await holdFolder(root, OUTBOX_DIR, false)
      const reply = outbox ? await takeReply(outbox, id, operation.name, keys) : null
      if (reply === 'unreadable' || reply === 'unverified') turnedAway = reply
      else if (reply) return { confirmed: true, result: delivered(reply) }
      if (Date.now() >= deadline) break
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  } catch (error) {
    if (error instanceof FolderNotUsableError) throw new CliError(`WriteFlex's reply cannot be read: ${error.message} The request was sent and the result is not known. Check the Collection before repeating the command.`, 'failed', 'reply-unreadable', true)
    throw error
  } finally {
    await outbox?.close()
  }
  const seconds = Math.round(waitMs / 100) / 10
  const unconfirmed = (text: string): RouteResult => ({ confirmed: false, result: { outcome: turnedAway ? 'not-verified' : 'sent-not-confirmed', data: { request: id, ...(turnedAway ? { reply: turnedAway } : {}) }, text } })
  if (turnedAway === 'unverified') {
    return unconfirmed(`The request WAS sent. A reply to request ${id} was found, but it could not be verified as written by WriteFlex (it was not signed with this Collection's key), so none of it is shown and the result is not known. Check the Collection before repeating the command.`)
  }
  if (turnedAway === 'unreadable') {
    return unconfirmed(`The request WAS sent. WriteFlex's reply could not be read. What stood in place of the reply to request ${id} was not in the form a reply has, so none of it is shown and the result is not known. Check the Collection before repeating the command.`)
  }
  return unconfirmed(`WriteFlex has this Collection open and did not answer within ${seconds} second${seconds === 1 ? '' : 's'}. The request (${id}) is left for it; do not repeat the command until you have checked whether it was carried out.`)
}

/**
 * The reply to request `id`: null while there is none; `unreadable` when what stands at its name is
 * not a reply to this request; `unverified` when it is one in form but not signed with one of `keys`.
 * Whatever was read is removed from the outbox.
 */
async function takeReply(outbox: HeldFolder, id: string, operation: string, keys: Buffer[]): Promise<Reply | 'unreadable' | 'unverified' | null> {
  const read = await outbox.read(requestFileName(id), MAX_REPLY_BYTES)
  if (read.kind === 'missing') return null
  await outbox.remove(requestFileName(id))
  const reply = read.kind === 'text' ? parseReply(read.text, id) : null
  if (!reply || reply.operation !== operation) return 'unreadable'
  // The signature is over what was parsed, every field of it; nothing of an unsigned reply is ever used.
  if (!replyIsSigned(keys, reply)) return 'unverified'
  return reply
}

function delivered(reply: Reply): OperationResult {
  // The code is the app's, from the closed list (parseReply refused anything else); nothing is read from the wording.
  if (reply.outcome === 'refused') throw new CliError(reply.reason ?? 'WriteFlex refused the request.', coarseOf(reply.code ?? 'refused'), reply.code ?? 'refused')
  // A shown-first operation the app answered is filed for review; anything else it answered is done.
  return { outcome: isShownFirst(reply.operation ?? '') ? 'filed' : 'done', data: reply.result ?? {}, text: reply.text ?? 'Carried out by WriteFlex.' }
}
