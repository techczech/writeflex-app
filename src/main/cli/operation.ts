/**
 * The command line's operation table: one entry per operation, with a name, a task group, a typed
 * argument schema, a behaviour class and a run function. Later tickets add write operations to the
 * same table; nothing here depends on Electron.
 */
import type { RecordsPlace } from '../collection-records'
import type { Workspace } from '../workspace'
import type { WriteAccess } from './write-access'
import { ERROR_OUTCOME, type ErrorCode, type Outcome } from './outcome'

/** `direct` runs at once; `shown-first` files a pending change for review; `asks` needs `--confirm`. */
export type Behaviour = 'direct' | 'shown-first' | 'asks'

export type ArgType = 'string' | 'integer' | 'boolean'

export type ArgSpec = {
  name: string
  type: ArgType
  description: string
  required?: boolean
  /** Filled from bare words after the operation name, in schema order. */
  positional?: boolean
}

export type OutputMode = 'text' | 'json'

export type OperationContext = {
  workspace: Workspace
  output: OutputMode
  /** Hands a URL to the operating system (`open`); injected so tests never launch anything. */
  openUrl: (url: string) => Promise<void>
  /** The folder the command was run in; a path OUTSIDE the Collection (an export target) is read against it. */
  cwd: string
  /** Everything piped to the command, for operations that take a document's text with `--stdin`. */
  stdin: () => Promise<string>
  /** Present only while an operation that `writes` runs: the owner lock is held and this is the one
   *  route by which the Collection may be changed (write-access.ts). */
  write?: WriteAccess
  /** Present for a `shown-first` operation: files the request for review (review-route.ts) and
   *  reports where it went. The operation has validated it first, from what is saved on disk. */
  fileForReview?: (operation: Operation, args: ParsedArgs, proposed: { path: string; changes: number }) => Promise<OperationResult>
  /** The folders that may hold this Collection's reply key (reply-key.ts), for an operation that
   *  shows something the app wrote and must first verify that the app wrote it (`waiting`). */
  replyKeyFolders?: string[]
  /** Where the records kept outside the Collection are (collection-records.ts), for an operation
   *  that only reads them (`undo --list`, `waiting`). */
  records?: RecordsPlace
  /** True when the app has this Collection open and the operation runs here all the same, with no
   *  owner lock and no write access, because it changes nothing in the Collection (export). */
  appOwnsCollection?: boolean
}

/** `data` is the typed result (printed under `--json`); `text` is the plain rendering. `verbatim`
 *  marks text printed as it is: the command line's own words (`help`), or, with `fromDocument`, a
 *  document's own content (`read`), which is printed as it is only when standard output is not a
 *  terminal, so that it can be piped; to a terminal it is shown like all other text, its hidden
 *  characters made visible (terminal-text.ts). */
export type OperationResult = { data: unknown; text: string; verbatim?: boolean; fromDocument?: boolean; /** Default `done`. */ outcome?: Outcome }

export type ParsedArgs = Record<string, string | number | boolean | undefined>

export type Operation = {
  name: string
  /** One of the ten approved task-group names (groups.ts). */
  group: string
  summary: string
  /** What the operation covers and does not, for `describe` (the summary is one line). */
  details?: string
  args: ArgSpec[]
  behaviour: Behaviour
  /** Whether this invocation changes anything on disk. When it does, the run takes the Collection's
   *  owner lock for its length and insists on a root the user chose (write-access.ts). */
  writes?: boolean | ((args: ParsedArgs) => boolean)
  run: (ctx: OperationContext, args: ParsedArgs) => Promise<OperationResult>
}

/**
 * A refusal the person can act on. `code` is the coarse class (`usage` exits 2, the rest 1) and is what
 * the app's reply carries. `detail` is a more specific code from outcome.ts; `errorCode` is the one
 * `--json` shows. `sent` says, for a not-verified error, whether a request was sent.
 */
export class CliError extends Error {
  constructor(message: string, readonly code: 'usage' | 'refused' | 'failed' = 'refused', readonly detail?: ErrorCode, readonly sent?: boolean) {
    super(message)
    this.name = 'CliError'
  }

  get errorCode(): ErrorCode {
    return this.detail ?? this.code
  }

  get outcome(): Outcome {
    return ERROR_OUTCOME[this.errorCode]
  }
}
