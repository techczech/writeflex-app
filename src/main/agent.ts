import { AsyncLocalStorage } from 'node:async_hooks'
import { AmbientState, ambientContextItem } from './ambient'
import { resolveWidgetFileForInsert } from './widget-insert'
import { planWidgetCreate } from './widget-create'
import type { WidgetsCreateInput } from './verbs/verb-support'
import { insertWidgetInText, relativeEmbedPath, removeWidgetInText } from '../shared/widget-insert'
import type { PromptComposition } from './threads'
import {
  ABSENT_HASH,
  createBridle,
  scriptedSessionFactory,
  type ApprovalRequest,
  type Bridle,
  type BridleAuth,
  type BridleLane,
  type BridleModelService,
  type BridleSessionFactory,
  type CapabilityResult,
  type JournalEntry,
  type Proposal,
  type ProposalPreview,
  type TraceEvent,
} from '@bridle/core'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { posix } from 'node:path'
import { buildWriteFlexManifest, resolveProseInsert, resolveProseInsertAt, resolveProseMove, setFrontmatterKeys, writeflexApprovalPolicy, type CapabilityServices, type FrontmatterSetInput, type ObjectInsertInput, type ProseEditInput, type ProseInsertInput, type ProseMoveInput } from './capabilities'
import { objectBlock } from '../shared/object-markup'
import { queueThenTurn } from './collection-write-order'
import { minimiseProposedReplacement } from './proposed-replacement'
import { placeRecordedReplacement } from './recorded-placement'
import { closedReasonOf, createsAFile, type AnchorContext, documentPathRefusal, isWholeDocumentChange, newFilePartOf, type Change, type ChangeStore, type ChangeStatus, type ClosedCode } from './changes'
import { editClassForCategory } from '../engine'
import { ChangedSinceRead, DocumentChangedError, NotADocumentPathError, SavedButNotReadBack, documentChangedMessage, isHiddenWorkspacePath, type ChangedSinceReadRefusal, type FileReadResult, type OperationWrite, type Workspace, type WriteReceipt } from './workspace'
import { rollBackOperationWrites } from './operation-rollback'
import { DocumentReadRefused, fingerprintOf, readDocumentBytesGuarded, readDocumentFile, readDocumentGuarded } from './guarded-document-read'
import { GuardedWriteRefused } from './guarded-document-write'
import { RestoreNotCompletedError, restoreFailure } from './restore-failure'
import { documentOnlyView, type DocumentOnlyView } from './document-only-workspace'
import { WritesPausedError, collectionWritesPaused } from './collection-write-gate'
import { gatedSnapshots, type CollectionSnapshots } from './gated-snapshots'
import { outsideMoveAfterOf, outsideSourceOf, readerNoteOf, unplaceableIn, wholeDocumentMismatch, type Unplaceable } from './outside-change'
import { snapshotVersionOfSavedText } from './saved-text-version'
import { addHeadingAcceptRefusal } from './folio-part-proposals'
import { WRITEFLEX_AGENT_AUTHOR } from './versions'
import { recordMainProcessDiagnostic } from './shutdown'
import { agentObjectFromChange, agentObjectFromSuggestion, appendAgentObjectSettlement, listAgentNotes, persistAgentObjectNote, restageAgentObjectNote } from './agent-notes'
import { CollectionDigestCache, digestContextItem, digestReadPaths, type CollectionDigest } from './digest'
import { PLAN_PROPOSE, PlanProposalDesk } from './plan-proposal-desk'
import type { BoardDeskBridle } from './board-material-desk'
import { prepareOffcutPromotion } from './board-material'
import { PlacementError, resolveOutsideInsert, type ScrapPromoteInput, type SourceAttachInput } from './verbs/verb-support'
import { prepareSourceAttach } from './source-attach'
import { scrapsPathFor, type ScrapStore } from './scraps'
import { taskOnLine } from './tasks'
import { readTaskLines } from '../shared/markdown/task-lines'
import type { PlanAcceptEdits, PlanAcceptResult, PlanProposalView, PlanUndoResult } from '../shared/plan-proposal'

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'
export type TurnExecution = {
  turnId: string
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
  completedAt: number
}
export type ChatMessage = {
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
  error?: boolean
  /** The completed turn's actual egress model plus the reasoning level captured at dispatch. */
  execution?: TurnExecution
}
export type ModelChoice = { provider: string; id: string; name: string }
/** Frozen preload/renderer wire shape. Bridle 0.6 Proposals are mapped to this in main only. */
export type Suggestion = { id: string; capabilityName: string; input: unknown; preview?: string; stagedAt: number }
/** One step of the e2e agent double's scripted turn (Task 15): a capability name + its input. */
export type ScriptedStep = { cap: string; input: unknown }
export type ScriptedTurn = Parameters<typeof scriptedSessionFactory>[0][number]
/** `receipt`: an accept that wrote the change's file says what THIS call wrote there (its own write's
 *  receipt, never one looked up afterwards); absent when the accept wrote nothing to it.
 *  `closed`: the Change could not be applied and has been closed with `message` as its recorded reason
 *  (changes.ts `ChangeClosure`); it is no longer pending and nothing was written to its document. */
export type ResolveChangeResult = {
  applied: boolean
  message?: string
  closed?: true
  receipt?: WriteReceipt
  /** An accept refused because a file changed after main read it (ChangedSinceRead): the file and what was
   *  on disk then. The renderer raises the changed-on-disk notice from this, whatever the watcher delivers
   *  (final review round 2, finding 2). */
  changedOnDisk?: ChangedSinceReadRefusal
}
export type VersionSnapshotResult = { versionId: string; snapshotId: string }

export function bridleLaneForEnvironment(environment: Record<string, string | undefined> = process.env): BridleLane {
  return environment.WRITEFLEX_E2E === '1' ? 'mock' : 'live'
}

/**
 * The model world, made TRUE (usability review verdict, skills-recheck-071): `available` is what the user can
 * actually run — Bridle's model service filtered to providers with CONFIGURED auth — and `all`
 * exists solely to NAME a stored selection whose provider has since signed out (the M7 amber row).
 * The picker lists `available` only: no phantoms, ever.
 */
export function registryModels(models: Pick<BridleModelService, 'list'>): { all: ModelChoice[]; available: ModelChoice[] } {
  const { all, available } = models.list()
  const shape = (choices: ModelChoice[]): ModelChoice[] => choices.map(({ provider, id, name }) => ({ provider, id, name }))
  return { all: shape(all), available: shape(available) }
}

function checkE2EScriptedTurn(script: ScriptedTurn): { ok: boolean; reason?: string } {
  if (!script.prompt.trim()) return { ok: false, reason: 'prompt must not be empty' }
  if (script.rounds.length === 0) return { ok: false, reason: 'at least one round is required' }
  const earlyMessage = script.rounds.slice(0, -1).findIndex((round) => round.kind === 'message')
  if (earlyMessage !== -1) return { ok: false, reason: `round ${earlyMessage + 1} ends the turn before the final round` }
  if (script.rounds.at(-1)?.kind !== 'message') return { ok: false, reason: 'the final round must be a message' }
  for (const round of script.rounds) {
    if (round.kind !== 'tool-calls') continue
    if (round.calls.length === 0) return { ok: false, reason: 'a tool-calls round requires at least one call' }
    if (round.calls.some((call) => !call.name.trim())) return { ok: false, reason: 'every call needs a non-empty capability name' }
  }
  return { ok: true }
}

export function buildE2EScriptedTurn(steps: unknown, reply = 'Staged for your review.'): ScriptedTurn {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Invalid e2e TurnScript: at least one capability step is required.')
  }
  if (steps.some((step) => (
    typeof step !== 'object' || step === null
    || typeof (step as Partial<ScriptedStep>).cap !== 'string'
    || !(step as Partial<ScriptedStep>).cap?.trim()
    || !Object.prototype.hasOwnProperty.call(step, 'input')
  ))) {
    throw new Error('Invalid e2e TurnScript: every step needs a non-empty capability name and an input.')
  }
  if (typeof reply !== 'string' || !reply) throw new Error('Invalid e2e TurnScript: the final reply must be non-empty text.')
  const script: ScriptedTurn = {
    prompt: '<e2e scripted turn>',
    rounds: [
      { kind: 'tool-calls', calls: (steps as ScriptedStep[]).map((step) => ({ name: step.cap, arguments: step.input })) },
      { kind: 'message', text: reply },
    ],
  }
  const checked = checkE2EScriptedTurn(script)
  if (!checked.ok) throw new Error(`Invalid e2e TurnScript: ${checked.reason ?? 'unknown validation error'}.`)
  return script
}

export const NO_TURN_TO_UNDO = 'There is no agent turn to undo.'
/** Apply on a discarded change (the redo of a Discard, then Apply): refused, nothing is written, it stays
 *  discarded. Reopening it comes first. */
export const DISCARDED_NOT_APPLIED = 'That suggestion was discarded, so nothing was written. Reopen it to apply it.'
/** Discard of an applied change (the redo of an Accept, then Discard): refused, nothing is written, it stays
 *  accepted. Undo in the editor takes it back. */
export const APPLIED_NOT_DISCARDED = 'That change is already applied, so it was not discarded. Undo in the editor takes it back.'
/** Apply on a change already applied (a second Apply, queued or repeated): refused, nothing is written, it
 *  stays accepted. An accepted record never reaches a write. */
export const ALREADY_APPLIED = 'That change is already applied, so nothing was written.'
/** Any resolution that can write, refused for a record whose path is not a document in a visible folder. */
export const HIDDEN_TARGET_NOT_WRITTEN = 'That change targets a file outside the visible folders of the Workspace, so nothing was written.'

/**
 * The newest restore point an agent turn began. Bridle labels each turn's restore point `turn: …`
 * (harness.ts, at turn start); WriteFlex's host steps label theirs otherwise (a Board step by its
 * act, `running order: …`, `version: …`), and an accepted proposal's point carries its proposalId.
 */
export function latestTurnRestorePoint(entries: JournalEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.kind === 'restore-point' && entry.label.startsWith('turn: ') && !entry.proposalId) return entry.id
  }
  return null
}

/**
 * The canonical run-as-is turn text (usability review verdict, skills-recheck-071: a genuinely EMPTY turn
 * makes a live model ask "what would you like me to do?" instead of acting — the scripted harness
 * ignores prompt text, so only the live gate could catch it). Sent by main when the renderer fires
 * an empty run; stripped from the visible transcript so the thread still reads as "nothing said".
 */
export const RUN_AS_IS_INSTRUCTION = 'Carry out your skill instructions on the open document now. Do not ask what to do — act, then report what you did.'

const FOLDER_RUN_PREFIX = 'Carry out your skill instructions on the folder '
const FOLDER_RUN_SUFFIX = ' now; pass it as `dir` to the plan tools. Do not ask what to do — act, then report what you did.'

/**
 * The run-as-is turn text for a launch (ticket 10). A folder skill (`input: folder`) is launched ON a
 * folder — the Plan pane, the folder menu, the palette — and the folder travels in this hidden text,
 * because the writer situation only describes the open document. No folder: the document text.
 */
export function runAsIsInstruction(folder?: string): string {
  return folder === undefined ? RUN_AS_IS_INSTRUCTION : `${FOLDER_RUN_PREFIX}${JSON.stringify(folder)}${FOLDER_RUN_SUFFIX}`
}

/** Either run-as-is text is an instruction, not the writer's words: the transcript never shows it. */
export function isRunAsIsInstruction(text: string): boolean {
  if (text === RUN_AS_IS_INSTRUCTION) return true
  if (!text.startsWith(FOLDER_RUN_PREFIX) || !text.endsWith(FOLDER_RUN_SUFFIX)) return false
  try {
    return typeof JSON.parse(text.slice(FOLDER_RUN_PREFIX.length, text.length - FOLDER_RUN_SUFFIX.length)) === 'string'
  } catch {
    return false
  }
}

/** Map a sealed Bridle Proposal onto WriteFlex's frozen suggestion wire contract. */
export function proposalToSuggestion(proposal: Proposal, derived?: ProposalPreview): Suggestion {
  const supplement = proposal.supplements?.map((item) => item.markdown).filter(Boolean).join('\n\n')
  const preview = supplement || (derived?.kind === 'text-diff'
    ? `${proposal.title}\n--- current\n${derived.before}\n+++ proposed\n${derived.after}`
    : undefined)
  return {
    id: proposal.id,
    capabilityName: proposal.capability,
    input: proposal.payload,
    ...(preview ? { preview } : {}),
    stagedAt: Date.parse(proposal.createdAt),
  }
}

/**
 * THE one mapping from Pi's persisted message shapes to the UI transcript — used by the live
 * agent's messages() AND by the threads layer's agent-less read-only history, so the two can
 * never drift (review finding B1 round-3 finding: a hand-rolled second parser dropped tool rows).
 */
export function mapSessionMessages(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of raw as Array<Record<string, unknown>>) {
    const createdAt = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const transcriptText = typeof message.text === 'string' ? message.text.trim() : textParts(message.content)
    if (message.role === 'user') {
      // Run-as-is is an instruction, not the writer's words.
      const text = transcriptText
      if (text && !isRunAsIsInstruction(text)) out.push({ role: 'user', content: text, createdAt })
    } else if (message.role === 'assistant') {
      // usability review find (2026-07-03): errored turns persisted as empty-content assistant messages and
      // rendered as a meaningless '[used tools]' placeholder — every Codex request was failing
      // silently. Errors surface as designed error rows; tool-only replies add no prose (their
      // activity renders as act rows), so the placeholder is gone.
      const text = transcriptText
      if (message.stopReason === 'error' || message.isError === true) {
        out.push({ role: 'assistant', content: humanModelError(message.errorMessage), createdAt, error: true })
      } else if (text) {
        out.push({ role: 'assistant', content: text, createdAt })
      }
    } else if (message.role === 'toolResult' || message.role === 'tool') {
      const text = transcriptText
      if (text) out.push({ role: 'tool', content: text.slice(0, 2000), createdAt })
    }
  }
  return out
}

/** Re-attach thread-index execution receipts to Bridle's persisted transcript after a relaunch. */
export function attachTurnExecutions(messages: ChatMessage[], executions: TurnExecution[]): ChatMessage[] {
  if (executions.length === 0) return messages
  const next = messages.map((message) => ({ ...message }))
  const remaining = [...executions].sort((a, b) => a.completedAt - b.completedAt)
  const claimed = new Set<number>()

  // Exact timestamp is the normal path: recordTurn stores the mapped assistant message's timestamp.
  for (let index = 0; index < next.length; index += 1) {
    const message = next[index]
    if (message.role !== 'assistant') continue
    const match = remaining.findIndex((execution) => execution.completedAt === message.createdAt)
    if (match === -1) continue
    message.execution = remaining[match]
    remaining.splice(match, 1)
    claimed.add(index)
  }

  // Legacy/error transcripts may have lost a timestamp. New receipts belong to the newest
  // assistant turns, so pair any leftovers from the end rather than annotating older legacy turns.
  const assistants = next
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role === 'assistant' && !claimed.has(index))
  while (remaining.length > 0 && assistants.length > 0) {
    const execution = remaining.pop()!
    assistants.pop()!.message.execution = execution
  }
  return next
}

export function textParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim()
}

/** Human-readable error copy for a failed model request; the raw provider error is informative
 *  but unbounded, so it is trimmed. Exported for tests. */
export function humanModelError(raw: unknown): string {
  const detail = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 240) : 'no detail from the provider'
  return `The model request failed — ${detail}`
}

function uniqueStoredRange(content: string, oldText: string, path: string): { from: number; to: number } | string {
  if (!oldText) return `oldText must not be empty; ask the agent to redo the edit for ${path}.`
  const first = content.indexOf(oldText)
  if (first === -1) return `oldText was not found in ${path}; ask the agent to redo the edit.`
  // Overlapping occurrences count (review T2): in `aaa`, `aa` stands twice.
  if (content.indexOf(oldText, first + 1) !== -1) {
    return `oldText is not unique in ${path}; ask the agent to redo the edit with more context.`
  }
  return { from: first, to: first + oldText.length }
}

/** What the shortening trimmed off `oldText` at `anchor`, for the record (see `AnchorContext`); nothing when it trimmed nothing. */
function trimmedContext(content: string, anchor: { from: number; to: number }, minimal: { from: number; to: number }): AnchorContext {
  const before = content.slice(anchor.from, minimal.from)
  const after = content.slice(minimal.to, anchor.to)
  return before === '' && after === '' ? {} : { anchorContext: { before, after } }
}

// One placement judgement for Accept and for the sweep after it (recorded-placement.ts); re-exported for tests.
export { placeRecordedReplacement }

/** An Accept whose text could not be placed (gone, or with no one place) decides nothing: the Change stays as it stands (ticket 14). */
/** `next`, unless `change` is WriteFlex's own add-a-heading change and `next` is no longer what the title rule
 *  proposes for the part (folio-part-proposals.ts `addHeadingAcceptRefusal`): then it is closed, nothing written. */
function addHeadingChecked(change: Change, content: string, next: string): string | Unplaceable {
  return addHeadingAcceptRefusal(change, content, next) ?? next
}

const UNPLACED_ON_ACCEPT: ReadonlySet<ClosedCode> = new Set<ClosedCode>(['target-gone', 'target-repeated'])

function joinAfterRecordedRemoval(before: string, after: string): string {
  const trailing = before.match(/\n+$/)?.[0] ?? ''
  const leading = after.match(/^\n+/)?.[0] ?? ''
  if (!trailing || !leading) return `${before}${after}`
  const separator = trailing.length + leading.length >= 2 ? '\n\n' : '\n'
  return `${before.slice(0, before.length - trailing.length)}${separator}${after.slice(leading.length)}`
}

function insertRecordedBlock(content: string, insertAt: number, text: string): string {
  const beforeRaw = content.slice(0, insertAt)
  const afterRaw = content.slice(insertAt)
  const trailing = beforeRaw.match(/\n+$/)?.[0] ?? ''
  const leading = afterRaw.match(/^\n+/)?.[0] ?? ''
  const before = trailing ? beforeRaw.slice(0, -trailing.length) : beforeRaw
  const after = leading ? afterRaw.slice(leading.length) : afterRaw
  return `${before}${before ? '\n\n' : ''}${text}${after ? '\n\n' : ''}${after}`
}

/** Apply a move from its original-buffer coordinates. No text/anchor re-resolution is allowed here:
 *  these coordinates are the reviewed Change record, and therefore the acceptance contract. */
export function applyRecordedMove(content: string, change: Pick<Change, 'path' | 'oldText' | 'moveFrom' | 'moveTo'>): string {
  const from = change.moveFrom
  const to = change.moveTo
  if (!from || !to || to.from !== to.to || from.from < 0 || from.to <= from.from || to.from < 0) {
    throw new Error(`The recorded move for ${change.path} has invalid coordinates; ask the agent to redo it.`)
  }
  // Sound coordinates the document no longer reaches (it has been shortened since): the place is gone.
  if (from.to > content.length || to.from > content.length) {
    throw new PlacementError(`The recorded move in ${change.path} no longer fits the document; ask the agent to redo it.`, 'target-gone')
  }
  if (content.slice(from.from, from.to) !== change.oldText) {
    throw new PlacementError(`The recorded move source in ${change.path} no longer matches the reviewed text; ask the agent to redo it.`, 'target-gone')
  }
  if (to.from > from.from && to.from < from.to) {
    throw new Error(`The recorded move destination in ${change.path} overlaps its source; ask the agent to redo it.`)
  }
  const withoutSource = joinAfterRecordedRemoval(content.slice(0, from.from), content.slice(from.to))
  const destination = to.from <= from.from
    ? to.from
    : withoutSource.length - (content.length - to.from)
  if (destination < 0 || destination > withoutSource.length) {
    throw new Error(`The recorded move destination in ${change.path} is no longer valid; ask the agent to redo it.`)
  }
  const inserted = insertRecordedBlock(withoutSource, destination, change.oldText)
  return content.endsWith('\n') && !inserted.endsWith('\n') ? `${inserted}\n` : inserted
}

/**
 * One accept, from the moment main starts it to the moment the proposal's verb has run. It names THE Change
 * being accepted, so a verb that must check what the writer was shown (widgets.create) checks that Change and
 * no other, and it collects what the verb wants the writer told. Per call (async context), not global: two
 * accepts that interleave each see their own. Outside an accept there is no scope.
 */
type AcceptScope = { changeId: string | null; notices: string[] }
const acceptScope = new AsyncLocalStorage<AcceptScope>()

/** The new file a Change showed when it was ingested, held in main's memory: the journal record can be rewritten
 *  on disk (by any process, or an editor save aimed at it); this cannot. An accept needs both to agree. */
type ShownNewFile = { path: string; sha256: string }

export class WorkspaceAgent {
  private shownAtIngest = new Map<string, ShownNewFile>()

  /** Maps a live staged suggestion to the (promise of the) Change it was ingested as (Task 3), so applying
   *  or discarding the suggestion moves the right record's status. The entry is claimed SYNCHRONOUSLY the
   *  first time a suggestion is seen — before the async `add` resolves — so no two ingest passes double-
   *  claim it and an accept/reject always finds its record (awaiting the in-flight add if need be).
   *  The association is in-memory; if it is unavailable later, the durable Change simply stays pending.
   *  The promise resolves to null if the add fails, so it NEVER rejects (no unhandled-rejection crash). */
  private readonly suggestionToChange = new Map<string, Promise<string | null>>()

  /** Reverse of `suggestionToChange` for the dock's Accept/Reject (Task 4): given a Change id, the live
   *  staged suggestion it came from, so the dock drives the SAME apply/discard pipeline as the margin
   *  callout (disk write + status move) rather than a status-only change. Set once the add resolves. */
  private readonly changeToSuggestion = new Map<string, string>()

  /** Serialises proposal lifecycle handling so Change ingestion always precedes renderer pushes. */
  private proposalEvents: Promise<void> = Promise.resolve()
  private unsubscribeEvents: () => void = () => {}
  private readonly turnErrors = new Map<string, string>()
  private readonly ingestionFailures: ChatMessage[] = []
  private readonly restagedOrigins = new Map<string, string>()
  private readThisTurn: string[] = []
  private activeCollectionDir = ''
  private readonly digestCache = new CollectionDigestCache()
  /** Running-order proposals (ticket 09): their basis while pending, their undo once accepted. */
  private readonly planDesk: PlanProposalDesk
  /** Bridle's snapshot store for this Collection, every write of it asking the Collection write gate
   *  first (gated-snapshots.ts). The only route by which this class and its desks reach the store. */
  private readonly snapshots: CollectionSnapshots

  /** The Workspace staging reads through when it copies a proposal's target into the ledger: a
   *  proposal that names a file which is not a document has none of that file's text recorded. */
  private readonly staging: Workspace

  private constructor(
    readonly workspace: Workspace,
    private readonly bridle: Bridle,
    private readonly onSuggestionsChanged: (suggestions: Suggestion[]) => void,
    /** The live Agent Permissions filter (Task 17): reads the settings store on every decision. */
    private readonly isCapabilityEnabled?: (name: string) => boolean,
    /** The window's Change Ledger store (Task 3): agent prose edits are ingested here as pending Changes. */
    private readonly changes?: ChangeStore,
    /** Push `changes:changed` so the dock re-lists after ingest / accept / reject. */
    private readonly onChangesChanged?: () => void,
    private readonly onAgentNotesChanged?: (path: string) => void,
    private readonly getCollectionRevision: (dir: string) => number = () => 0,
    private readonly observePromptContext?: (content: string) => void,
    private readonly onTurnComplete?: (paths: string[], activeCollectionDir: string) => void,
    /** Thread-index persistence for the completed turn's model/reasoning receipt. */
    private readonly onTurnRecorded?: (execution: TurnExecution) => void | Promise<void>,
    private readonly filesRead: Set<string> = new Set(),
    private readonly ambient = new AmbientState(workspace.root),
    /** The Workspace the capabilities were built over (document-only-workspace.ts), and its log of
     *  refused paths: how an adoption learns that one of its writes was refused. */
    private readonly capabilityView: DocumentOnlyView = documentOnlyView(workspace),
    /** The window's scrap store, when the agent was given one: a decision on a Change takes its queue
     *  before the Collection's write turn (collection-write-order.ts), because a capability it runs may ask for it. */
    private readonly scrapQueue?: Pick<ScrapStore, 'exclusive'>,
  ) {
    this.staging = documentOnlyView(workspace).workspace
    this.snapshots = gatedSnapshots(workspace.root, bridle.snapshots)
    this.planDesk = new PlanProposalDesk(capabilityView.workspace, {
      proposals: bridle.proposals,
      snapshots: this.snapshots,
      sessionId: () => bridle.sessionId,
    })
  }

  private takeRestagedOrigin(changeId: string): string | undefined {
    const path = this.restagedOrigins.get(changeId)
    this.restagedOrigins.delete(changeId)
    return path
  }

  clearRestagedOrigin(changeId: string): void { this.restagedOrigins.delete(changeId) }

  private async recordObjectSettlement(
    object: ReturnType<typeof agentObjectFromSuggestion> | ReturnType<typeof agentObjectFromChange>,
    status: 'discarded' | 'accepted',
    originatingNotePath?: string,
  ): Promise<string | undefined> {
    if (!object) return
    // A note is written beside the document it is about. For a Change or proposal whose path is not
    // a document, that would be a write inside a folder the app keeps for itself: no note at all.
    if (this.pathRefusal(object.sourceDocument)) return
    // The note a restaged Change came from is rewritten below; it too must be a document path.
    if (originatingNotePath && this.pathRefusal(originatingNotePath)) return
    const sourceDir = posix.dirname(object.sourceDocument)
    const collectionDir = this.activeCollectionDir
      && (object.sourceDocument === this.activeCollectionDir || object.sourceDocument.startsWith(`${this.activeCollectionDir}/`))
      ? this.activeCollectionDir
      : sourceDir === '.' ? '' : sourceDir
    const note = originatingNotePath
      ? await appendAgentObjectSettlement(this.workspace, originatingNotePath, status)
      : await persistAgentObjectNote(this.workspace, { ...object, status, collectionDir })
    this.onAgentNotesChanged?.(note.path)
    return note.path
  }

  private async settlementWarning(object: ReturnType<typeof agentObjectFromSuggestion> | ReturnType<typeof agentObjectFromChange>, status: 'discarded' | 'accepted', originatingNotePath?: string): Promise<string | undefined> {
    try { await this.recordObjectSettlement(object, status, originatingNotePath); return undefined }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }

  /**
   * Ingest every newly-staged agent prose edit into the Change Ledger as a pending agent Change (Task 3,
   * ADR-0011). Reconciles against the LIVE suggestion list, so it captures real + scripted turns uniformly
   * and is idempotent — an already-claimed suggestion is skipped. Only `prose.edit` suggestions become
   * Changes (file ops etc. are not document edits). The map entry (the add's promise) is written
   * SYNCHRONOUSLY, before the write resolves: that both stops a concurrent pass from double-ingesting the
   * same suggestion AND lets a mid-turn accept/reject await the pending add instead of missing it. The
   * ChangeStore serialises the writes. `prose.move` is ingested as one move Change with both move
   * endpoints resolved from the current workspace file; if either exact anchor is ambiguous, no malformed
   * record is staged.
   */
  /**
   * A proposal's target, read for copying into the review ledger: judged by the document-only view
   * as before, then read through ONE guarded read (guarded-document-read.ts), so a link put in the
   * document's place after the check cannot make another file's text the `oldText` of a Change.
   */
  private async readForStaging(path: string): Promise<{ content: string }> {
    this.staging.assertDocumentPath(path)
    return readDocumentGuarded(this.workspace, path)
  }

  /** A planner read `path` by name and will put `text` in a Change: it must be what a guarded read returns. */
  private async assertStagedText(path: string, text: string): Promise<void> {
    if ((await this.readForStaging(path)).content !== text) throw new Error(`${path} changed while the proposal was being staged; ask the agent to redo it.`)
  }

  private ingestStagedChanges(suggestions: Suggestion[]): void {
    const changes = this.changes
    if (!changes) return
    for (const s of suggestions) {
      if (this.suggestionToChange.has(s.id)) continue
      let added: Promise<{ id: string } | null> | null = null
      if (s.capabilityName === 'prose.edit') {
        const input = s.input as Partial<ProseEditInput> | null
        if (!input || typeof input.path !== 'string') continue
        if (typeof input.category !== 'string') continue
        added = (async () => {
          const oldText = typeof input.oldText === 'string' ? input.oldText : ''
          const replacement = {
            path: input.path as string,
            provenance: 'agent',
            editClass: editClassForCategory(input.category as string),
            category: input.category as string,
            summary: typeof input.summary === 'string' ? input.summary : '',
            oldText,
            newText: typeof input.newText === 'string' ? input.newText : '',
            isCorrection: false,
            author: WRITEFLEX_AGENT_AUTHOR
          } as const
          // Equality is settled by the store seam without demanding a unique location for a no-op.
          if (replacement.oldText === replacement.newText) return changes.addProposedReplacement(replacement)
          const file = await this.readForStaging(input.path as string)
          const anchor = uniqueStoredRange(file.content, oldText, input.path as string)
          if (typeof anchor === 'string') throw new Error(anchor)
          // The store shortens it to the changed words; the words it trims are kept with it (ticket 14),
          // so an Accept long after this proposal has gone still finds the one place it was made.
          const minimal = minimiseProposedReplacement({ ...replacement, anchor })
          const context = minimal?.anchor ? trimmedContext(file.content, anchor, minimal.anchor) : {}
          return changes.addProposedReplacement({ ...replacement, anchor, ...context })
        })()
      } else if (s.capabilityName === 'prose.move') {
        const input = s.input as Partial<ProseMoveInput> | null
        if (
          !input ||
          typeof input.path !== 'string' ||
          typeof input.text !== 'string' ||
          typeof input.insertAfter !== 'string'
        ) continue
        added = (async () => {
          const file = await this.readForStaging(input.path as string)
          const resolved = resolveProseMove(file.content, input as ProseMoveInput)
          return changes.add({
            path: input.path as string,
            provenance: 'agent',
            editClass: 'move',
            category: 'structure',
            summary: typeof input.summary === 'string' ? input.summary : '',
            oldText: input.text as string,
            newText: input.text as string,
            // `anchor` records the exact destination-anchor range in the original buffer. Bridle's
            // ledger schema reserves insertAfter for insert Changes, so move re-anchoring retains the
            // same information as coordinates without adding a non-schema field to the journal.
            anchor: { from: resolved.moveTo.from - (input.insertAfter as string).length, to: resolved.moveTo.from },
            moveFrom: resolved.moveFrom,
            moveTo: resolved.moveTo,
            isCorrection: false,
            author: WRITEFLEX_AGENT_AUTHOR
          })
        })()
      } else if (s.capabilityName === 'prose.insert') {
        const input = s.input as Partial<ProseInsertInput> | null
        if (
          !input ||
          typeof input.path !== 'string' ||
          typeof input.text !== 'string' ||
          typeof input.insertAfter !== 'string' ||
          typeof input.category !== 'string'
        ) continue
        added = (async () => {
          const file = await this.readForStaging(input.path as string)
          // Validate the anchor resolves against the live file BEFORE staging — an unplaceable insertion
          // must never be recorded, else it becomes a pane-only ghost the writer can't see in the text.
          resolveProseInsert(file.content, input as ProseInsertInput)
          return changes.add({
            path: input.path as string,
            provenance: 'agent',
            editClass: 'insert',
            category: input.category as string,
            summary: typeof input.summary === 'string' ? input.summary : '',
            oldText: '',
            newText: input.text as string,
            insertAfter: input.insertAfter as string,
            isCorrection: false,
            author: WRITEFLEX_AGENT_AUTHOR
          })
        })()
      } else if (s.capabilityName === 'objects.insert') {
        const input = s.input as Partial<ObjectInsertInput> | null
        if (!input || typeof input.path !== 'string' || typeof input.kind !== 'string' || typeof input.content !== 'string') continue
        added = (async () => {
          const file = await this.readForStaging(input.path as string)
          const newText = objectBlock(input.kind as ObjectInsertInput['kind'], input.content as string)
          const insertAfter = typeof input.insertAfter === 'string' ? input.insertAfter : ''
          resolveProseInsert(file.content, { path: input.path as string, insertAfter, text: newText, category: 'other', summary: input.summary ?? 'Insert object' })
          return changes.add({
            path: input.path as string, provenance: 'agent', editClass: 'insert', category: 'other',
            summary: typeof input.summary === 'string' ? input.summary : `Insert ${input.kind} object`, oldText: '', newText,
            insertAfter, isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
          })
        })()
      } else if (s.capabilityName === 'frontmatter.set') {
        const input = s.input as Partial<FrontmatterSetInput> | null
        if (!input || typeof input.path !== 'string' || !input.set || typeof input.set !== 'object') continue
        added = (async () => {
          const file = await this.readForStaging(input.path as string)
          return changes.add({
            path: input.path as string,
            provenance: 'agent',
            editClass: 'content',
            category: 'other',
            summary: typeof input.summary === 'string' ? input.summary : 'Set document metadata',
            oldText: file.content,
            newText: setFrontmatterKeys(file.content, input.set as FrontmatterSetInput['set'], input.path as string),
            isCorrection: false,
            author: WRITEFLEX_AGENT_AUTHOR,
          })
        })()
      } else if (s.capabilityName === 'widgets.insert' || s.capabilityName === 'widgets.remove') {
        // A proposed widget line (interactive-widgets ticket 05): one whole-file Change, like frontmatter.set,
        // whose only difference is the embed line. Accept runs the verb, which writes the same text.
        const input = s.input as { path?: unknown; file?: unknown; position?: unknown; ordinal?: unknown } | null
        if (!input || typeof input.path !== 'string') continue
        added = (async () => {
          const path = input.path as string
          const file = await this.workspace.readFile(path)
          let newText: string
          let summary: string
          if (s.capabilityName === 'widgets.insert') {
            const resolved = await resolveWidgetFileForInsert(this.workspace.root, String(input.file ?? ''))
            if (!resolved.ok) throw new Error(resolved.message)
            newText = insertWidgetInText(file.content, relativeEmbedPath(file.file.path, resolved.relativePath), (input.position ?? 'end') as 'start' | 'end' | number)
            summary = `Add the widget ${resolved.relativePath}`
          } else {
            newText = removeWidgetInText(file.content, Number(input.ordinal))
            summary = `Remove widget ${Number(input.ordinal)}`
          }
          return changes.add({
            path, provenance: 'agent', editClass: 'content', category: 'other', summary,
            oldText: file.content, newText, isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
          })
        })()
      } else if (s.capabilityName === 'widgets.create') {
        // A proposed new widget (ticket 07): the Change is the document edit (its only difference is the embed
        // line) PLUS the new file as an attached part, path and full content, which the Review pane shows. The
        // file is written at accept time, by the verb, and only if its bytes hash to what is recorded here.
        const input = s.input as Partial<WidgetsCreateInput> | null
        if (!input || typeof input.path !== 'string' || typeof input.fileName !== 'string') continue
        added = (async () => {
          const plan = await planWidgetCreate(this.workspace, input as WidgetsCreateInput)
          const change = await changes.addWithNewFile({
            path: plan.documentPath, provenance: 'agent', editClass: 'content', category: 'other',
            summary: `Make the widget “${String(input.title ?? plan.path)}” (new file ${plan.path}) and add it here`,
            oldText: plan.currentDocument, newText: plan.nextDocument, isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
          }, { path: plan.path, content: plan.html, sha256: plan.sha256 })
          // Frozen here, once: the part cannot be changed after ingest in any way an accept would honour.
          this.shownAtIngest.set(change.id, { path: plan.path, sha256: plan.sha256 })
          return change
        })()
      } else if (s.capabilityName === 'tasks.toggle') {
        // A proposed tick (checkbox-lists ticket 04): one Change over the box's brackets, so it reviews
        // like any other agent proposal (dock, inline in the file, the Agent notes pane) and Accept
        // runs the verb, which writes the one character.
        const input = s.input as { path?: unknown; line?: unknown } | null
        if (!input || typeof input.path !== 'string' || typeof input.line !== 'number') continue
        added = (async () => {
          const path = input.path as string
          // One guarded read: the box is found in, and its text taken from, the same bytes.
          const staged = await this.readForStaging(path)
          const item = readTaskLines(staged.content).find((candidate) => candidate.line === input.line)
          if (!item) await taskOnLine(this.staging, path, input.line as number) // throws the verb's own refusal
          if (!item) throw new Error(`Line ${String(input.line)} of ${path} has no checkbox.`)
          const oldText = staged.content.slice(item.from, item.from + 3)
          return changes.add({
            path,
            provenance: 'agent',
            editClass: editClassForCategory('other'),
            category: 'other',
            summary: `${item.checked ? 'Untick' : 'Tick'} “${item.text}”`,
            oldText,
            newText: item.checked ? '[ ]' : '[x]',
            anchor: { from: item.from, to: item.from + 3 },
            isCorrection: false,
            author: WRITEFLEX_AGENT_AUTHOR,
          })
        })()
      } else if (s.capabilityName === 'scraps.promote') {
        // An offcut proposed as an idea (scraps ticket 02): one Change over the tracker note, showing the
        // idea line and its quote, so it reviews in the dock like any agent proposal. Accept runs the
        // verb, which also takes the scrap out of its scraps file.
        const input = s.input as Partial<ScrapPromoteInput> | null
        if (!input || typeof input.dir !== 'string' || typeof input.origin !== 'string' || typeof input.id !== 'string' || typeof input.name !== 'string') continue
        added = (async () => {
          const plan = await prepareOffcutPromotion(this.staging, { dir: input.dir as string, scrapsPath: scrapsPathFor(input.origin as string), scrapId: input.id as string, name: input.name as string })
          if (plan.tracker.before !== null) await this.assertStagedText(plan.tracker.path, plan.tracker.before)
          return changes.add({
            path: plan.tracker.path,
            provenance: 'agent',
            editClass: editClassForCategory('other'),
            category: 'other',
            summary: `Make the idea “${(input.name as string).trim()}” from an offcut of ${input.origin as string}; the scrap leaves ${plan.scraps.path}`,
            oldText: plan.tracker.before ?? '',
            newText: plan.tracker.after ?? '',
            isCorrection: false,
            author: WRITEFLEX_AGENT_AUTHOR,
          })
        })()
      } else if (s.capabilityName === 'sources.attach') {
        // A source proposed for a piece (scraps ticket 03): one Change over the piece, whose only
        // difference is the added sources: line, so it reviews in the dock like frontmatter.set.
        const input = s.input as Partial<SourceAttachInput> | null
        if (!input || typeof input.dir !== 'string' || typeof input.piece !== 'string' || typeof input.source !== 'string') continue
        added = (async () => {
          const plan = await prepareSourceAttach(this.staging, { dir: input.dir as string, piece: input.piece as string, source: input.source as string })
          if (plan.piece.before !== null) await this.assertStagedText(plan.piece.path, plan.piece.before)
          return changes.add({
            path: plan.piece.path,
            provenance: 'agent',
            editClass: 'content',
            category: 'other',
            summary: `Add “${plan.sourceTitle}” to the sources of ${plan.pieceTitle}`,
            oldText: plan.piece.before ?? '',
            newText: plan.piece.after ?? '',
            isCorrection: false,
            author: WRITEFLEX_AGENT_AUTHOR,
          })
        })()
      } else {
        continue
      }
      // Claim synchronously (before the write resolves). A refused ingest remains rejection-safe, but it
      // also becomes a visible failed-suggestion transcript row instead of disappearing into null.
      this.suggestionToChange.set(
        s.id,
        added.then(
          (c) => {
            if (!c) return null
            this.changeToSuggestion.set(c.id, s.id) // reverse link for the dock's Accept/Reject
            this.onChangesChanged?.()
            return c.id
          },
          (error: unknown) => {
            this.ingestionFailures.push({
              role: 'assistant',
              content: `Could not stage suggestion: ${error instanceof Error ? error.message : 'The staged change could not be prepared.'}`,
              createdAt: Date.now(),
              error: true,
            })
            return null
          }
        )
      )
    }
  }

  /**
   * Close a Change that cannot be applied, with the reason a person will read. Its live suggestion, if
   * it still has one, is settled as rejected first so no other review surface can apply it. No Agent
   * note is written: a note's location is derived from the Change's path, which is the very thing
   * that may not be trusted here. A Change already accepted is history and is left as it is.
   */
  private async closeChange(change: Change, reason: string, code: ClosedCode): Promise<ResolveChangeResult> {
    if (!this.changes || change.status === 'accepted') return { applied: false, message: reason }
    const suggestionId = this.changeToSuggestion.get(change.id)
    if (suggestionId !== undefined) {
      this.changeToSuggestion.delete(change.id)
      this.suggestionToChange.delete(suggestionId)
      // Best effort: a proposal that has already settled refuses, and that is the state wanted.
      await this.bridle.proposals.reject(suggestionId, 'user').catch(() => undefined)
      this.onSuggestionsChanged(await this.suggestions())
    }
    this.restagedOrigins.delete(change.id)
    await this.changes.close(change.id, reason, code)
    this.onChangesChanged?.()
    return { applied: false, closed: true, message: reason }
  }

  /**
   * An Accept that could not be carried out (ticket 14). Its text is gone or has no one place: the
   * Accept decides nothing, so the Change stays as it stands (pending or held), is neither accepted
   * nor declined, and nothing is owed to a reader. The writer is told why and may Decline it. Any
   * other reason (the document is missing, unreadable, not a document, an empty record) closes it.
   */
  private notPlaced(change: Change, unplaced: Unplaceable): Promise<ResolveChangeResult> | ResolveChangeResult {
    if (UNPLACED_ON_ACCEPT.has(unplaced.code)) return { applied: false, message: unplaced.reason }
    return this.closeChange(change, unplaced.reason, unplaced.code)
  }

  /** Why accepting a Change at `path` is refused, or null when the path is a document the sidebar
   *  would show. The one rule is `Workspace.classifyPath` (typed path and real location on disk). */
  private pathRefusal(path: string): string | null {
    return documentPathRefusal(this.workspace, path)
  }

  /**
   * An early, friendlier refusal, and nothing more: the Collection-relative files adopting this
   * proposal is EXPECTED to write, read from the proposal itself, so a proposal that plainly names a
   * file outside the documents is refused before it runs and with the Change's own wording.
   *
   * This never permits anything. It knows a few capabilities by name and guesses the rest from a
   * `path` field; for a capability it does not know, a payload it cannot read or a plan that cannot
   * be prepared it answers 'unknown', and what it does name may differ from what the capability
   * then writes. Unknown (and wrong) proceed only because the rule itself stands behind this, at the
   * write: every capability runs over the document-only Workspace (document-only-workspace.ts),
   * which refuses each non-document path as it is read, resolved or written.
   */
  private async adoptionTargets(proposal: Proposal): Promise<string[] | 'unknown'> {
    const input = proposal.payload as Record<string, unknown> | null
    if (!input || typeof input !== 'object') return 'unknown'
    const targets: string[] = []
    if (typeof input.path === 'string') targets.push(input.path)
    if (proposal.capability === 'sources.attach' && typeof input.piece === 'string') targets.push(input.piece)
    if (proposal.capability === 'scraps.promote' && typeof input.origin === 'string') targets.push(scrapsPathFor(input.origin))
    return targets.length > 0 ? targets : 'unknown'
  }

  /**
   * Adopt a proposal, all or nothing with respect to the path rule. If any path the adoption read,
   * resolved or tried to write was refused by the document-only Workspace, whatever it had already
   * written is rewound to the restore point Bridle opened for this adoption, and the refusal is
   * returned. The Collection is then as it was before Accept.
   */
  private async adoptWithinDocuments(id: string): Promise<{ proposal: Proposal; refused?: string }> {
    const seen = this.capabilityView.refusals.length
    let proposal: Proposal
    let thrown: unknown
    // Every write the adoption makes through the Workspace, for a rewind that puts back only those (R7).
    const written: OperationWrite[] = []
    try {
      proposal = await this.workspace.recordingOperationWrites(written, () => this.bridle.proposals.adopt(id))
    } catch (error) {
      thrown = error
      proposal = (await this.bridle.proposals.get(id))!
    }
    const refused = this.capabilityView.refusals[seen]
    if (refused === undefined) {
      if (thrown !== undefined) throw thrown
      return { proposal }
    }
    // What the refusal says happened to the Collection is what did: a rewind that was refused or
    // stopped part-way is reported with what was and was not put back, never as "nothing changed".
    const notRewound = await this.rewindAdoption(id, written)
    return { proposal, refused: notRewound === null ? `${refused} Nothing was changed.` : `${refused} ${notRewound}` }
  }

  /**
   * Put back what a refused adoption wrote before it was refused (R7 in
   * docs/plans/saving-over-an-outside-change/spec-save-only-over-the-version-you-saw.md): only the files
   * it wrote through the Workspace (`written`), each only while it still holds what the adoption left
   * there, through the document-only view, so a path that is no longer a document is never written. A
   * file changed since, or one that cannot be put back, is left as it is and named. Not Bridle's rewind,
   * which puts every snapshot back over whatever is there now and follows a link to do it.
   *
   * `since` is the journal after the adoption's restore point: a file it snapshotted as absent and that the
   * Workspace did not write (a widget file, made by its own exclusive create) is removed as before.
   */
  private rewindAdoption(proposalId: string, written: readonly OperationWrite[]): Promise<string | null> {
    // One turn of the Collection's write turn, from reading the journal to the last file put back: no
    // other writer in this app runs meanwhile.
    return this.workspace.exclusiveAll(async () => {
      const entries = await this.snapshots.entries()
      const point = entries.findLast((entry) => entry.kind === 'restore-point' && entry.proposalId === proposalId)
      return this.rewindAdoptionInTurn(point ? entries.slice(entries.indexOf(point) + 1) : [], written)
    })
  }

  private async rewindAdoptionInTurn(since: JournalEntry[], written: readonly OperationWrite[]): Promise<string | null> {
    const outcome = await rollBackOperationWrites(documentOnlyView(this.workspace).workspace, written)
    const logged = new Set(written.map((write) => write.path))
    const created = new Set<string>()
    for (const entry of since) {
      if (entry.kind === 'snapshot' && entry.hash === ABSENT_HASH) created.add(entry.file)
    }
    for (const file of created) {
      const path = this.workspace.relative(file)
      if (logged.has(path) || this.pathRefusal(path) !== null) continue
      // Made by the adoption outside the Workspace's writes. Judged again in the tick of the delete; never a link's target.
      this.workspace.assertWritable()
      if (this.pathRefusal(path) === null && existsSync(file)) await unlink(file)
    }
    const left = [
      ...outcome.changed.map((path) => `${path} changed on disk after WriteFlex wrote it, so it was left as it is.`),
      ...outcome.failed.map((failure) => `${failure.path} could not be put back (${failure.reason.replace(/[.\s]+$/, '')}), so it was left as it is.`),
    ]
    return left.length ? `What the change had already written could not all be undone. ${left.join(' ')}` : null
  }

  /**
   * The document a Change is about to be placed in, or why it cannot be read for placing. Read
   * through one handle that does not follow a final link (guarded-document-read.ts): the file that
   * was opened is the file judged and read. `fingerprint` is of the bytes read; the save that follows
   * carries it and refuses when the document no longer holds them.
   */
  private async readForPlacement(change: Change): Promise<{ content: string; fingerprint: string } | Unplaceable | { changed: string }> {
    const refusal = this.pathRefusal(change.path)
    if (refusal) return { reason: refusal, code: 'not-a-document' }
    try {
      const { bytes } = await readDocumentBytesGuarded(this.workspace, change.path)
      return { content: bytes.toString('utf8'), fingerprint: fingerprintOf(bytes) }
    } catch (error) {
      const path = change.path
      if (!(error instanceof DocumentReadRefused)) {
        // Any other failure (no permission to read, a disk error): the reviewed text cannot be found,
        // so the Change is closed with what the system said; reopening it tries again.
        const detail = (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error))
        return { reason: `${path} could not be read (${detail}), so this change cannot be applied.`, code: 'unreadable' }
      }
      // The file at the name was replaced between opening it and judging it: the document changed
      // under the accept. Nothing was read or written, and the Change stays as it is.
      if (error.code === 'moved') return { changed: documentChangedMessage(path) }
      if (error.code === 'missing') return { reason: `${path} no longer exists, so this change cannot be applied.`, code: 'file-missing' }
      if (error.code === 'is-a-folder') return { reason: `${path} is now a folder, so this change cannot be applied.`, code: 'not-a-document' }
      if (error.code === 'is-a-link') return { reason: `${path} is now a link, not a document of its own, so this change cannot be applied.`, code: 'not-a-document' }
      if (error.code === 'not-a-file') return { reason: `${path} is no longer an ordinary file, so this change cannot be applied.`, code: 'not-a-document' }
      if (error.code === 'not-a-document') return { reason: this.pathRefusal(path) ?? `${path} is no longer a document of this Collection (a link stands in its path); a change there is never applied.`, code: 'not-a-document' }
      return { reason: `${error.message.replace(/\.$/, '')}, so this change cannot be applied.`, code: 'unreadable' }
    }
  }

  /**
   * Write an accepted Change's result to its document: snapshot, then save. The save is the guarded
   * one (`documentOnly`): the path is judged again on the handle it stages through, because the read
   * and the snapshot above it waited, and it carries `fingerprint`, the fingerprint of the bytes
   * `next` was worked out from, so a document that changed in between is not overwritten. Returns
   * the refusal when the path is no longer a document, or `changed` (the message for the writer)
   * when the document no longer holds those bytes: then nothing was written.
   */
  private async writeAcceptedChange(change: Change, next: string, read: { content: string; fingerprint: string }): Promise<{ file: FileReadResult | undefined } | Unplaceable | { changed: string }> {
    const refusal = this.pathRefusal(change.path)
    if (refusal) return { reason: refusal, code: 'not-a-document' }
    await this.snapshots.snapshotFile(this.workspace.absolute(change.path), {
      sessionId: this.sessionId(),
      capability: 'change.accept',
    })
    try {
      // Only over the text it read (R5): `saveFileOverRead` compares the disk with that text before and in
      // the rename tick, and records a refusal for the call (R6), as well as the fingerprint check.
      return { file: await this.workspace.saveFileOverRead(change.path, next, read.content, { documentOnly: true, expect: { fingerprint: read.fingerprint } }) }
    } catch (error) {
      // Written, and only the read back failed: the accept went through and must be recorded as such.
      if (error instanceof SavedButNotReadBack) return { file: undefined }
      if (error instanceof ChangedSinceRead) return { changed: error.message }
      if (error instanceof DocumentChangedError) return { changed: documentChangedMessage(change.path) }
      if (error instanceof NotADocumentPathError) return { reason: this.pathRefusal(change.path) ?? error.message, code: 'not-a-document' }
      if (error instanceof GuardedWriteRefused) return { reason: `${error.message} This change cannot be applied.`, code: 'not-a-document' }
      throw error
    }
  }

  /**
   * Accept as ONE transaction on the document: read it, work out the new text (`place`), snapshot,
   * save. The whole of it is inside one turn of the Collection's write turn (`Workspace.exclusive`;
   * its callers already hold the turn, from the Change's status read to its new status), so no
   * other writer in this app (the editor's save, another accept, the agent, a request, a restore)
   * writes between the read and the write; and the save is content-checked, so a change made by
   * anything else in that time is refused, not overwritten.
   *
   * `place` returns the new text, or why the Change cannot be placed in what was read (it may throw
   * that as an error, too). The result says which of three things happened: written (`file`, with
   * the text before and after), cannot be placed (`reason` and `code`: the caller closes the
   * Change), or the document changed under it (`changed`: the Change stays pending).
   */
  private applyToDocument(change: Change, place: (content: string) => string | Unplaceable, fallback: string): Promise<{ file: FileReadResult | undefined; before: string; next: string } | Unplaceable | { changed: string }> {
    return this.workspace.exclusive(change.path, async () => {
      const source = await this.readForPlacement(change)
      if (!('content' in source)) return source
      let placed: string | Unplaceable
      try {
        placed = place(source.content)
      } catch (error) {
        placed = { reason: error instanceof Error ? error.message : fallback, code: error instanceof PlacementError ? error.code : 'other' }
      }
      if (typeof placed !== 'string') return placed
      const written = await this.writeAcceptedChange(change, placed, source)
      return 'file' in written ? { file: written.file, before: source.content, next: placed } : written
    })
  }

  /** Move the Change ingested for `suggestionId` to `status` (accept/reject from the panel). Awaits the
   *  ingest's add if it is still in flight — the claim was recorded synchronously at stage time, so a fast
   *  decision never misses. No-op if the suggestion was never ingested (a non-prose capability), the add
   *  failed, or the store is absent. */
  private async markChangeStatus(suggestionId: string, status: ChangeStatus): Promise<void> {
    const pending = this.suggestionToChange.get(suggestionId)
    if (!pending || !this.changes) return
    this.suggestionToChange.delete(suggestionId)
    const changeId = await pending // resolves to null if the ingest add failed (never rejects)
    if (!changeId) return
    this.changeToSuggestion.delete(changeId)
    this.shownAtIngest.delete(changeId)
    await this.changes.setStatus(changeId, status)
    this.onChangesChanged?.()
  }

  /** Apply a live move from the coordinates frozen in its ingested Change. All review surfaces converge
   *  here so Bridle adoption can never re-resolve the move against a later buffer. */
  private acceptRecordedMove(suggestionId: string, change: Change): Promise<CapabilityResult> {
    // One turn from the status read to the new status: the same move accepted twice is placed once.
    return this.workspace.exclusiveAll(async () => {
      const now = await this.changes?.get(change.id)
      if (now?.status === 'accepted') return { text: 'Applied recorded prose.move proposal.' }
      return this.acceptRecordedMoveInTurn(suggestionId, now ?? change)
    })
  }

  private async acceptRecordedMoveInTurn(suggestionId: string, change: Change): Promise<CapabilityResult> {
    const written = await this.applyToDocument(change, (content) => applyRecordedMove(content, change), 'Could not apply the recorded move.')
    // The document changed under the accept: nothing was written and the move is still proposed.
    if ('changed' in written) return { text: written.changed, isError: true }
    if ('reason' in written) {
      // Its source no longer holds the reviewed text, or the document no longer reaches its coordinates:
      // the Accept decides nothing and the move, and its live proposal, wait (ticket 14). A record whose
      // coordinates were never sound is closed, which also settles the live proposal.
      if (UNPLACED_ON_ACCEPT.has(written.code)) return { text: written.reason, isError: true }
      const closed = await this.closeChange(change, written.reason, written.code)
      return { text: written.reason, isError: true, ...(closed.closed ? { details: { closed: true } } : {}) }
    }
    const { file, next } = written
    const source = { content: written.before }
    // A same-file Proposal superseded earlier alternatives upstream, but their WriteFlex Changes
    // remain pending for comparison. Rebase those recorded ranges through the accepted move so their
    // inline destinations stay on the exact anchor rather than drifting into a word.
    for (const pending of await this.changes?.list({ path: change.path, status: 'pending' }) ?? []) {
      if (pending.id === change.id || pending.editClass !== 'move') continue
      if (!pending.anchor) {
        await recordMainProcessDiagnostic('move.rebase-skipped', {
          changeId: change.id,
          pendingChangeId: pending.id,
          path: change.path,
          reason: 'missing-anchor',
        })
        continue
      }
      const anchorText = source.content.slice(pending.anchor.from, pending.anchor.to)
      const anchorRange = uniqueStoredRange(next, anchorText, pending.path)
      const sourceRange = uniqueStoredRange(next, pending.oldText, pending.path)
      if (typeof anchorRange === 'string' || typeof sourceRange === 'string') {
        await recordMainProcessDiagnostic('move.rebase-skipped', {
          changeId: change.id,
          pendingChangeId: pending.id,
          path: change.path,
          reason: typeof anchorRange === 'string' ? anchorRange : sourceRange,
        })
        continue
      }
      await this.changes?.rebaseMove(pending.id, sourceRange, { from: anchorRange.to, to: anchorRange.to }, anchorRange)
    }
    // The host applied the reviewed Change record instead of adopting Bridle's frozen call. Record
    // that distinction durably, and never claim acceptance if another settlement won the race.
    const settlement = await this.bridle.proposals.settleAsHost(suggestionId, {
      status: 'superseded',
      reason: 'superseded-by-host',
    })
    if (settlement.refused) {
      return {
        text: `The recorded move was applied, but its proposal settlement was refused (${settlement.refused}); the Change remains pending.`,
        isError: true,
      }
    }
    await this.markChangeStatus(suggestionId, 'accepted')
    this.onSuggestionsChanged(await this.suggestions())
    return {
      text: 'Applied recorded prose.move proposal.',
      ...(file ? { details: { file } } : {}),
    }
  }

  /** Re-apply a persisted recorded move after editor undo revived it to pending. The Bridle proposal
   *  is already settled, but the Change still carries the exact source/destination coordinates C8.4
   *  froze, so redo can use the same changes:resolve door without re-interpreting the prose. */
  private async acceptPersistedRecordedMove(change: Change): Promise<ResolveChangeResult> {
    // A move from outside is placed by its text again (the passage and its anchor, each occurring
    // once), never by the ranges found when it was added: the document may have changed since.
    const after = outsideMoveAfterOf(change)
    const written = await this.applyToDocument(change, (content) => (after === null
      ? applyRecordedMove(content, change)
      : resolveProseMove(content, { path: change.path, text: change.oldText, insertAfter: after, summary: change.summary }).nextContent), 'Could not apply the recorded move.')
    if ('changed' in written) return { applied: false, message: written.changed }
    if ('reason' in written) return this.notPlaced(change, written)
    await this.changes?.setStatus(change.id, 'accepted')
    this.onChangesChanged?.()
    return { applied: true }
  }

  /**
   * Resolve a Change from the docked Changes surface (Task 4). If the Change still has a live staged
   * suggestion it drives the SAME pipeline as the margin callout — applySuggestion writes the edit to disk
   * and moves the Change to accepted; discardSuggestion rejects it — so the two review surfaces never
   * disagree. Otherwise it either replays a persisted agent edit from the ledger or moves status directly.
   */
  async resolveChange(changeId: string, action: 'accept' | 'reject'): Promise<ResolveChangeResult> {
    // The receipts of the writes this call makes (the verb's through Bridle, or the saveFile calls below),
    // in its own async context: a write by another operation in between is never among them.
    const { value, receipts, refusals } = await this.workspace.withWriteReceipts(() => this.resolveChangeWriting(changeId, action))
    // Refused because a file changed after main read it, by whichever door: said by type, not only in words.
    const refusal = refusals.at(-1)
    if (action === 'accept' && !value.applied && refusal) return { ...value, changedOnDisk: refusal }
    // Only an accept writes a document (a Discard never does), so only an accept returns a receipt.
    if (action !== 'accept' || !value.applied || receipts.length === 0) return value
    const path = (await this.changes?.get(changeId))?.path
    if (path === undefined) return value
    const receipt = this.workspace.receiptFor(receipts, path)
    return receipt ? { ...value, receipt } : value
  }

  private async resolveChangeWriting(changeId: string, action: 'accept' | 'reject'): Promise<ResolveChangeResult> {
    const result = await this.resolveChangeOnce(changeId, action)
    if (action === 'accept' && result.applied) await this.closeOutsideChangesNoLongerPlaceable(changeId)
    return result
  }

  /**
   * After a Change is accepted: every undecided Change from OUTSIDE on the same document that can no
   * longer be placed in the text as it now stands is closed with that reason, in one write. This is
   * what "two edits to one passage: accepting the first closes the second" is. A failure here never
   * undoes the accept; a Change it missed still closes when the writer tries to accept it.
   */
  private async closeOutsideChangesNoLongerPlaceable(acceptedId: string): Promise<void> {
    const changes = this.changes
    if (!changes) return
    try {
      // One turn, from listing the undecided Changes to closing them: none of them is being
      // accepted meanwhile, so a Change is never both placed in the document and closed as unplaceable.
      await this.workspace.exclusiveAll(() => this.closeOutsideChangesInTurn(changes, acceptedId))
    } catch (error) {
      await recordMainProcessDiagnostic('outside-changes.sweep-failed', { changeId: acceptedId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async closeOutsideChangesInTurn(changes: ChangeStore, acceptedId: string): Promise<void> {
    const accepted = await changes.get(acceptedId)
    if (!accepted || accepted.status !== 'accepted') return
    const others = (await changes.list({ path: accepted.path }))
      .filter((change) => change.id !== acceptedId && (change.status === 'pending' || change.status === 'held') && outsideSourceOf(change) !== null)
    if (others.length === 0) return
    const source = await this.readForPlacement(accepted)
    if (!('content' in source)) return
    const closures = others.flatMap((change) => {
      const unplaceable = unplaceableIn(change, source.content)
      return unplaceable === null ? [] : [{ id: change.id, code: 'superseded' as const, reason: `Another change to ${change.path} was accepted first, and this one can no longer be placed. ${unplaceable.reason}` }]
    })
    if ((await changes.closeMany(closures)).length > 0) this.onChangesChanged?.()
  }

  /**
   * One decision on one Change is ONE turn of the Collection's write turn, from the read of the
   * Change's status to the write of its new one. So the status is always read with no other decision,
   * save or restore of this app in flight: a second Accept of the same Change runs after the first
   * has recorded `accepted`, finds it, and writes nothing. The scrap store's queue is taken first
   * (`queueThenTurn`, the one order): accepting may run a capability that asks for it.
   */
  private resolveChangeOnce(changeId: string, action: 'accept' | 'reject'): Promise<ResolveChangeResult> {
    return queueThenTurn(this.scrapQueue, this.workspace, () => this.resolveChangeInTurn(changeId, action))
  }

  /** Accept a live suggestion through the same door as the margin callout, answered as a Change's decision. */
  private async acceptLiveSuggestion(suggestionId: string): Promise<ResolveChangeResult> {
    // accept: the change is marked accepted only if the apply actually landed (Task 3 markChangeStatus).
    const result = await this.applySuggestion(suggestionId)
    const details = result.details as { settlementWarning?: string; acceptNotice?: string; closed?: boolean } | undefined
    // The verb's own words reach the writer: its failure text (an orphan file is named there), or what it
    // had to say about an accept that went through (saved but not read back).
    const said = [details?.acceptNotice, details?.settlementWarning ? `Change accepted, but its Agent note failed: ${details.settlementWarning}` : undefined].filter(Boolean).join(' ')
    const closed = details?.closed === true
    return { applied: !result.isError, ...(result.isError ? { message: result.text } : said ? { message: said } : {}), ...(closed ? { closed: true as const } : {}) }
  }

  private async resolveChangeInTurn(changeId: string, action: 'accept' | 'reject'): Promise<ResolveChangeResult> {
    if (action === 'accept') {
      // Before anything is read, snapshotted or written, and whichever route below would apply it:
      // a Change whose path is not a document the sidebar would show is closed, never accepted.
      const candidate = await this.changes?.get(changeId)
      // Refused at add, and again here: no Change is applied to a path inside a hidden folder, whatever the
      // record says. Such a record can only have been written into the journal by hand; it is refused and
      // left as it stands (next/0.23's rule), where any other path that is not a document is closed below.
      if (candidate && isHiddenWorkspacePath(candidate.path)) {
        return { applied: false, message: 'That change targets a file outside the visible folders of the Workspace, so nothing was written.' }
      }
      const refusal = candidate ? this.pathRefusal(candidate.path) : null
      if (candidate && refusal) return this.closeChange(candidate, refusal, 'not-a-document')
      // Already accepted: its text was placed when it was accepted. A second Accept (a repeated or
      // late click, a retried call) writes nothing and reads nothing; placing it again would put an
      // insertion in twice. Applying it again after an undo is done by reopening it to pending.
      if (candidate?.status === 'accepted') return { applied: true }
      // Closed is final: a second Accept on a closed Change reports the recorded reason. (Reopening
      // it to pending is the writer's deliberate route back, and is judged afresh.)
      const closedReason = candidate ? closedReasonOf(candidate) : null
      if (closedReason) return { applied: false, closed: true, message: closedReason }
      // A rejected Change is accepted only by reopening it first, which is the one route the review
      // pane offers and which judges it afresh as pending. Marking it accepted here would record an
      // acceptance for text that was never placed (an agent's) or was already taken back (a writer's).
      if (candidate?.status === 'rejected') {
        return { applied: false, message: 'This change was rejected. Reopen it before accepting it.' }
      }
    } else {
      // Reject judges the path too: a Change that is not at a document path ends rejected with that
      // reason, its live suggestion settled, and nothing written (no Agent note) on the way.
      const candidate = await this.changes?.get(changeId)
      const refusal = candidate ? this.pathRefusal(candidate.path) : null
      if (candidate && refusal && this.changes) {
        if (candidate.status === 'accepted') {
          await this.changes.setStatus(candidate.id, 'rejected')
          this.restagedOrigins.delete(candidate.id)
          this.onChangesChanged?.()
          return { applied: true, message: refusal }
        }
        await this.closeChange(candidate, refusal, 'not-a-document')
        return { applied: true, closed: true, message: refusal }
      }
    }
    const suggestionId = this.changeToSuggestion.get(changeId)
    const live = suggestionId !== undefined && (await this.suggestions()).some((s) => s.id === suggestionId)
    if (suggestionId !== undefined && live) {
      if (action === 'reject') {
        const { settlementWarning: warning } = await this.discardSuggestion(suggestionId)
        return { applied: true, ...(warning ? { message: `Change rejected, but its Agent note failed: ${warning}` } : {}) }
      }
      const change = await this.changes?.get(changeId)
      if (change?.editClass === 'move' && change.moveFrom && change.moveTo) {
        const result = await this.acceptRecordedMove(suggestionId, change)
        const closed = (result.details as { closed?: boolean } | undefined)?.closed === true
        return { applied: !result.isError, ...(result.isError ? { message: result.text } : {}), ...(closed ? { closed: true as const } : {}) }
      }
      return this.acceptLiveSuggestion(suggestionId)
    }
    if (!this.changes) return { applied: false }
    const change = await this.changes.get(changeId)
    if (!change) return { applied: false }
    const rejectedOrigin = action === 'reject' ? this.takeRestagedOrigin(change.id) : undefined
    if (action === 'accept' && change.provenance === 'agent' && (change.status === 'pending' || change.status === 'held')) {
      if (createsAFile(change)) {
        // A proposal that also creates a file (widgets.create) is carried out only by its verb, through the live
        // proposal. Replaying the ledger record would write the embed line with no file behind it.
        return { applied: false, message: 'This proposal also creates a file and is no longer live, so nothing was written. Ask the agent for the widget again.' }
      }
      if (readerNoteOf(change)?.kind === 'note') {
        // A reader's note (0.24 ticket 07) changes no text: Done settles it and writes nothing.
        await this.changes.setStatus(changeId, 'accepted')
        this.onChangesChanged?.()
        return { applied: true }
      }
      if (change.editClass === 'move') {
        return this.acceptPersistedRecordedMove(change)
      }
      if (change.editClass === 'insert') {
        // An insert stores its anchor as `insertAfter` (empty = append), so unlike a move it CAN replay
        // honestly from the ledger after the live suggestion is gone. One asked for from outside is
        // placed by the same function that judged it when it was added (`resolveOutsideInsert`: with
        // no anchor, at the end of the document); the in-app agent's keeps its own placement.
        const outside = outsideSourceOf(change) !== null
        const written = await this.applyToDocument(change, (content) => addHeadingChecked(change, content, (
          change.anchor && change.anchor.from === change.anchor.to && change.insertAfter === undefined
            ? resolveProseInsertAt(content, change.anchor.from, change.newText).nextContent
            : outside
              ? resolveOutsideInsert(content, { path: change.path, insertAfter: change.insertAfter ?? '', text: change.newText }).nextContent
              : resolveProseInsert(content, {
                  path: change.path,
                  insertAfter: change.insertAfter ?? '',
                  text: change.newText,
                  category: 'other',
                  summary: change.summary,
                }).nextContent
        )), 'Could not place the insertion.')
        if ('changed' in written) return { applied: false, message: written.changed }
        if ('reason' in written) return this.notPlaced(change, written)
        await this.changes.setStatus(changeId, 'accepted')
        const warning = await this.settlementWarning(agentObjectFromChange(change), 'accepted', this.takeRestagedOrigin(change.id))
        this.onChangesChanged?.()
        return { applied: true, ...(warning ? { message: `Change accepted, but its Agent note failed: ${warning}` } : {}) }
      }
      const written = await this.applyToDocument(change, (content) => {
        // A Change over the whole document is applied only to exactly the document it was made over:
        // never as a passage found inside a document that has grown since.
        if (isWholeDocumentChange(change)) return wholeDocumentMismatch(change, content) ?? change.newText
        // Found by the recorded text, the words trimmed off it, or its recorded span (ticket 14).
        const range = placeRecordedReplacement(content, change)
        if ('reason' in range) return range
        return addHeadingChecked(change, content, content.slice(0, range.from) + change.newText + content.slice(range.to))
      }, 'Could not place the change.')
      if ('changed' in written) return { applied: false, message: written.changed }
      if ('reason' in written) return this.notPlaced(change, written)
      await this.changes.setStatus(changeId, 'accepted')
      this.onChangesChanged?.()
      return { applied: true }
    }
    if (action === 'reject' && change.provenance === 'agent' && change.status === 'accepted') {
      // A Discard that reaches main after the change was applied (the redo of an Accept, then Discard): a
      // reject never writes a document, so it is refused and the change stays accepted; Undo in the editor
      // takes the text back.
      return { applied: false, message: APPLIED_NOT_DISCARDED }
    }
    await this.changes.setStatus(changeId, action === 'accept' ? 'accepted' : 'rejected')
    const warning = action === 'reject' && (change.status === 'pending' || change.status === 'held')
      ? await this.settlementWarning(agentObjectFromChange(change), 'discarded', rejectedOrigin)
      : undefined
    this.onChangesChanged?.()
    return { applied: true, ...(warning ? { message: `Change rejected, but its Agent note failed: ${warning}` } : {}) }
  }

  /**
   * Save version must never stamp a run before newly accepted agent edits have landed on disk. Changes
   * already accepted at entry were applied by an earlier Accept path, so this only resolves still-pending ids.
   */
  async applyAcceptedChangesForVersion(changeIds: string[]): Promise<void> {
    for (const changeId of changeIds) {
      const change = await this.changes?.get(changeId)
      if (change?.status === 'accepted') continue
      const result = await this.resolveChange(changeId, 'accept')
      if (!result.applied) throw new Error(result.message ?? `Could not apply accepted change ${changeId}.`)
    }
  }

  static async create(opts: {
    workspace: Workspace
    appDataDir: string
    defaults?: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
    /** Agent Permissions (Task 17): capabilities this returns false for are excluded from the
     *  manifest at bind AND denied by the live policy (mid-session toggles bite immediately). */
    isCapabilityEnabled?: (name: string) => boolean
    /** Shared services the scrap capabilities need (Task 24): the window's ONE ScrapStore + notifier. */
    services?: CapabilityServices
    /** The window's Change Ledger store (Task 3): staged prose edits ingest here as pending Changes. */
    changes?: ChangeStore
    onChangesChanged?: () => void
    /** Durable object history is a visible Collection mutation, so the host refreshes every projection. */
    onAgentNotesChanged?: (path: string) => void
    /** Collection-scoped invalidation revision supplied by the host. */
    getCollectionRevision?: (dir: string) => number
    /** Test-only observation seam for the hidden injected Digest text. */
    observePromptContext?: (content: string) => void
    /** Host invalidation receives the receipt's real writes and the turn's read scope. */
    onTurnComplete?: (paths: string[], activeCollectionDir: string) => void
    /** The thread record owns durable per-turn execution metadata. */
    onTurnRecorded?: (execution: TurnExecution) => void | Promise<void>
    onTrace: (e: TraceEvent) => void
    onApprovalRequest: (req: ApprovalRequest) => void
    onSuggestionsChanged: (suggestions: Suggestion[]) => void
    /** Test-only supported Bridle seam: scripts must be fixed before handle creation. */
    sessionFactory?: BridleSessionFactory
    /** Skill-bound instance (0.7b B1): machine custom-instructions, discoverable skills, and — for a
     *  skill thread — the active skill whose scope becomes the whole tool world (bridle S2–S4). */
    composition?: PromptComposition
    /** Per-thread instances pass their own appDataDir; auth must then be pinned back to the ONE
     *  app-wide credential file rather than the default `<appDataDir>/auth.json` (0.7a contract). */
    auth?: BridleAuth
    modelService?: BridleModelService
  }): Promise<WorkspaceAgent> {
    const filesRead = new Set<string>()
    const { ambient = new AmbientState(opts.workspace.root), ...composition } = opts.composition ?? {}
    const shownChanges = opts.changes
    const shownAtIngest = new Map<string, ShownNewFile>()
    // Every capability, whether run in a turn or adopted from a proposal, is built over this view:
    // the rule on paths is enforced where the capability reads and writes, not predicted beforehand.
    const capabilityView = documentOnlyView(opts.workspace)
    const bridle = await createBridle({
      manifest: buildWriteFlexManifest(capabilityView.workspace, opts.isCapabilityEnabled, {
        ...opts.services,
        // widgets.create asks this at accept time. It answers for the ONE Change this accept is for (acceptScope,
        // set in applySuggestion): the file frozen at that Change's ingest must be the file the verb is about to
        // write, and the Change's journal record must still show that same file. No other Change can vouch.
        ...(shownChanges ? {
          widgetFileShown: async (file: { documentPath: string; path: string; sha256: string }) => {
            const changeId = acceptScope.getStore()?.changeId
            if (!changeId) return false
            const frozen = shownAtIngest.get(changeId)
            if (!frozen || frozen.path !== file.path || frozen.sha256 !== file.sha256) return false
            const change = await shownChanges.get(changeId)
            if (!change || change.provenance !== 'agent' || change.path !== file.documentPath) return false
            if (change.status !== 'pending' && change.status !== 'held') return false
            const part = newFilePartOf(change)
            return part !== undefined && part.path === frozen.path && part.sha256 === frozen.sha256
          },
        } : {}),
        ...(opts.onAgentNotesChanged ? { onAgentNotesChanged: opts.onAgentNotesChanged } : {}),
        ...(composition.activeSkill?.name ? { activeSkillName: composition.activeSkill.name } : {}),
        acceptNotice: (text: string) => { acceptScope.getStore()?.notices.push(text) },
        onFileRead: (path) => {
          filesRead.add(path)
          opts.services?.onFileRead?.(path)
        },
        // The agent's own rename carries undecided Changes from outside with it, as the app's rename does.
        onFileRenamed: async (from, to) => {
          if (await opts.changes?.followRename(from, to)) opts.onChangesChanged?.()
          await opts.services?.onFileRenamed?.(from, to)
        },
      }),
      appDataDir: opts.appDataDir,
      lane: bridleLaneForEnvironment(),
      approvalPolicy: writeflexApprovalPolicy(opts.isCapabilityEnabled, opts.workspace),
      onApprovalRequest: opts.onApprovalRequest,
      onTrace: opts.onTrace,
      provider: opts.defaults?.provider ?? 'openai-codex',
      modelId: opts.defaults?.modelId ?? 'gpt-5.5',
      thinkingLevel: opts.defaults?.thinkingLevel ?? 'medium',
      // Threads (0.7b B1) promise a transcript that survives a relaunch: resume the most recent
      // session under this (per-thread) appDataDir instead of opening a fresh one per boot.
      sessionResume: 'continue-recent',
      ...(opts.sessionFactory ? { session: opts.sessionFactory } : {}),
      ...(opts.composition ? { composition } : {}),
      ...(opts.auth ? { auth: opts.auth } : {}),
      ...(opts.modelService ? { modelService: opts.modelService } : {}),
    })
    const agent = new WorkspaceAgent(
      opts.workspace,
      bridle,
      opts.onSuggestionsChanged,
      opts.isCapabilityEnabled,
      opts.changes,
      opts.onChangesChanged,
      opts.onAgentNotesChanged,
      opts.getCollectionRevision,
      opts.observePromptContext,
      opts.onTurnComplete,
      opts.onTurnRecorded,
      filesRead,
      ambient,
      capabilityView,
      opts.services?.scraps,
    )
    agent.shownAtIngest = shownAtIngest
    agent.unsubscribeEvents = bridle.events.subscribe((event) => {
      if (event.type === 'tool_end' && (event.result === 'ok' || event.result === 'error')) ambient.noteAgentAction()
      if (event.type === 'turn_error') agent.turnErrors.set(event.turnId, event.message)
      if (event.type !== 'proposal_created' && !(event.type === 'proposal_settled' && event.settledBy === 'agent')) return
      // Queue lifecycle work in event order. Each refresh claims ledger Changes synchronously before
      // the renderer sees the corresponding wire item; agent retractions reject the claimed Change first.
      agent.proposalEvents = agent.proposalEvents.then(async () => {
        if (event.type === 'proposal_settled') await agent.noteSuggestionRetracted(event.proposalId)
        // Measure a running-order proposal against the folder the moment it is staged (frame 6).
        if (event.type === 'proposal_created' && event.capability === PLAN_PROPOSE) await agent.planDesk.capture(event.proposalId)
        const suggestions = await agent.suggestions()
        agent.ingestStagedChanges(suggestions)
        if (event.type === 'proposal_created') {
          // Preserve the frozen renderer trace vocabulary while sourcing lifecycle from Bridle events.
          opts.onTrace({
            id: event.id,
            timestamp: event.timestamp,
            type: 'suggestion.staged',
            title: `Staged ${event.capability}`,
            metadata: { suggestionId: event.proposalId, capability: event.capability },
          })
        }
        opts.onSuggestionsChanged(suggestions)
      }).catch((error) => {
        opts.onTrace({
          id: `proposal-event-${event.id}`,
          timestamp: Date.now(),
          type: 'writeflex.proposal_event_error',
          title: 'Could not refresh staged proposals',
          metadata: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    })
    // Warm the whole-workspace Digest without holding the agent back: a 4,000-file folder took
    // seconds here. The build is an ordinary cache entry for the current revision, so a caller that
    // needs the Digest joins it, and a change made meanwhile bumps the revision and builds afresh.
    void agent.collectionDigest('').catch(() => {})
    return agent
  }

  async prompt(text: string, activeFile?: string | null, activeCollectionDir = ''): Promise<{ messages: ChatMessage[]; suggestions: Suggestion[] }> {
    // Capture before awaiting the Digest so every field belongs to the same UI instant.
    const snapshot = this.ambient.get()
    activeCollectionDir = snapshot.activeFile?.collection ?? activeCollectionDir
    this.activeCollectionDir = activeCollectionDir
    const revision = this.getCollectionRevision(activeCollectionDir)
    const digest = this.digestCache.takePrimed(this.workspace, activeCollectionDir, this.readThisTurn)
      ?? this.digestCache.take(this.workspace, activeCollectionDir, revision, this.readThisTurn)
      ?? await this.digestCache.get(this.workspace, activeCollectionDir, revision, this.readThisTurn)
    const context = digestContextItem(digest)
    const ambient = ambientContextItem(snapshot)
    this.observePromptContext?.([ambient.content, context.content].join('\n\n'))
    this.readThisTurn = []
    this.filesRead.clear()
    const result = await this.bridle.prompt(text, {
      context: [ambient, context],
    })
    this.readThisTurn = digestReadPaths(this.workspace.root, [...this.filesRead])
    this.onTurnComplete?.(digestReadPaths(this.workspace.root, result.receipt.filesWritten), activeCollectionDir)
    await this.proposalEvents
    const suggestions = await this.suggestions()
    this.ingestStagedChanges(suggestions) // backstop — the per-proposal hook already claimed each; idempotent
    await Promise.all(this.suggestionToChange.values())
    const messages = this.messages()
    messages.push(...this.ingestionFailures.splice(0))
    if (result.outcome !== 'completed' && !messages.at(-1)?.error) {
      messages.push({
        role: 'assistant',
        content: result.outcome === 'aborted'
          ? 'The model request was stopped.'
          : humanModelError(this.turnErrors.get(result.turnId) ?? result.answerText),
        createdAt: Date.now(),
        error: true,
      })
    }
    const execution: TurnExecution = {
      turnId: result.turnId,
      provider: result.receipt.egress.providerId,
      modelId: result.receipt.egress.modelId,
      thinkingLevel: result.receipt.thinkingLevel,
      completedAt: Date.now(),
    }
    const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
    if (assistant) {
      execution.completedAt = assistant.createdAt
      assistant.execution = execution
    }
    await this.onTurnRecorded?.(execution)
    this.turnErrors.delete(result.turnId)
    return { messages, suggestions }
  }

  /** E2E scripts are already queued on the factory-backed handle before this one-shot path runs. */
  async runScriptedTurn(text: string, _steps: ScriptedStep[], activeFile?: string | null, activeCollectionDir = ''): Promise<{ messages: ChatMessage[]; suggestions: Suggestion[] }> {
    return this.prompt(text, activeFile, activeCollectionDir)
  }

  /** Full session history mapped for the UI; session persistence is what fixes the PoC's per-turn amnesia. */
  messages(): ChatMessage[] {
    return mapSessionMessages(this.bridle.transcript())
  }

  async suggestions(): Promise<Suggestion[]> {
    const proposals = await this.bridle.proposals.list({ status: 'proposed' })
    return Promise.all(proposals.map(async (proposal) => {
      if (proposal.supplements?.length) return proposalToSuggestion(proposal)
      try {
        return proposalToSuggestion(proposal, await this.bridle.proposals.preview(proposal.id))
      } catch {
        return proposalToSuggestion(proposal)
      }
    }))
  }
  pendingApprovals(): ApprovalRequest[] { return this.bridle.approvals.pending() }

  async applySuggestion(id: string): Promise<CapabilityResult> {
    const before = await this.bridle.proposals.get(id)
    if (!before) return { text: `Unknown proposal: ${id}`, isError: true }
    if (before.capability === PLAN_PROPOSE) {
      // One door for a running order, whichever surface accepts it: the desk's one undoable step.
      const result = await this.acceptPlanProposal(id)
      return result.ok
        ? { text: `Running order set · ${result.accepted.count} ${result.accepted.count === 1 ? 'change' : 'changes'}.` }
        : { text: result.message, isError: true }
    }
    // A proposal under review as a Change is accepted in one turn of the Collection's write turn,
    // like the same Change accepted from the dock (resolveChangeOnce): the two doors never both place
    // it. The scrap store's queue first, then the turn (the one order).
    const reviewed = await this.suggestionToChange.get(id)
    if (!reviewed) return this.applySuggestionNow(id, before)
    // Nothing read above is trusted inside the turn: the proposal and its Change are read again there.
    return queueThenTurn(this.scrapQueue, this.workspace, async () => {
      const now = await this.bridle.proposals.get(id)
      if (!now) return { text: `Unknown proposal: ${id}`, isError: true }
      return this.applySuggestionNow(id, now)
    })
  }

  private async applySuggestionNow(id: string, before: Proposal): Promise<CapabilityResult> {
    const changeId = await this.suggestionToChange.get(id)
    const change = changeId ? await this.changes?.get(changeId) : undefined
    if (before.capability === 'widgets.create' && !(changeId && this.shownAtIngest.has(changeId))) {
      // Known by its verb: without the file main froze when this proposal was ingested, it is never carried out.
      return { text: 'This widget proposal has no reviewed file on record in this session, so nothing was written. Ask the agent for the widget again.', isError: true }
    }
    if (change) {
      // The same rule as resolveChange, for the margin callout's door onto the same Change. What is
      // judged must be what is acted on: a recorded move acts on the Change's own path, but adopting a
      // proposal runs its stored call, whose paths are the proposal's, not the Change's. So both are
      // judged: the reviewed path, and every path the adoption would write.
      const acted = change.editClass === 'move' && change.moveFrom && change.moveTo ? [] : await this.adoptionTargets(before)
      const refusal = [change.path, ...(acted === 'unknown' ? [] : acted)].map((path) => this.pathRefusal(path)).find((reason) => reason !== null)
      if (refusal) {
        await this.closeChange(change, refusal, 'not-a-document')
        return { text: refusal, isError: true }
      }
    }
    if (change?.editClass === 'move' && change.moveFrom && change.moveTo) {
      return this.acceptRecordedMove(id, change)
    }
    // No Change record is a legitimate state (a proposal to create a file, say, is not a document
    // edit), and an unknown target is too: neither is judged above, both are judged at the write.
    // This accept is for this Change and no other; the verb's review check and notices are scoped to it.
    const scope: AcceptScope = { changeId: changeId ?? null, notices: [] }
    const { proposal, refused } = await acceptScope.run(scope, () => this.adoptWithinDocuments(id))
    if (refused !== undefined) {
      if (change) await this.closeChange(change, refused, 'not-a-document')
      this.onSuggestionsChanged(await this.suggestions())
      return { text: refused, isError: true, ...(change ? { details: { closed: true } } : {}) }
    }
    const executionError = proposal.outcome?.isError === true
    const applied = proposal.status === 'adopted' && !executionError
    const acceptNotice = scope.notices.length ? scope.notices.join(' ') : undefined
    let settlementWarning: string | undefined
    if (applied) {
      await this.markChangeStatus(id, 'accepted')
      const warning = await this.settlementWarning(agentObjectFromSuggestion(proposalToSuggestion(before)), 'accepted')
      if (warning) settlementWarning = warning
    }
    const suggestions = await this.suggestions()
    this.onSuggestionsChanged(suggestions)
    if (executionError) {
      return {
        text: proposal.outcome?.resultText || `Could not apply ${proposal.capability} proposal.`,
        isError: true,
      }
    }
    if (!applied) {
      return {
        text: proposal.status === 'stale'
          ? 'This proposal became stale because the file changed; nothing was applied.'
          : `Proposal ${id} was ${proposal.status}; nothing was applied.`,
        isError: true,
      }
    }
    // The applied file goes back to the renderer: only ever a document's content.
    const path = (before.payload as { path?: unknown } | null)?.path
    const file = typeof path === 'string' && this.pathRefusal(path) === null
      ? await readDocumentFile(this.workspace, path).catch(() => undefined)
      : undefined
    return {
      // What the verb wanted the writer told about a successful accept replaces the generic line.
      text: acceptNotice ?? `Applied ${proposal.capability} proposal.`,
      ...((file || settlementWarning || acceptNotice) ? { details: { ...(file ? { file } : {}), ...(settlementWarning ? { settlementWarning } : {}), ...(acceptNotice ? { acceptNotice } : {}) } } : {}),
    }
  }

  async discardSuggestion(id: string): Promise<{ suggestions: Suggestion[]; settlementWarning?: string }> {
    const proposal = await this.bridle.proposals.get(id)
    const settlement = await this.bridle.proposals.reject(id, 'user')
    if (settlement.refused) {
      throw new Error(`Could not discard proposal ${id}: settlement was refused (${settlement.refused}).`)
    }
    await this.markChangeStatus(id, 'rejected')
    const settlementWarning = proposal
      ? await this.settlementWarning(agentObjectFromSuggestion(proposalToSuggestion(proposal)), 'discarded')
      : undefined
    const remaining = await this.suggestions()
    this.onSuggestionsChanged(remaining)
    return { suggestions: remaining, ...(settlementWarning ? { settlementWarning } : {}) }
  }

  /** The proposal card's data (ticket 09): basis, changes, staleness, and the accepted summary. */
  async planProposalView(id: string): Promise<PlanProposalView | null> {
    return this.planDesk.view(id)
  }

  /** Accept a running-order proposal (with the writer's Edit-first choices) as one undoable step. */
  async acceptPlanProposal(id: string, edits?: PlanAcceptEdits): Promise<PlanAcceptResult> {
    const result = await this.planDesk.accept(id, edits)
    this.onSuggestionsChanged(await this.suggestions())
    return result
  }

  async discardPlanProposal(id: string): Promise<Suggestion[]> {
    await this.planDesk.discard(id)
    const remaining = await this.suggestions()
    this.onSuggestionsChanged(remaining)
    return remaining
  }

  /** The snapshot journal slice the Board's material steps record their restore points in (host origin). */
  hostSnapshots(): BoardDeskBridle {
    return { snapshots: this.snapshots, sessionId: () => this.bridle.sessionId }
  }

  /** Undo an accepted running order, or refuse with what is in the way (frame 5). */
  undoPlanProposal(id: string): Promise<PlanUndoResult> {
    return this.planDesk.undo(id)
  }

  async collectionDigest(dir: string): Promise<CollectionDigest> {
    return this.digestCache.get(this.workspace, dir, this.getCollectionRevision(dir), this.readThisTurn)
  }

  async primeCollectionDigest(dir: string): Promise<void> {
    const revision = this.getCollectionRevision(dir)
    const delay = process.env.WRITEFLEX_E2E === '1'
      ? Number(process.env.WRITEFLEX_E2E_DIGEST_PRIME_DELAY_MS ?? 0)
      : 0
    if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 1_000)))
    await this.digestCache.prime(this.workspace, dir, revision)
  }

  async agentNotes(dir = '') {
    // `dir` arrives from the renderer, but only files the Markdown walker surfaces are ever read
    // (agent-notes.ts filters `listFiles`), so a hidden folder lists nothing.
    return listAgentNotes(this.workspace, dir)
  }

  async restageAgentNote(notePath: string, input: { sourceDocument: string; insertAfter?: string; anchor?: { from: number; to: number } }): Promise<Change> {
    if (!this.changes) throw new Error('The Change store is unavailable.')
    // Both paths arrive from the renderer; one is read and later rewritten, the other is read and
    // becomes a Change's path. Neither may be anything but a document the sidebar would show.
    for (const path of [notePath, input.sourceDocument]) {
      const refusal = this.pathRefusal(path)
      if (refusal) throw new Error(refusal)
    }
    const change = await restageAgentObjectNote(this.workspace, this.changes, notePath, input)
    this.restagedOrigins.set(change.id, notePath)
    this.onChangesChanged?.()
    return change
  }

  /**
   * The harness's built-in proposals.retract already settled the Proposal when this fires through a
   * `proposal_settled` event; this hook keeps WriteFlex's ledger in step — the ingested
   * Change is rejected — so the retraction shows in both review surfaces at once.
   */
  async noteSuggestionRetracted(suggestionId: string): Promise<void> {
    await this.markChangeStatus(suggestionId, 'rejected')
  }

  resolveApproval(id: string, approved: boolean): boolean {
    return this.bridle.approvals.resolve(id, approved)
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.bridle.models.resolve(provider, modelId)
    const available = registryModels(this.bridle.models).available
      .some((candidate) => candidate.provider === provider && candidate.id === modelId)
    if (!available) throw new Error(`That model is unavailable: ${provider}/${modelId}`)
    await this.bridle.setModel(provider, modelId)
  }

  assertModelListed(provider: string, modelId: string): void { this.bridle.models.resolve(provider, modelId) }

  async setThinking(level: ThinkingLevel): Promise<void> { await this.bridle.setThinkingLevel(level) }
  thinkingLevel(): ThinkingLevel { return this.bridle.thinkingLevel }

  currentModel(): { provider: string; id: string } | null {
    const model = this.bridle.model
    return model ? { provider: model.providerId, id: model.modelId } : null
  }

  availableModels(): ModelChoice[] {
    return registryModels(this.bridle.models).available
  }

  modelCatalogue(): ModelChoice[] { return registryModels(this.bridle.models).all }

  /**
   * Undo turn: restore the newest restore point an agent turn began, and nothing else. Bridle's own
   * restoreLastTurn falls back, before this session's first turn, to the newest restore point of any
   * kind — which may be a host Board step, an accepted running order or a saved version. Refuses,
   * writing nothing, when no agent turn has left a restore point. A restore the store refuses or
   * stops part-way throws `RestoreNotCompletedError`, which says what was and was not put back.
   */
  async restoreLastTurn(): Promise<string[]> {
    // One turn of the Collection's write turn, from finding the restore point to the last file put
    // back: it runs before or after an accept or a save, never during one.
    return this.workspace.exclusiveAll(async () => {
      const point = latestTurnRestorePoint(await this.snapshots.entries())
      if (!point) throw new Error(NO_TURN_TO_UNDO)
      try {
        return await this.snapshots.restoreTo(point, { origin: 'turn' })
      } catch (error) {
        if (error instanceof WritesPausedError) throw error
        // Refused or stopped part-way: the caller is told what was and was not put back, in words.
        throw new RestoreNotCompletedError('The last agent turn was not undone.', restoreFailure(error, this.workspace.root), error)
      }
    })
  }

  /**
   * Tier-2 checkpoint (ADR-0013): snapshot a file's current on-disk state into the same store agent
   * writes use — the git-*commit* of the save model, a returnable restore point. Called at meaningful
   * events (⌘S, close), never on a timer; auto-save (tier 1) writes disk without ever calling this.
   * Content-addressed, so re-checkpointing an unchanged file is a near-noop.
   */
  async checkpointFile(relPath: string): Promise<void> {
    // A snapshot copies the file into the app's history store. Only a document is ever copied there;
    // judged in the tick the snapshot starts. A save of anything else simply has no checkpoint.
    if (this.pathRefusal(relPath)) return
    // Nor is anything copied there while this app does not hold the Collection (the save it follows
    // was refused, and says so).
    if (collectionWritesPaused(this.workspace.root)) return
    await this.snapshots.snapshotFile(this.workspace.absolute(relPath), {
      sessionId: this.sessionId(),
      capability: 'user.checkpoint'
    })
  }

  /**
   * A checkpoint that says what it kept (preserve-version.ts): the snapshot entry's id and hash, or null
   * when none was made (the path is not a document, or the Collection's writes are paused). Unlike
   * checkpointFile, a skipped snapshot is never silent: the caller is preserving a version before it
   * replaces it, and must know.
   */
  async snapshotForPreserve(relPath: string): Promise<{ id: string; hash: string } | null> {
    if (this.pathRefusal(relPath)) return null
    if (collectionWritesPaused(this.workspace.root)) return null
    const entry = await this.snapshots.snapshotFile(this.workspace.absolute(relPath), {
      sessionId: this.sessionId(),
      capability: 'user.checkpoint'
    })
    return entry.kind === 'snapshot' ? { id: entry.id, hash: entry.hash } : null
  }

  readSnapshotContent(entryId: string): Promise<string | null> {
    return this.snapshots.readSnapshotContent(entryId)
  }

  /**
   * Save version (ADR-0014/C6): one restore point plus one file snapshot for the reconciled review run.
   * This is a tier-2 returnable history point today; the returned restore-point id becomes the version
   * handle that later Versions/Compare surfaces can read.
   */
  async snapshotReviewVersion(relPath: string): Promise<VersionSnapshotResult> {
    return snapshotVersionOfSavedText({ workspace: this.workspace, snapshots: this.snapshots, sessionId: this.sessionId(), path: relPath })
  }

  async abort(): Promise<void> {
    const turnId = this.bridle.activeTurn
    if (turnId) this.bridle.abort(turnId)
  }

  async dispose(): Promise<void> {
    this.unsubscribeEvents()
    this.restagedOrigins.clear()
    const proposalStartedAt = Date.now()
    void recordMainProcessDiagnostic('agent.dispose.proposal-events.started', { workspace: this.workspace.root })
    await this.proposalEvents
    void recordMainProcessDiagnostic('agent.dispose.proposal-events.settled', { workspace: this.workspace.root, elapsedMs: Date.now() - proposalStartedAt })
    const bridleStartedAt = Date.now()
    void recordMainProcessDiagnostic('agent.dispose.bridle.started', { workspace: this.workspace.root })
    await this.bridle.dispose()
    void recordMainProcessDiagnostic('agent.dispose.bridle.settled', { workspace: this.workspace.root, elapsedMs: Date.now() - bridleStartedAt })
  }

  digestPinCountForTests(): number { return this.digestCache.pinnedCountForTests() }
  restagedOriginCountForTests(): number { return this.restagedOrigins.size }

  private sessionId(): string {
    return this.bridle.sessionId
  }
}
