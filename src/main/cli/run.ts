import { execFile } from 'node:child_process'
import { asksForJson, parseInvocation } from './args'
import { CliError, type Operation, type OperationContext } from './operation'
import { OUTCOME_LINES, renderOutcome, type Outcome } from './outcome'
import { resolveCollectionRoot, type CollectionRoot } from './root'
import { CommandLineWorkspace } from './guarded-workspace'
import { buildOperationTable } from './table'
import { READ_REQUEST_OPERATIONS, REQUEST_OPERATIONS } from './request-format'
import { MAX_STDIN_BYTES, stdinTooLarge } from './stdin'
import { sendToApp, type RequestSurroundings } from './request-route'
import { fileForReview, type ReviewFiling } from './review-route'
import { capped, escapeForJson, quoted, showText } from './terminal-text'
import { chooseWriteRoute, recordsPlace, replyKeyFolders, withWriteAccess, type WriteEnv } from './write-access'

export type CliEnv = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  openUrl?: OperationContext['openUrl']
  /** Test seam for root discovery; production uses the user's own home folder. */
  home?: string
  /** Everything piped to the command; production reads standard input, up to the limit (stdin.ts). */
  stdin?: () => Promise<string>
  /** Whether standard output is a terminal (production: `process.stdout.isTTY`). Decides how `read` prints. */
  stdoutIsTerminal?: boolean
  /** Test seams for operations that write (write-access.ts); production passes nothing. */
  write?: WriteEnv
  /** The environment variables read (WRITEFLEX_SOURCE); production reads the process's own. */
  environ?: Record<string, string | undefined>
}

/** The system's `open`, by its own path: nothing the command line runs is looked up on `PATH`. */
export const OPEN_PATH = '/usr/bin/open'

const systemOpen = (url: string): Promise<void> =>
  new Promise((done, fail) => execFile(OPEN_PATH, [url], (error) => (error ? fail(new Error(`Could not ask the system to open the link: ${error.message}`)) : done())))

/**
 * One invocation: parse, find the Collection, run the operation, print. Under `--json` stdout carries
 * exactly one JSON document, for errors too; in text mode errors go to stderr. Returns the exit code
 * (0 done, 1 refused or failed, 2 usage, 3 sent to the app and not confirmed).
 *
 * An operation that is SHOWN FIRST (it would change an existing document) changes nothing: it checks
 * the request against what is saved on disk and files it for review (review-route.ts). `outcome` is
 * then `filed`, with `shown: "now"` when the app added it to its review dock (`via: "app"`) and
 * `shown: "when-opened"` when it waits for the Collection to be opened.
 *
 * An operation that writes is carried out by whoever owns the Collection: by the app when it has the
 * Collection open (the command line files one request and reports the app's reply; `via: "app"` in
 * the JSON document), otherwise here, under the owner lock. Export is the exception: it writes
 * nothing in the Collection and is never a request, so with the app open it runs here, without the
 * lock, from what is saved on disk.
 *
 * Every invocation that acts on a Collection names its root and how it came by it: `root` and
 * `rootSource` ("given" with --root, "discovered" by climbing to a marker) in the JSON document, and
 * in text mode one `writeflex: Collection given: <root>` or `writeflex: Collection found: <root>`
 * line on stderr before anything else, which leaves stdout exactly the result (a document read stays
 * pipeable).
 *
 * THIS IS THE ONE PLACE OUTPUT IS WRITTEN (`say`, `sayJson`), and nothing leaves it able to drive a
 * terminal: a file name in the Collection, a reason, a reply from the app can each carry escape
 * sequences. In plain text every hidden character is SHOWN as `\u{hex}`, never removed, so two
 * different names never print the same and a printed name, with each `\u{hex}` put back, is the name
 * `--json` carries (terminal-text.ts has the rule). The one exception is a document's own content
 * from `read` WHEN STANDARD OUTPUT IS NOT A TERMINAL (a pipe, a file): it is then printed byte for
 * byte, so that it can be piped. To a terminal a document is shown by the same rule as everything
 * else, since its text is as able to drive the terminal as a file name is. There is no flag for
 * this: where the output goes decides. A JSON document is written with every such
 * character as JSON's own `\uXXXX` escape: it parses to the true value and shows nothing raw. An error
 * message is prose, not data: it is shown the plain-text way in JSON too, and cut at a length with a
 * marker that says how much was cut.
 *
 * A path ARGUMENT is always taken literally. If one contains the `\u{hex}` notation, that is said
 * (`notes` in the JSON document, a line on stderr in plain text) and the notation is not decoded: the
 * escaped form is for reading, the JSON form is for passing back.
 *
 * TEXT PIPED IN (`--stdin`) IS READ HERE, ONCE, BEFORE ANY ROUTE IS CHOSEN: before the owner lock is
 * taken and before a request is filed. More than the limit (stdin.ts) is refused there, with nothing
 * changed and the lock never held; the operation is then handed the text already read.
 */
/** A reason, whoever wrote it, is shown up to this many characters. */
const MAX_REASON = 8192
/** Arguments that name a file or folder in the Collection. */
const PATH_ARGUMENTS = new Set(['path', 'to', 'document', 'folder', 'dir', 'a', 'b', 'origin', 'source-path'])

/** Whether the operation can change things (so its errors carry the fixed outcome line). */
const isWriteKind = (op: Operation): boolean => op.writes !== undefined && op.writes !== false || op.behaviour === 'shown-first' || op.name === 'withdraw'

export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const table = buildOperationTable()
  let wantsJson = asksForJson(argv)
  let found: CollectionRoot | undefined
  const notes: string[] = []
  const named = (): Record<string, unknown> => ({ ...(found ? { root: found.root, rootSource: found.source } : {}), ...(notes.length ? { notes: notes.map(showText) } : {}) })
  const say = (write: (text: string) => void, text: string): void => write(`${showText(text)}\n`)
  const sayJson = (document: unknown): void => env.stdout(`${escapeForJson(JSON.stringify(document))}\n`)
  /** The operation once it is known; an error before that (a bad flag) is not labelled. */
  let current: Operation | undefined
  const fail = (error: unknown): number => {
    const known = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error), 'failed')
    const { outcome } = known
    if (wantsJson) sayJson({ ok: false, outcome, ...named(), error: { code: known.errorCode, message: showText(capped(known.message, MAX_REASON)), ...(known.sent === undefined ? {} : { sent: known.sent }) } })
    else say(env.stderr, `writeflex: ${current && isWriteKind(current) ? `${OUTCOME_LINES[outcome]} ` : ''}${capped(known.message, MAX_REASON)}`)
    return known.code === 'usage' ? 2 : 1
  }
  try {
    const invocation = parseInvocation(argv, table)
    wantsJson = invocation.output === 'json'
    const operation = invocation.operation ?? table.find((op) => op.name === 'help')!
    current = operation
    // The declared source: per operation, then the global flag, then the environment. Passed through as given.
    if (operation.args.some((spec) => spec.name === 'source') && invocation.args.source === undefined) {
      const declared = invocation.source ?? (env.environ ?? process.env).WRITEFLEX_SOURCE
      if (declared) invocation.args.source = declared
    }
    // help and describe need no Collection; everything else does.
    const needsRoot = operation.name !== 'help' && operation.name !== 'describe'
    if (needsRoot) {
      found = resolveCollectionRoot(env.cwd, invocation.root, env.home === undefined ? {} : { home: env.home })
      if (invocation.output !== 'json') say(env.stderr, `writeflex: Collection ${found.source === 'given' ? 'given' : 'found'}: ${found.root}`)
    }
    // Piped text: all of it now, before a lock or a request exists, and refused past the limit.
    let piped = ''
    if (invocation.args.stdin === true) {
      piped = await (env.stdin ?? (async () => ''))()
      if (Buffer.byteLength(piped, 'utf8') > MAX_STDIN_BYTES) throw stdinTooLarge()
    }
    const ctx: OperationContext = {
      workspace: new CommandLineWorkspace(found?.root ?? env.cwd), output: invocation.output, openUrl: env.openUrl ?? systemOpen,
      cwd: env.cwd, stdin: async () => piped,
    }
    const literal = Object.entries(invocation.args).filter(([name, value]) => PATH_ARGUMENTS.has(name) && typeof value === 'string' && /\\u\{[0-9a-f]{1,6}\}/.test(value))
    notes.push(...literal.map(([name, value]) => `${name} ${quoted(value)} contains the notation writeflex uses to SHOW a hidden character in plain text (a backslash, u, and a number in braces). It was taken literally, as those very characters; to name a file with a hidden character in it, take its path from --json output.`))
    if (invocation.output !== 'json') for (const note of notes) say(env.stderr, `writeflex: note: ${note}`)
    const writes = typeof operation.writes === 'function' ? operation.writes(invocation.args) : operation.writes === true
    const writeKind = writes || operation.behaviour === 'shown-first' || operation.name === 'withdraw'
    const writeEnv: WriteEnv = { ...(env.home === undefined ? {} : { home: env.home }), ...env.write }
    ctx.replyKeyFolders = replyKeyFolders(writeEnv)
    ctx.records = recordsPlace(writeEnv)
    const surroundings = (): RequestSurroundings => ({ stdin: ctx.stdin, now: writeEnv.now, lockEnv: writeEnv.lockEnv, keyFolders: replyKeyFolders(writeEnv), ...writeEnv.request })
    // A shown-first operation, and withdrawing one, change nothing in the Collection but the command
    // line's own request file. They still need a root the user chose, and the same routing decision.
    const ownsOnlyTheInbox = operation.behaviour === 'shown-first' || operation.name === 'withdraw'
    const reviewRoute = ownsOnlyTheInbox && found ? await chooseWriteRoute(found, writeEnv) : null
    let filing: ReviewFiling | null = null
    if (operation.behaviour === 'shown-first' && found && reviewRoute) {
      const { root } = found
      ctx.fileForReview = async (filed, args, proposed) => {
        filing = await fileForReview(root, reviewRoute, filed, args, proposed, surroundings())
        return filing.result
      }
    }
    const liveRead = (READ_REQUEST_OPERATIONS as readonly string[]).includes(operation.name)
    const appOwns = (writes || liveRead) && found ? await chooseWriteRoute(found, writeEnv) === 'app' : false
    const requestable = liveRead || (REQUEST_OPERATIONS as readonly string[]).includes(operation.name)
    const routed = appOwns && requestable && found
      ? await sendToApp(found.root, operation, invocation.args, surroundings())
      : null
    const result = routed ? routed.result : appOwns
      // Not a request and not a write to the Collection: run as a read is, and told the app is there.
      ? await operation.run({ ...ctx, appOwnsCollection: true }, invocation.args)
      : writes && found
      ? await withWriteAccess(found, writeEnv, operation.name, (write) => operation.run({ ...ctx, workspace: write.workspace, write }, invocation.args))
      : await operation.run(ctx, invocation.args)
    const filed = filing as ReviewFiling | null
    const outcome: Outcome = result.outcome ?? 'done'
    if (invocation.output === 'json') sayJson({ ok: true, outcome, operation: operation.name, ...named(), ...(routed || filed?.via === 'app' ? { via: 'app' } : {}), result: result.data })
    // A document's own text to a pipe or a file is its bytes exactly: no line end is added to it.
    else if (result.verbatim && result.fromDocument && env.stdoutIsTerminal !== true) env.stdout(result.text)
    else if (result.verbatim && !result.fromDocument) env.stdout(`${result.text}\n`)
    else say(env.stdout, writeKind ? renderOutcome(outcome, result) : result.text)
    return (routed && !routed.confirmed) || (filed && !filed.confirmed) ? 3 : 0
  } catch (error) {
    return fail(error)
  }
}
