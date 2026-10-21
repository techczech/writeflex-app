/**
 * The shown-first operations (specification section 3): everything that changes an EXISTING document.
 * None of them changes a byte of it. Each one checks the request against what is saved on disk now
 * (outside-change.ts, the same validator the app runs again from scratch), then files it: the change
 * appears in WriteFlex's review dock, at once when WriteFlex has the Collection open, otherwise when
 * the Collection is next opened (review-route.ts). The writer accepts or rejects it there.
 *
 * Also here: `waiting`, which lists the requests still in the inbox, and `withdraw`, which takes one
 * back before WriteFlex has read it. WriteFlex claims a request by renaming its file before reading
 * it (request-claims.ts), and `withdraw` takes one back by removing that file: only one of the two
 * can happen to a file, so `withdraw` says "will not be shown" only for a request it removed itself
 * before WriteFlex had it, and for a claimed one says that it is being added and must be rejected
 * in WriteFlex. `writeflex undo` does not cover these: there is nothing to undo
 * until the writer accepts, and after that WriteFlex's own undo for an accepted change applies.
 */
import { isAbsolute, relative } from 'node:path'
import { proposeOutsideChange } from '../outside-change'
import { CliError, type ArgSpec, type Operation, type OperationContext, type OperationResult, type ParsedArgs } from './operation'
import { FolderNotUsableError, holdFolder } from './request-files'
import { INBOX_DIR, MAX_REQUEST_BYTES, claimedFileName, idOfFileName, parseRequest, requestFileName } from './request-format'
import { MAX_ENTRIES_LISTED, ledgerRoom, settledUndelivered, waitingRequests, type ListingCut } from './review-waiting'
import {
  MAX_CHANGES_PER_REQUEST, MAX_REQUESTS_PER_PASS, MAX_REQUEST_BYTES_PER_PASS, MAX_UNDECIDED_OUTSIDE_CHANGES, MAX_UNDECIDED_PER_SOURCE, OUTSIDE_AUTHORS, declaredSource, isShownFirst,
} from './review-format'
import { quoted } from './terminal-text'
import { STDIN_ARG } from './write-support'

const PATH: ArgSpec = { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative Markdown path of the document to change.' }
const SOURCE: ArgSpec = { name: 'source', type: 'string', description: 'Who is asking, shown beside the change: claude-code or codex. Anything else is shown as "Outside agent".' }
const NOTE: ArgSpec = { name: 'note', type: 'string', description: 'One line saying why, shown with the change.' }
const AFTER = (what: string): ArgSpec => ({ name: 'after', type: 'string', description: `Exact text already in the document, occurring once, that ${what} follows.` })

/** Which argument takes the text piped in with `--stdin`. */
const STDIN_TEXT: Record<string, string> = { replace: 'with', insert: 'text', 'insert-object': 'content' }

/** The arguments as the request carries them: piped text folded in, an absolute path made Collection-relative. */
async function requestArgs(ctx: OperationContext, operation: Operation, args: ParsedArgs): Promise<ParsedArgs> {
  const sent: ParsedArgs = {}
  for (const spec of operation.args) if (spec.name !== 'stdin' && args[spec.name] !== undefined) sent[spec.name] = args[spec.name]
  if (args.stdin === true) {
    const name = STDIN_TEXT[operation.name]
    if (sent[name] !== undefined) throw new CliError(`Give --${name} or --stdin, not both.`, 'usage')
    sent[name] = await ctx.stdin()
  }
  for (const name of ['path', 'source-path']) {
    const given = sent[name]
    if (typeof given === 'string' && isAbsolute(given)) sent[name] = relative(ctx.workspace.root, given)
  }
  return sent
}

function shownFirst(entry: Pick<Operation, 'name' | 'group' | 'summary'> & { args: ArgSpec[] }): Operation {
  const operation: Operation = {
    ...entry, behaviour: 'shown-first',
    args: [PATH, ...entry.args, NOTE, SOURCE, ...(STDIN_TEXT[entry.name] ? [STDIN_ARG] : [])],
    run: async (ctx, args) => {
      if (!ctx.fileForReview) throw new CliError(`${entry.name} is shown for review and was run without a way to file it.`, 'failed')
      const sent = await requestArgs(ctx, operation, args)
      // Checked here against the file as saved on disk; the app checks again, from scratch, when it adds it.
      const proposal = await proposeOutsideChange(ctx.workspace, operation.name, sent)
      if (!proposal.ok) throw new CliError(`${proposal.reason} Nothing was filed and nothing was changed.`)
      // The review dock's allowance for undecided changes from outside, read from the ledger as saved:
      // a request that has no room is refused here, before it is filed, with the count.
      const source = declaredSource(sent.source)
      const room = await ledgerRoom(ctx.workspace)
      if (room.undecided + proposal.changes.length > MAX_UNDECIDED_OUTSIDE_CHANGES || (room.bySource[source] ?? 0) + proposal.changes.length > MAX_UNDECIDED_PER_SOURCE) {
        const ofSource = (room.bySource[source] ?? 0) + proposal.changes.length > MAX_UNDECIDED_PER_SOURCE && room.undecided + proposal.changes.length <= MAX_UNDECIDED_OUTSIDE_CHANGES
        throw new CliError(
          (ofSource
            ? `WriteFlex's review dock already holds ${room.bySource[source]} undecided changes from ${OUTSIDE_AUTHORS[source].name}, and takes at most ${MAX_UNDECIDED_PER_SOURCE} from one source. `
            : `WriteFlex's review dock already holds ${room.undecided} undecided changes from outside, and takes at most ${MAX_UNDECIDED_OUTSIDE_CHANGES}. `)
          + 'Nothing was filed and nothing was changed. The writer must clear changes in WriteFlex (accept or reject them) before more can be shown for review.',
          'refused', 'review-allowance-full',
        )
      }
      return ctx.fileForReview(operation, sent, { path: proposal.path, changes: proposal.changes.length })
    },
  }
  return operation
}

const noun = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`

export const REVIEW_OPERATIONS: Operation[] = [
  shownFirst({
    name: 'replace', group: 'Write',
    summary: 'Propose replacing text in a document. Shown in WriteFlex\'s review dock; nothing changes until it is accepted there.',
    args: [
      { name: 'target', type: 'string', required: true, description: 'The exact text to replace. It must occur once in the document.' },
      { name: 'with', type: 'string', description: 'The text to put in its place (empty to delete the target). Or pipe it in with --stdin.' },
    ],
  }),
  shownFirst({
    name: 'insert', group: 'Write',
    summary: 'Propose new text in a document, after a piece of existing text or at the end. Shown for review first.',
    args: [{ name: 'text', type: 'string', description: 'The text to insert. Or pipe it in with --stdin.' }, AFTER('the new text')],
  }),
  shownFirst({
    name: 'move-text', group: 'Write',
    summary: 'Propose moving a passage to another place in the same document. Shown for review first.',
    args: [
      { name: 'text', type: 'string', required: true, description: 'The exact passage to move. It must occur once.' },
      { ...AFTER('the passage'), required: true },
    ],
  }),
  shownFirst({
    name: 'insert-object', group: 'Write',
    summary: 'Propose a table, Mermaid diagram, mind map or SVG in a document. Shown for review first.',
    args: [
      { name: 'kind', type: 'string', required: true, description: 'table, mermaid, markmap or svg.' },
      { name: 'content', type: 'string', description: 'The object\'s inner markup, without fences. Or pipe it in with --stdin.' },
      AFTER('the object'),
    ],
  }),
  shownFirst({
    name: 'set-frontmatter', group: 'Shape the document',
    summary: 'Propose setting one frontmatter key of a document. Shown for review first.',
    args: [
      { name: 'key', type: 'string', required: true, description: 'The frontmatter key.' },
      { name: 'value', type: 'string', required: true, description: 'Its value, one line.' },
    ],
  }),
  shownFirst({
    name: 'normalise-frontmatter', group: 'Shape the document',
    summary: 'Propose tidying a document\'s existing frontmatter block (lists canonicalised, nothing added). Shown for review first.',
    args: [],
  }),
  shownFirst({
    name: 'set-status', group: 'Collect and plan',
    summary: 'Propose a piece\'s status (its Board lane). It rewrites the piece\'s frontmatter, so it is shown for review first.',
    args: [
      { name: 'status', type: 'string', required: true, positional: true, description: 'The status, for example "in progress".' },
      { name: 'collection', type: 'string', description: 'The collection folder whose frontmatter pattern applies. Default: the piece\'s own folder.' },
    ],
  }),
  shownFirst({
    name: 'tick', group: 'Collect and plan',
    summary: 'Propose ticking (or, with --untick, unticking) a checkbox item. Shown for review first.',
    args: [
      { name: 'line', type: 'integer', required: true, positional: true, description: 'The item\'s line, as "writeflex tasks" gives it.' },
      { name: 'untick', type: 'boolean', description: 'Untick a ticked box instead.' },
    ],
  }),
  shownFirst({
    name: 'attach-source', group: 'Collect and plan',
    summary: 'Propose adding a research note to a piece\'s sources. Shown for review first.',
    args: [
      { name: 'source-path', type: 'string', required: true, positional: true, description: 'Collection-relative path of the research note.' },
      { name: 'collection', type: 'string', description: 'The collection folder the piece and the note belong to. Default: the whole Collection.' },
    ],
  }),
  shownFirst({
    name: 'restore-version', group: 'Review and versions',
    summary: 'Propose restoring a saved version of a document, as one change to the whole document. Shown for review first.',
    args: [{ name: 'version', type: 'string', required: true, positional: true, description: 'The version\'s id, from "writeflex versions".' }],
  }),
  {
    name: 'waiting', group: 'Review and versions', behaviour: 'direct',
    summary: 'List the request files for proposed changes still in the inbox (as the files state), and answers WriteFlex could not deliver.',
    args: [],
    run: async (ctx): Promise<OperationResult> => {
      const { requests, unreadable, cut } = await waitingRequests(ctx.workspace.root)
      if (!ctx.records) throw new CliError('The undelivered answers were not located for this run.', 'failed')
      const answers = await settledUndelivered(ctx.workspace.root, ctx.records, ctx.replyKeyFolders ?? [])
      const room = await ledgerRoom(ctx.workspace)
      const limits = { entriesListed: MAX_ENTRIES_LISTED, requestsPerPass: MAX_REQUESTS_PER_PASS, bytesPerPass: MAX_REQUEST_BYTES_PER_PASS, undecidedInLedger: MAX_UNDECIDED_OUTSIDE_CHANGES, undecidedPerSource: MAX_UNDECIDED_PER_SOURCE, changesPerRequest: MAX_CHANGES_PER_REQUEST }
      const cutNote = (what: string, by: ListingCut): string[] => (by === null ? [] : [`The list of ${what} was cut short: the folder holds more than the command line reads at once (limit on ${by}). What is shown is not all of it${by === 'entries' ? ', and not necessarily the oldest' : ''}.`])
      const lines = requests.map((request) => `${request.id}  ${(request.at ?? '').slice(0, 16).replace('T', ' ')}  ${request.operation}  ${quoted(request.path)}  (says it is from ${request.source})${request.beingAdded ? '  [being added to the review dock now: it can no longer be withdrawn; reject it in WriteFlex]' : ''}`)
      const answered = answers.settled.map((one) => (one.verified
        ? `${one.id}  WriteFlex answered and the answer could not be delivered: ${one.outcome === 'filed' ? 'filed for review' : `refused: ${one.reason ?? 'no reason given'}`}`
        : `${one.id}  outcome unknown; check in WriteFlex (an answer is on record for it, but it could not be verified as written by WriteFlex, so none of it is shown)`))
      const notes = [
        ...cutNote('waiting requests', cut),
        ...answered,
        ...cutNote('undelivered answers', answers.cut),
        ...(room.undecided > 0 ? [`WriteFlex's review dock holds ${noun(room.undecided, 'undecided change')} from outside (at most ${MAX_UNDECIDED_OUTSIDE_CHANGES}, and ${MAX_UNDECIDED_PER_SOURCE} from one source).`] : []),
        ...(unreadable ? [`${noun(unreadable, 'file')} in the inbox ${unreadable === 1 ? 'is' : 'are'} not readable as a request; WriteFlex will refuse ${unreadable === 1 ? 'it' : 'them'}.`] : []),
      ]
      return {
        data: {
          waiting: requests, waitingAre: 'request files found in the inbox, as each file states; not checked or confirmed by WriteFlex',
          settled: answers.settled, undecidedInDock: room, unreadable, cut: { waiting: cut, settled: answers.cut }, limits,
        },
        text: [
          requests.length
            ? `Request files in the inbox, not yet added by WriteFlex (what each file states; WriteFlex has not checked them):\n${lines.join('\n')}`
            : 'No request file is waiting in the inbox.',
          ...notes,
        ].join('\n'),
      }
    },
  },
  {
    name: 'withdraw', group: 'Review and versions', behaviour: 'direct',
    summary: 'Take back a proposed change that is still waiting (by its request id), before WriteFlex reads it to add it to the review dock.',
    args: [{ name: 'id', type: 'string', required: true, positional: true, description: 'The request id, as the filing command and "writeflex waiting" give it.' }],
    run: async (ctx, args): Promise<OperationResult> => {
      const id = String(args.id).trim()
      if (idOfFileName(requestFileName(id)) === null) throw new CliError(`${quoted(id, 60)} is not a request id ("writeflex waiting" lists them).`, 'usage')
      const { buildOperationTable } = await import('./table')
      const added = async (): Promise<boolean> => {
        const { checkedStoresForReading } = await import('./history-store')
        const { outsideRequestOf } = await import('../outside-change-fields')
        return (await checkedStoresForReading(ctx.workspace).changes.list()).some((change) => outsideRequestOf(change)?.id === id)
      }
      const gone = async (): Promise<never> => {
        throw new CliError(await added()
          ? `Request ${id} is no longer waiting: WriteFlex has added it to the review dock. Reject it there.`
          : `No request ${id} is waiting. Nothing was withdrawn.`)
      }
      let inbox
      try { inbox = await holdFolder(ctx.workspace.root, INBOX_DIR, false) } catch (error) {
        if (error instanceof FolderNotUsableError) throw new CliError(`The inbox cannot be used: ${error.message}`)
        throw error
      }
      if (!inbox) return gone()
      // WriteFlex has claimed it (request-claims.ts): it is reading it or adding it, and it is not ours to take back.
      const beingAdded = (): CliError => new CliError(
        `Request ${id} is being added to WriteFlex's review dock now, so it was not withdrawn. Reject it in WriteFlex. `
        + `(If it does not appear there, WriteFlex left it for later: run "writeflex withdraw ${id}" again.)`,
      )
      try {
        const file = await inbox.read(requestFileName(id), MAX_REQUEST_BYTES)
        if (file.kind === 'missing') {
          if (await inbox.look(claimedFileName(id))) throw beingAdded()
          return await gone()
        }
        // A copy WriteFlex claimed earlier (it stopped, and the request arrived again) is still its to add.
        if (await inbox.look(claimedFileName(id))) throw beingAdded()
        const parsed = file.kind === 'text' ? parseRequest(file.text, id, buildOperationTable()) : null
        if (!parsed?.ok || !isShownFirst(parsed.request.operation)) {
          throw new CliError(`Request ${id} is not a proposed change waiting for review, so it was left as it is.`)
        }
        // Only one of this removal and WriteFlex's claim (a rename of the same name) can happen. "Will
        // not be shown" is said only when the removal was this command's own.
        if (!(await inbox.remove(requestFileName(id)))) {
          if (await inbox.look(requestFileName(id))) throw new CliError(`Request ${id} could not be removed from the inbox.`, 'failed')
          if (await inbox.look(claimedFileName(id))) throw beingAdded()
          return await gone()
        }
        // A copy WriteFlex claimed earlier (it stopped, and the request arrived again) is still its to add.
        if (await inbox.look(claimedFileName(id))) throw beingAdded()
        // WriteFlex may have read it in the instant before it was removed.
        if (await added()) throw new CliError(`Request ${id} was added to WriteFlex's review dock just before it could be withdrawn. Reject it there.`)
        return {
          data: { withdrawn: true, request: id, operation: parsed.request.operation, path: String(parsed.request.args.path ?? '') },
          text: `Withdrawn: request ${id} (${parsed.request.operation} on ${quoted(String(parsed.request.args.path ?? ''))}) will not be shown for review.`,
        }
      } finally {
        await inbox.close()
      }
    },
  },
]
