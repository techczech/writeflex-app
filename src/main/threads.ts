import { DEFAULT_OPENAI_CODEX_MODEL } from '@bridle/core'
import type { AmbientState } from './ambient'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { loadMachineInstructions, readLatestSessionTranscript, type PromptComposition as BridlePromptComposition, type Skill } from '@bridle/core'
import {
  attachTurnExecutions,
  mapSessionMessages,
  type ChatMessage,
  type ThinkingLevel,
  type TurnExecution,
  type WorkspaceAgent,
} from './agent'
import type { ModelDefaults } from './settings'
import { parseSkillProposeEditInput, type SkillsRegistry } from './skills'
import { recordMainProcessDiagnostic } from './shutdown'
import { skillDisplayName } from '../shared/skill-display'
import { chooseRunnableModel, modelChoiceNotice, modelReplacedNotice, type ModelRef, type ModelResolution } from '../shared/model-fallback'

/**
 * The threads layer (0.7b B1, ADR-0027): a thread is the unit of agent conversation — a general
 * `chat` thread (full manifest, skills disclosed as descriptions) or a `skill` thread (a skill-bound
 * Bridle instance whose scope is the whole tool world for the thread's life). One instance per
 * thread; thread identity is a per-thread appDataDir, so Pi's SessionManager resumes each thread's
 * own transcript on re-instantiation. Run-as-is is the degenerate case: the same instance fired once
 * with empty user text — "a thread with nothing said".
 */

/** Host-owned live ambient state; only Bridle's static fields cross the harness boundary. */
export type PromptComposition = BridlePromptComposition & { ambient?: AmbientState }

export type ThreadKind = 'chat' | 'skill'

export type ThreadRecord = {
  id: string
  workspaceRoot: string
  kind: ThreadKind
  skillName?: string
  /** Switcher/palette Recent label: first user text one-lined, or the run-as-is document's name. */
  title: string
  createdAt: number
  lastActiveAt: number
  /** Copied from Settings when the thread is created, then owned by this thread. */
  model?: { provider: string; id: string }
  thinkingLevel?: ThinkingLevel
  /** Completed-turn evidence; the transcript remains in Bridle's per-thread session directory. */
  turns?: TurnExecution[]
}

export type ThreadIndexResult = { records: ThreadRecord[]; error: string | null }

const THINKING_LEVELS = new Set<ThinkingLevel>(['minimal', 'low', 'medium', 'high'])
const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.has(value as ThinkingLevel)
const isModel = (value: unknown): value is { provider: string; id: string } => {
  const model = value as { provider?: unknown; id?: unknown } | null
  return typeof model === 'object' && model !== null
    && typeof model.provider === 'string' && typeof model.id === 'string'
}
const isTurnExecution = (value: unknown): value is TurnExecution => {
  const turn = value as Partial<TurnExecution> | null
  return typeof turn === 'object' && turn !== null
    && typeof turn.turnId === 'string' && typeof turn.provider === 'string'
    && typeof turn.modelId === 'string' && isThinkingLevel(turn.thinkingLevel)
    && typeof turn.completedAt === 'number'
}

const isRecord = (value: unknown): value is ThreadRecord => {
  const record = value as Partial<ThreadRecord> | null
  return typeof record === 'object' && record !== null
    && typeof record.id === 'string' && typeof record.workspaceRoot === 'string'
    && (record.kind === 'chat' || record.kind === 'skill')
    && typeof record.title === 'string'
    && typeof record.createdAt === 'number' && typeof record.lastActiveAt === 'number'
    && (record.model === undefined || isModel(record.model))
    && (record.thinkingLevel === undefined || isThinkingLevel(record.thinkingLevel))
    && (record.turns === undefined || (Array.isArray(record.turns) && record.turns.every(isTurnExecution)))
}

/**
 * The persisted thread metadata for every workspace, one JSON file under `<userData>/threads/`.
 * Corruption is survivable by design: a broken file starts an empty index and surfaces the error —
 * the transcripts themselves live in the per-thread session dirs and are never at risk from here.
 */
export class ThreadIndex {
  private records: ThreadRecord[] = []
  private loadError: string | null = null
  /** review finding B1 review P1: the first load must be awaited by EVERY early caller, not raced past — a
   *  boolean flag let a concurrent reader see the pre-load empty array (50/50 in the probe). */
  private loading: Promise<void> | null = null
  /** All mutations chain through one tail so two windows' interleaved saves can't write snapshots
   *  out of operation order (same-process serialisation; the index is per-app, one process). */
  private op: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  private load(): Promise<void> {
    return (this.loading ??= (async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (!Array.isArray(parsed)) throw new Error('thread index is not a list')
        this.records = parsed.filter(isRecord)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        this.loadError = `Could not read the thread index: ${error instanceof Error ? error.message : String(error)}`
      }
    })())
  }

  private async save(): Promise<void> {
    // Atomic sibling-temp + rename: an interrupted save can never truncate the index.
    await mkdir(dirname(this.file), { recursive: true })
    const temp = join(dirname(this.file), `.${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(this.records, null, 2), 'utf8')
    await rename(temp, this.file)
  }

  /** Serialise a mutation behind the load and every prior mutation. */
  private mutate(action: () => void): Promise<void> {
    const next = this.op.then(async () => {
      await this.load()
      action()
      await this.save()
    })
    // The chain must survive a failed save (disk full): later mutations still run.
    this.op = next.catch(() => {})
    return next
  }

  async list(workspaceRoot: string): Promise<ThreadIndexResult> {
    await this.load()
    await this.op.catch(() => {}) // reads see every settled mutation
    const records = this.records
      .filter((record) => record.workspaceRoot === workspaceRoot)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    return { records, error: this.loadError }
  }

  add(record: ThreadRecord): Promise<void> {
    return this.mutate(() => { this.records.push(record) })
  }

  async get(id: string): Promise<ThreadRecord | null> {
    await this.load()
    await this.op.catch(() => {})
    return this.records.find((record) => record.id === id) ?? null
  }

  touch(id: string, patch?: Partial<Pick<ThreadRecord, 'title'>>): Promise<void> {
    return this.mutate(() => {
      const record = this.records.find((candidate) => candidate.id === id)
      if (!record) return
      record.lastActiveAt = Date.now()
      if (patch?.title !== undefined) record.title = patch.title
    })
  }

  setPreferences(id: string, preferences: { model: { provider: string; id: string }; thinkingLevel: ThinkingLevel }): Promise<void> {
    return this.mutate(() => {
      const record = this.records.find((candidate) => candidate.id === id)
      if (!record) return
      record.model = { ...preferences.model }
      record.thinkingLevel = preferences.thinkingLevel
    })
  }

  setModel(id: string, model: { provider: string; id: string }): Promise<void> {
    return this.mutate(() => {
      const record = this.records.find((candidate) => candidate.id === id)
      if (record) record.model = { ...model }
    })
  }

  setThinking(id: string, thinkingLevel: ThinkingLevel): Promise<void> {
    return this.mutate(() => {
      const record = this.records.find((candidate) => candidate.id === id)
      if (record) record.thinkingLevel = thinkingLevel
    })
  }

  appendTurn(id: string, execution: TurnExecution): Promise<void> {
    return this.mutate(() => {
      const record = this.records.find((candidate) => candidate.id === id)
      if (!record) return
      const turns = record.turns ?? []
      if (!turns.some((turn) => turn.turnId === execution.turnId)) turns.push({ ...execution })
      record.turns = turns
    })
  }

  remove(id: string): Promise<void> {
    return this.mutate(() => { this.records = this.records.filter((record) => record.id !== id) })
  }
}

/** What the switcher/banner needs to draw a thread without touching the instance. */
export type ThreadMeta = {
  id: string
  kind: ThreadKind
  skillName?: string
  title: string
  lastActiveAt: number
}

export type RunCompletePayload = {
  threadId: string
  skillName: string
  /** The agent's closing reply — the toast's fact line comes from here (B4). */
  reply: string | null
  suggestionsStaged: number
  outcome: 'completed' | 'error'
}

type ManagedAgentInstance = {
  ready: Promise<WorkspaceAgent>
  agent: WorkspaceAgent | null
  /** Exactly-once disposal ownership (review finding B1 review P1: disposeAll + the boot-settling callback
   *  both disposed the same agent). Whoever flips this first owns the dispose. */
  disposed: boolean
}

type ThreadInstance = ManagedAgentInstance & { record: ThreadRecord }

export type ThreadManagerOptions = {
  ambient?: AmbientState
  userDataDir: string
  workspaceRoot: string
  index: ThreadIndex
  skills: SkillsRegistry
  /** Boot one WorkspaceAgent for a thread — ipc.ts closes over everything else (stores, callbacks,
   *  settings) so this module stays electron-free and unit-testable. `threadId` lets ipc.ts tag or
   *  gate the per-agent event channels by thread (active-thread filtering). */
  createAgent: (opts: {
    threadId: string
    appDataDir: string
    defaults: { provider: string; modelId: string; thinkingLevel: ThinkingLevel }
    composition?: PromptComposition
  }) => Promise<WorkspaceAgent>
  /** Read live Settings defaults only when creating or upgrading a thread. */
  defaults?: () => ModelDefaults
  /** Testable availability boundary; production falls back to the active agent's registry view. */
  isModelAvailable?: (provider: string, modelId: string) => boolean
  /** Bridle's model list (`listed`) and its signed-in subset (`available`), in list order. When a
   *  thread's or the default model is not listed, the chat falls back through chooseListedModel
   *  instead of failing to start (fix 04 follow-up). Absent: every model counts as listed. */
  modelService?: Pick<import('@bridle/core').BridleModelService, 'recommendedModel' | 'resolveSavedModel'>
  listedModels?: () => { listed: ModelRef[]; available: ModelRef[] }
  /** Settles when the model list is ready (initial discovery). Preferences are resolved and persisted
   *  only after it, so a chat never starts on a model the first discovery just removed. */
  modelsReady?: () => Promise<unknown>
  /** E2E/test seam for a scripted provider that cannot adopt registry models. */
  applyModel?: (agent: WorkspaceAgent, provider: string, modelId: string) => Promise<void>
  /** Read-back seam paired with applyModel; production reads WorkspaceAgent.currentModel directly. */
  currentModelAfterApply?: (agent: WorkspaceAgent, provider: string, modelId: string) => { provider: string; id: string } | null
  /** The active thread changed (or its boot settled): ipc.ts repoints WindowState.agent/agentReady
   *  and pushes agent:ready so the panel re-hydrates. Also fired when an active boot FAILS, so the
   *  renderer re-pulls state and finds the designed threadError notice. */
  onActiveChanged: (agent: WorkspaceAgent | null, ready: Promise<WorkspaceAgent> | null) => void
  /** A run-as-is settled — B4's toast rides this push. */
  onRunComplete?: (payload: RunCompletePayload) => void
  /** The ACTIVE thread's boot failed: the window should re-pull state for the designed notice. */
  onBootFailed?: (threadId: string, message: string) => void
  /** Track a late teardown promise (a boot resolving after disposeAll) so app quit awaits it. */
  trackDisposal?: (pending: Promise<void>) => void
  /** Machine custom-instructions override for tests; production uses the ~/.bridle default. */
  machineInstructionsPath?: string
}

export class ThreadManager {
  private instances = new Map<string, ThreadInstance>()
  /** Proposal agents are unindexed but manager-owned from method entry through final disposal. */
  private throwaways = new Set<ManagedAgentInstance>()
  private activeId: string | null = null
  /** The active thread's record, cached from the index at activation — stays readable (for the
   *  banner and the designed failure notice) even when the instance failed to boot. */
  private activeRecordCache: ThreadRecord | null = null
  /** Human message for the active thread's failed boot, cleared on a successful activation. */
  private bootErrors = new Map<string, string>()
  /** One quiet explanation per boot-time stale-model fallback; never persisted as thread history. */
  private modelNotices = new Map<string, string>()
  private disposed = false
  /** Bumped per activation so a slow boot can't clobber a newer activation's agent pointer. */
  private activationGeneration = 0

  constructor(private readonly opts: ThreadManagerOptions) {}

  private isListed(model: ModelRef): boolean {
    if (this.opts.isModelAvailable) return this.opts.isModelAvailable(model.provider, model.id)
    const listing = this.opts.listedModels?.()
    return listing ? listing.listed.some((entry) => entry.provider === model.provider && entry.id === model.id) : true
  }

  /**
   * `wanted` when listed; else a same-provider fallback; else `ask` with the other providers' models
   * (decision 2026-10-06, "ask first": never switch provider on the user's behalf). With nothing
   * runnable anywhere, `wanted` stays and the existing start-failure notice shows.
   */
  private runnableModel(wanted: ModelRef): ModelResolution {
    if (this.isListed(wanted)) return { kind: 'run', model: wanted, replaced: false }
    const saved = this.opts.modelService?.resolveSavedModel(wanted.provider, wanted.id)
    if (saved?.modelId) return { kind: 'run', model: { provider: wanted.provider, id: saved.modelId }, replaced: saved.modelId !== wanted.id }
    const resolution = chooseRunnableModel(wanted, this.opts.listedModels?.().available ?? [])
    if (resolution.kind === 'ask' && resolution.candidates.length === 0) return { kind: 'run', model: wanted, replaced: false }
    return resolution
  }

  /** Threads that may not start until the user chooses a model, with the models to offer. */
  private choiceRequired = new Map<string, { wanted: ModelRef; candidates: ModelRef[] }>()

  /** The active thread is waiting for the user to choose a model ("ask first"). */
  activeModelChoice(): { wanted: ModelRef; candidates: ModelRef[] } | null {
    return this.activeId ? this.choiceRequired.get(this.activeId) ?? null : null
  }

  /** Defaults read after the model list is ready. */
  private async readyDefaults(): Promise<ReturnType<ThreadManager['resolvedDefaults']>> {
    await this.opts.modelsReady?.()
    return this.resolvedDefaults()
  }

  private resolvedDefaults(): {
    model: { provider: string; id: string }
    thinkingLevel: ThinkingLevel
    replacedDefault?: ModelRef
    /** The default cannot run and no same-provider model can: a new chat must ask. `model` is then
     *  the (unrunnable) default, kept so the chat names what it wanted. */
    choice?: { wanted: ModelRef; candidates: ModelRef[] }
  } {
    const defaults = this.opts.defaults?.() ?? {}
    const wanted = { provider: defaults.provider ?? 'openai-codex', id: defaults.modelId ?? this.opts.modelService?.recommendedModel(defaults.provider ?? 'openai-codex') ?? DEFAULT_OPENAI_CODEX_MODEL }
    const resolution = this.runnableModel(wanted)
    const thinkingLevel = defaults.thinkingLevel ?? 'medium'
    if (resolution.kind === 'ask') return { model: wanted, thinkingLevel, choice: { wanted, candidates: resolution.candidates } }
    return { model: resolution.model, thinkingLevel, ...(resolution.replaced ? { replacedDefault: wanted } : {}) }
  }

  /** A new thread created on a replaced default carries the same one-time notice. */
  private noteReplacedDefault(recordId: string, defaults: { model: ModelRef; replacedDefault?: ModelRef }): void {
    if (defaults.replacedDefault) this.modelNotices.set(recordId, modelReplacedNotice(defaults.replacedDefault, defaults.model))
  }

  /**
   * Decide a record's preferences without writing anything: the model to run, the notice owed, and
   * whether the user must choose. An unlisted stored model is replaced only within its own provider;
   * otherwise the record keeps it and `choice` carries the other providers' models to offer.
   */
  private planPreferences(record: ThreadRecord): {
    next: ThreadRecord
    changed: boolean
    modelChanged: boolean
    notice: string | null
    choice: { wanted: ModelRef; candidates: ModelRef[] } | null
  } {
    const defaults = this.resolvedDefaults()
    const thinkingLevel = record.thinkingLevel ?? defaults.thinkingLevel
    const storedModel = record.model ? { ...record.model } : null
    if (storedModel && !this.isListed(storedModel)) {
      const resolution = this.runnableModel(storedModel)
      if (resolution.kind === 'ask') {
        const choice = { wanted: storedModel, candidates: resolution.candidates }
        return { next: { ...record, thinkingLevel }, changed: !record.thinkingLevel, modelChanged: false, notice: null, choice }
      }
      if (resolution.replaced) {
        return {
          next: { ...record, model: resolution.model, thinkingLevel },
          changed: true,
          modelChanged: true,
          notice: modelReplacedNotice(storedModel, resolution.model),
          choice: null,
        }
      }
      // Nothing runnable anywhere: the stored model stays (existing start-failure notice).
    }
    if (record.model && record.thinkingLevel) return { next: record, changed: false, modelChanged: false, notice: null, choice: null }
    const next = { ...record, model: record.model ?? defaults.model, thinkingLevel }
    const notice = !record.model && defaults.replacedDefault ? modelReplacedNotice(defaults.replacedDefault, defaults.model) : null
    const choice = !record.model && defaults.choice ? defaults.choice : null
    return { next, changed: true, modelChanged: false, notice, choice }
  }

  private async commitPreferences(plan: { next: ThreadRecord; notice: string | null }): Promise<ThreadRecord> {
    const { next } = plan
    // A changed plan always fills both fields (record value, else the resolved default).
    await this.opts.index.setPreferences(next.id, { model: next.model!, thinkingLevel: next.thinkingLevel! })
    if (plan.notice) this.modelNotices.set(next.id, plan.notice)
    if (this.activeRecordCache?.id === next.id) this.activeRecordCache = { ...this.activeRecordCache, model: next.model, thinkingLevel: next.thinkingLevel }
    return next
  }

  private noteChoice(id: string, choice: { wanted: ModelRef; candidates: ModelRef[] } | null): void {
    if (!choice) {
      this.choiceRequired.delete(id)
      return
    }
    this.choiceRequired.set(id, choice)
    // Source side of the "ask first" gate: whichever path found the pending choice (reopen,
    // revalidation, creation), the window stops pointing at an agent and re-pulls its state.
    this.publishWaiting(id)
  }

  /** The active thread waits for a model choice: clear the window's agent and emit state. */
  private publishWaiting(id: string): void {
    if (id !== this.activeId || this.disposed) return
    this.opts.onActiveChanged(null, null)
    this.opts.onBootFailed?.(id, this.activeModelNotice() ?? '')
  }

  /**
   * Sink side of the "ask first" gate, and the ONE main-process send path: every `agent.prompt`
   * goes through here, immediately before sending. It refuses while the thread being sent to — the
   * named thread, and any thread whose instance owns `agent` — waits for a model choice, publishing
   * the waiting state so the window catches up.
   */
  async sendGuarded<T>(agent: WorkspaceAgent, threadId: string | null, send: () => Promise<T>): Promise<T> {
    this.assertMaySend(agent, threadId)
    return send()
  }

  /** Throws the ask notice when a send to `agent` / `threadId` would bypass a pending model choice. */
  assertMaySend(agent: WorkspaceAgent | null, threadId: string | null): void {
    const ids = new Set<string>()
    if (threadId) ids.add(threadId)
    if (agent) for (const [id, instance] of this.instances) if (instance.agent === agent) ids.add(id)
    for (const id of ids) {
      const choice = this.choiceRequired.get(id)
      if (choice) {
        this.publishWaiting(id)
        throw new Error(modelChoiceNotice(choice.wanted))
      }
    }
  }

  /** Resolve and persist a record's preferences. Callers have awaited modelsReady. */
  private async ensurePreferences(record: ThreadRecord): Promise<ThreadRecord> {
    const plan = this.planPreferences(record)
    this.noteChoice(record.id, plan.choice)
    return plan.changed ? this.commitPreferences(plan) : record
  }

  /** Apply `target` to a live agent and read it back; false when it did not take. */
  private async applyToLive(instance: ThreadInstance, target: ModelRef): Promise<boolean> {
    try {
      const agent = instance.agent ?? await instance.ready
      await (this.opts.applyModel ? this.opts.applyModel(agent, target.provider, target.id) : agent.setModel(target.provider, target.id))
      const inForce = this.opts.currentModelAfterApply
        ? this.opts.currentModelAfterApply(agent, target.provider, target.id)
        : agent.currentModel()
      return !!inForce && inForce.provider === target.provider && inForce.id === target.id
    } catch {
      return false
    }
  }

  /**
   * Reactivating a thread whose agent already exists: a replacement model is applied to that live
   * agent and read back before it is persisted or announced. If the agent cannot switch, nothing is
   * claimed: the record keeps its model and no notice is shown.
   */
  private async reconcileLiveInstance(instance: ThreadInstance, stored: ThreadRecord): Promise<ThreadRecord> {
    const plan = this.planPreferences(stored)
    // "Ask first": the live agent is not pointed at, so nothing can be sent until the user chooses.
    this.noteChoice(stored.id, plan.choice)
    if (!plan.changed) return stored
    if (!plan.modelChanged || !plan.next.model) return this.commitPreferences(plan)
    if (!await this.applyToLive(instance, plan.next.model)) return stored
    const next = await this.commitPreferences(plan)
    instance.record = next
    return next
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('This window is closing.')
  }

  /** Exactly-once teardown for one instance; tracked so quit can await the flush. */
  private async disposeInstance(instance: ManagedAgentInstance): Promise<void> {
    if (instance.disposed) return
    instance.disposed = true
    const agent = instance.agent ?? await instance.ready.catch(() => null)
    if (!agent) return
    await agent.abort().catch(() => {})
    await agent.dispose()
  }

  /** The composition every thread carries; a skill thread adds its active skill on top. */
  private async baseComposition(): Promise<PromptComposition> {
    const { skills } = await this.opts.skills.list()
    let customInstructions: string | null = null
    try {
      customInstructions = await loadMachineInstructions(this.opts.machineInstructionsPath)
    } catch (error) {
      // S5 contract: only ENOENT is "no layer" — anything else must be visible, not silently absent.
      recordMainProcessDiagnostic('threads.machine-instructions.error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    // The registry's metas are not full Skills (no instructions — progressive disclosure); the
    // composer only reads name + description for the discoverable list, so this cast is honest.
    const discoverable = skills.map((meta) => ({
      name: meta.name, description: meta.description, tools: meta.tools, input: meta.input,
      instructions: '', source: meta.source,
    })) as unknown as Skill[]
    return {
      ...(this.opts.ambient ? { ambient: this.opts.ambient } : {}),
      ...(customInstructions ? { customInstructions } : {}),
      ...(discoverable.length > 0 ? { skills: discoverable } : {}),
    }
  }

  /** review finding B1 review P0: EVERY thread gets its own dir. The earlier legacy-dir migration pointed
   *  first chat threads at userData itself, which shares the app-global proposals journal and
   *  Flight Recorder across WORKSPACES (bridle keys them by appDataDir alone) — workspace B could
   *  list and adopt workspace A's pending proposals. The pre-threads transcript stays untouched on
   *  disk under <userData>/sessions; surfacing it again is a possible later migration, never worth
   *  a cross-workspace data boundary. */
  private threadDir(record: ThreadRecord): string {
    return join(this.opts.userDataDir, 'threads', record.id)
  }

  private boot(record: ThreadRecord): ThreadInstance {
    this.assertLive()
    const existing = this.instances.get(record.id)
    if (existing) return existing
    const ready = (async () => {
      const base = await this.baseComposition()
      let composition: PromptComposition = base
      if (record.kind === 'skill') {
        const { skill } = await this.opts.skills.get(record.skillName ?? '')
        if (!skill) {
          throw new ThreadSkillGoneError(record.skillName ?? '(unnamed)')
        }
        composition = { ...base, activeSkill: skill }
      }
      // Revalidate just before Bridle sees the model: the list may have changed since activation.
      await this.opts.modelsReady?.()
      const final = await this.ensurePreferences(this.instances.get(record.id)?.record ?? record)
      const owned = this.instances.get(record.id)
      if (owned) owned.record = final
      // "Ask first": never hand Bridle a model from a provider the user did not pick for this chat.
      const choice = this.choiceRequired.get(final.id)
      if (choice) throw new Error(modelChoiceNotice(choice.wanted))
      const defaults = this.resolvedDefaults()
      return this.opts.createAgent({
        threadId: final.id,
        appDataDir: this.threadDir(final),
        defaults: {
          provider: final.model?.provider ?? defaults.model.provider,
          modelId: final.model?.id ?? defaults.model.id,
          thinkingLevel: final.thinkingLevel ?? defaults.thinkingLevel,
        },
        composition,
      })
    })()
    const instance: ThreadInstance = { record, ready, agent: null, disposed: false }
    this.instances.set(record.id, instance)
    ready.then((agent) => {
      instance.agent = agent
      this.bootErrors.delete(record.id)
      // A boot that lands after disposeAll cleared the map still tears down exactly once, and the
      // teardown is TRACKED so quit's waitForAgentDisposals covers its flush (review finding B1 review P1).
      if (this.disposed) this.opts.trackDisposal?.(this.disposeInstance(instance))
    }).catch((error) => {
      // The rejection also surfaces to whoever awaits activate()/agentReady; recording it here lets
      // agent:state carry the designed notice. The failed entry leaves the cache so a repaired
      // skill can be retried.
      // A creation refused for "ask first" is not a boot failure: the model notice and picker carry it.
      if (!this.choiceRequired.has(record.id)) this.bootErrors.set(record.id, error instanceof Error ? error.message : String(error))
      this.instances.delete(record.id)
    })
    return instance
  }

  /** Restore-or-create the window's thread world on workspace bind: the most recently active
   *  thread wakes; a workspace with no threads gets its first chat thread. */
  async bind(): Promise<void> {
    this.assertLive()
    const { records } = await this.opts.index.list(this.opts.workspaceRoot)
    let record = records[0] ?? null
    if (!record) {
      const defaults = await this.readyDefaults()
      record = {
        id: randomUUID(),
        workspaceRoot: this.opts.workspaceRoot,
        kind: 'chat',
        title: 'New chat',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        model: defaults.model,
        thinkingLevel: defaults.thinkingLevel,
      }
      await this.addRecordGuarded(record) // review finding round 3: bind's first-chat add rolls back too
      this.noteReplacedDefault(record.id, defaults)
    }
    await this.activate(record.id)
  }

  async list(): Promise<{ threads: ThreadMeta[]; error: string | null }> {
    const { records, error } = await this.opts.index.list(this.opts.workspaceRoot)
    return {
      threads: records.map(({ id, kind, skillName, title, lastActiveAt }) => ({
        id, kind, ...(skillName ? { skillName } : {}), title, lastActiveAt,
      })),
      error,
    }
  }

  activeThreadId(): string | null {
    return this.activeId
  }

  /** Index-backed (not instance-backed): stays readable for the banner and the designed failure
   *  notice even when the active thread's boot failed and its instance was dropped. */
  activeRecord(): ThreadRecord | null {
    return this.activeRecordCache
  }

  activeTurnRecords(): TurnExecution[] {
    return this.activeRecordCache?.turns?.map((turn) => ({ ...turn })) ?? []
  }

  /** Human copy for the active thread's failed boot, or null when it booted (or is still booting). */
  activeBootError(): string | null {
    return this.activeId ? this.bootErrors.get(this.activeId) ?? null : null
  }

  /** Quiet boot-time model fallback copy for the active thread. One manager creates it at most once. */
  activeModelNotice(): string | null {
    if (!this.activeId) return null
    const choice = this.choiceRequired.get(this.activeId)
    if (choice) return modelChoiceNotice(choice.wanted)
    return this.modelNotices.get(this.activeId) ?? null
  }

  /**
   * The user's explicit choice for a thread that is waiting ("ask first"). Any model that can run is
   * accepted, since the user picked it; it is persisted, then the thread starts (or its live agent is
   * switched and read back). A pick that cannot run, or a live agent that refuses it, changes nothing.
   */
  async chooseModel(provider: string, modelId: string): Promise<void> {
    this.assertLive()
    const id = this.activeId
    if (!id || !this.choiceRequired.has(id)) throw new Error('This chat is not waiting for a model choice.')
    const target = { provider, id: modelId }
    const runnable = (this.opts.listedModels?.().available ?? []).some((model) => model.provider === provider && model.id === modelId)
    if (!runnable) throw new Error(`That model is unavailable: ${provider}/${modelId}`)
    const live = this.instances.get(id)
    if (live && !await this.applyToLive(live, target)) {
      throw new Error(`The model switch was ignored: ${provider}/${modelId} is not in force.`)
    }
    await this.opts.index.setModel(id, target)
    if (live) live.record = { ...live.record, model: target }
    this.choiceRequired.delete(id)
    this.modelNotices.delete(id)
    await this.activate(id)
  }

  /** The active thread's live agent (null while its boot is in flight). */
  activeAgent(): WorkspaceAgent | null {
    return this.activeId ? this.instances.get(this.activeId)?.agent ?? null : null
  }

  /** Any thread's live agent — approval responses route to the OWNING thread, never the active one
   *  (review finding round 2: a background thread's approval answered through the active agent left the owner
   *  hanging). */
  agentFor(id: string): WorkspaceAgent | null {
    return this.instances.get(id)?.agent ?? null
  }

  clearRestagedOrigin(changeId: string): void {
    for (const instance of this.instances.values()) instance.agent?.clearRestagedOrigin(changeId)
  }

  activeReady(): Promise<WorkspaceAgent> | null {
    // "Ask first": a chat waiting for a model has no agent to send through, even if one is still alive.
    if (!this.activeId || this.choiceRequired.has(this.activeId)) return null
    return this.instances.get(this.activeId)?.ready ?? null
  }

  /** Make a thread the panel's thread. Instances are NOT disposed on switch — a run fired in one
   *  thread keeps running while the writer reads another; disposal happens on close()/disposeAll().
   *  review finding B1 review P0: every await between taking the generation and pointing the window is
   *  re-checked — a slower older activation must never expose its agent after a newer one won
   *  (activeId saying B while agent:prompt runs through A crosses the skill boundary). */
  async activate(id: string): Promise<void> {
    this.assertLive()
    // Claim the generation SYNCHRONOUSLY: caller order is user-intent order, and the index read
    // below must not let an older activation overtake a newer one that read faster.
    const generation = ++this.activationGeneration
    await this.opts.modelsReady?.()
    const stored = await this.opts.index.get(id)
    if (!stored || stored.workspaceRoot !== this.opts.workspaceRoot) throw new Error('No such thread in this workspace.')
    const live = this.instances.get(id)
    const record = live ? await this.reconcileLiveInstance(live, stored) : await this.ensurePreferences(stored)
    if (generation !== this.activationGeneration) return // a newer activation superseded this one
    this.assertLive()
    if (this.choiceRequired.has(id)) {
      // "Ask first": the thread becomes active WITHOUT an agent, so nothing can start or send. The
      // window re-pulls agent:state and finds the notice and the models to offer. A live instance
      // (a background run) is left alone, just not pointed at; chooseModel switches it.
      this.bootErrors.delete(id)
      this.activeId = id
      this.activeRecordCache = record
      this.opts.onActiveChanged(null, null)
      this.opts.onBootFailed?.(id, this.activeModelNotice() ?? '')
      await this.opts.index.touch(id)
      return
    }
    const instance = this.boot(record)
    this.activeId = id
    this.activeRecordCache = record
    this.opts.onActiveChanged(instance.agent, instance.ready)
    instance.ready.then((agent) => {
      // Only the newest activation may repoint the window when its boot settles.
      if (generation === this.activationGeneration && this.activeId === id && !this.disposed) {
        this.opts.onActiveChanged(agent, instance.ready)
      }
    }).catch(() => {
      // Boot failed while still active: tell the window so the renderer re-pulls agent:state and
      // finds the designed threadError notice (agent:ready is "state changed", not "agent up").
      if (generation === this.activationGeneration && this.activeId === id && !this.disposed) {
        this.opts.onBootFailed?.(id, this.bootErrors.get(id) ?? 'The thread could not start.')
      }
    })
    // The recency touch rides AFTER the pointer settles and is serialised by the index itself;
    // its completion must never gate (or reorder around) onActiveChanged.
    await this.opts.index.touch(id)
  }

  /** review finding round 2: an index.add that lands while the manager is being disposed must not leave an
   *  orphan record no instance will ever serve — roll it back before surfacing the closure. */
  private async addRecordGuarded(record: ThreadRecord): Promise<void> {
    this.assertLive()
    await this.opts.index.add(record)
    if (this.disposed) {
      await this.opts.index.remove(record.id).catch(() => {})
      throw new Error('This window is closing.')
    }
  }

  async newChat(): Promise<ThreadMeta> {
    this.assertLive()
    const defaults = await this.readyDefaults()
    this.assertLive()
    const record: ThreadRecord = {
      id: randomUUID(),
      workspaceRoot: this.opts.workspaceRoot,
      kind: 'chat',
      title: 'New chat',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      model: defaults.model,
      thinkingLevel: defaults.thinkingLevel,
    }
    await this.addRecordGuarded(record)
    this.noteReplacedDefault(record.id, defaults)
    await this.activate(record.id)
    return { id: record.id, kind: 'chat', title: record.title, lastActiveAt: record.lastActiveAt }
  }

  /** "Open thread": a NEW chat bound to the skill for its whole life (every open is a fresh thread;
   *  past ones remain under Recent). The skill is read at this moment — an edited SKILL.md applies
   *  from the next activation, exactly the PRD state. */
  async openSkillThread(skillName: string): Promise<ThreadMeta> {
    this.assertLive()
    const { skill, errors } = await this.opts.skills.get(skillName)
    if (!skill) {
      const detail = errors.find((error) => error.source.includes(skillName))?.message
      throw new Error(detail ? `${skillName}: ${detail}` : `No skill named "${skillName}" is available.`)
    }
    const defaults = await this.readyDefaults()
    this.assertLive()
    const record: ThreadRecord = {
      id: randomUUID(),
      workspaceRoot: this.opts.workspaceRoot,
      kind: 'skill',
      skillName,
      title: skillDisplayName(skill),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      model: defaults.model,
      thinkingLevel: defaults.thinkingLevel,
    }
    await this.addRecordGuarded(record)
    this.noteReplacedDefault(record.id, defaults)
    await this.activate(record.id)
    return { id: record.id, kind: 'skill', skillName, title: record.title, lastActiveAt: record.lastActiveAt }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const id = this.activeId
    if (!id) throw new Error('No active thread.')
    const agent = await this.activeReady()
    if (!agent) throw new Error('The active thread is still starting.')
    const available = this.opts.isModelAvailable
      ? this.opts.isModelAvailable(provider, modelId)
      : agent.availableModels().some((model) => model.provider === provider && model.id === modelId)
    if (!available) {
      agent.assertModelListed(provider, modelId)
      throw new Error(`That model is unavailable: ${provider}/${modelId}`)
    }
    await (this.opts.applyModel
      ? this.opts.applyModel(agent, provider, modelId)
      : agent.setModel(provider, modelId))
    const inForce = this.opts.currentModelAfterApply
      ? this.opts.currentModelAfterApply(agent, provider, modelId)
      : agent.currentModel()
    if (!inForce || inForce.provider !== provider || inForce.id !== modelId) {
      const actual = inForce ? `${inForce.provider}/${inForce.id}` : 'no model'
      throw new Error(`The model switch was ignored: ${actual} remains in force.`)
    }
    await this.opts.index.setModel(id, { provider, id: modelId })
    if (this.activeRecordCache?.id === id) this.activeRecordCache.model = { provider, id: modelId }
  }

  async setThinking(level: ThinkingLevel): Promise<void> {
    if (!isThinkingLevel(level)) throw new Error(`Unknown reasoning level: ${String(level)}`)
    const id = this.activeId
    if (!id) throw new Error('No active thread.')
    const agent = await this.activeReady()
    if (!agent) throw new Error('The active thread is still starting.')
    await agent.setThinking(level)
    await this.opts.index.setThinking(id, level)
    if (this.activeRecordCache?.id === id) this.activeRecordCache.thinkingLevel = level
  }

  async recordTurn(threadId: string, execution: TurnExecution): Promise<void> {
    await this.opts.index.appendTurn(threadId, execution)
    if (this.activeRecordCache?.id === threadId) {
      const turns = this.activeRecordCache.turns ?? []
      if (!turns.some((turn) => turn.turnId === execution.turnId)) turns.push({ ...execution })
      this.activeRecordCache.turns = turns
    }
  }

  /**
   * Ask an unindexed, base-composed throwaway agent for a complete replacement SKILL.md. The edit
   * target is prompt material, never the active skill layer: letting a skill rewrite itself under
   * its own scoped composition would make the proposal less independent and structurally narrower.
   */
  async proposeSkillEdit(skillName: string, request: string): Promise<{ current: string; proposed: string }> {
    this.assertLive()
    const threadId = `skill-edit-${randomUUID()}`
    let resolveReady!: (agent: WorkspaceAgent) => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<WorkspaceAgent>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => {})
    const instance: ManagedAgentInstance = { ready, agent: null, disposed: false }
    // Ownership exists before the first await, so disposeAll can join boot as well as prompt.
    this.throwaways.add(instance)
    try {
      const input = parseSkillProposeEditInput({ name: skillName, request })
      const { skill, errors } = await this.opts.skills.get(input.name)
      this.assertLive()
      if (!skill) {
        const detail = errors.find((error) => error.source.includes(input.name))?.message
        throw new Error(detail ? `${input.name}: ${detail}` : `No skill named "${input.name}" is available.`)
      }
      const current = await readFile(skill.source, 'utf8')
      this.assertLive()
      const composition = await this.baseComposition()
      this.assertLive()
      const defaults = await this.readyDefaults()
      this.assertLive()
      // "Ask first": a throwaway agent never starts on another provider's model either.
      if (defaults.choice) throw new Error(modelChoiceNotice(defaults.choice.wanted))
      const agent = await this.opts.createAgent({
        threadId,
        appDataDir: join(this.opts.userDataDir, 'threads', threadId),
        defaults: {
          provider: defaults.model.provider,
          modelId: defaults.model.id,
          thinkingLevel: defaults.thinkingLevel,
        },
        composition,
      })
      instance.agent = agent
      resolveReady(agent)
      this.assertLive()
      const prompt = [
        'Revise the SKILL.md below according to the user request.',
        'Reply with ONLY the complete revised SKILL.md file content in one fenced Markdown block.',
        '',
        'CURRENT SKILL.md:',
        current,
        'USER REQUEST:',
        input.request,
      ].join('\n')
      const result = await this.sendGuarded(agent, null, () => agent.prompt(prompt))
      this.assertLive()
      const reply = result.messages.at(-1)
      const proposed = reply?.role === 'assistant' && !reply.error
        ? fencedFile(reply.content)
        : null
      if (proposed === null) throw new Error('The agent could not propose a change — try rephrasing.')
      return { current, proposed }
    } catch (error) {
      rejectReady(error)
      throw error
    } finally {
      const pending = this.disposeInstance(instance)
      this.opts.trackDisposal?.(pending)
      await pending
      this.throwaways.delete(instance)
      // A proposal's whole data dir is scratch (review finding B5 review r1+r2): remove it after teardown or
      // one tree per attempt accumulates — and AWAIT it, so settlement means the dir is gone and a
      // shutdown right after can't strand it. The path is OURS by construction (skill-edit-<uuid>
      // minted above); failure to clean is diagnostic-worthy, never fatal.
      await rm(join(this.opts.userDataDir, 'threads', threadId), { recursive: true, force: true }).catch((error) => {
        recordMainProcessDiagnostic('threads.skill-edit.cleanup-failed', {
          threadId, message: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  /**
   * Run-as-is (ADR-0027): a real thread record (it appears under Recent so the writer can open it
   * and argue), an instance fired ONCE with empty user text — the hidden writer situation is the whole
   * prompt, and messages() strips it, so the transcript shows an agent turn with nothing said.
   * The panel does NOT switch to it; completion surfaces as the M4 toast via onRunComplete.
   */
  async runSkillAsIs(skillName: string, activeFile: string | null): Promise<{ threadId: string }> {
    this.assertLive()
    const { skill, errors } = await this.opts.skills.get(skillName)
    if (!skill) {
      const detail = errors.find((error) => error.source.includes(skillName))?.message
      throw new Error(detail ? `${skillName}: ${detail}` : `No skill named "${skillName}" is available.`)
    }
    if (skill.input === 'document' && !activeFile) {
      throw new Error(`${skillDisplayName(skill)} needs an open document.`)
    }
    // Fired while THIS skill's thread is the active one → reuse it (spec: run-as-is from an open
    // skill thread is the same instance fired with nothing said), no hidden second record.
    const active = this.activeRecordCache
    const reusable = active && active.kind === 'skill' && active.skillName === skillName
      ? this.instances.get(active.id)
      : undefined
    // "Ask first": revalidate before anything runs. A reused thread gets the same check as a reopen
    // (same-provider switch read back from its live agent, or a pending choice); a new thread starts
    // only on a model its default provider can run. A pending choice refuses the run: nothing is sent.
    const defaults = await this.readyDefaults()
    this.assertLive()
    if (reusable) {
      const stored = await this.opts.index.get(reusable.record.id) ?? reusable.record
      reusable.record = await this.reconcileLiveInstance(reusable, stored)
      if (this.activeRecordCache?.id === reusable.record.id) this.activeRecordCache = reusable.record
      const choice = this.choiceRequired.get(reusable.record.id)
      if (choice) throw new Error(modelChoiceNotice(choice.wanted))
    } else if (defaults.choice) {
      throw new Error(modelChoiceNotice(defaults.choice.wanted))
    }
    const record: ThreadRecord = reusable
      ? reusable.record
      : {
        id: randomUUID(),
        workspaceRoot: this.opts.workspaceRoot,
        kind: 'skill',
        skillName,
        title: activeFile ? activeFile.split('/').at(-1) ?? activeFile : skillDisplayName(skill),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        model: defaults.model,
        thinkingLevel: defaults.thinkingLevel,
      }
    if (!reusable) await this.addRecordGuarded(record)
    else await this.opts.index.touch(record.id) // a reused thread's run still counts as activity
    // review finding round 2: disposal can land during the index write above — a run must never start (or
    // prompt a disposed agent) once the manager is going down.
    this.assertLive()
    const instance = reusable ?? this.boot(record)
    void (async () => {
      try {
        const agent = await instance.ready
        if (this.disposed || instance.disposed) return
        // Send-time check: a choice that became pending while the agent was starting still blocks.
        const result = await this.sendGuarded(agent, record.id, () => agent.prompt('', activeFile))
        this.opts.onRunComplete?.({
          threadId: record.id,
          skillName,
          reply: result.messages.at(-1)?.role === 'assistant' ? result.messages.at(-1)?.content ?? null : null,
          suggestionsStaged: result.suggestions.length,
          outcome: result.messages.at(-1)?.error ? 'error' : 'completed',
        })
      } catch (error) {
        this.opts.onRunComplete?.({
          threadId: record.id, skillName, reply: error instanceof Error ? error.message : String(error),
          suggestionsStaged: 0, outcome: 'error',
        })
      }
    })()
    return { threadId: record.id }
  }

  /**
   * Read-only history for a thread whose instance cannot boot (missing/malformed skill): parse the
   * thread's OWN persisted Pi session file directly — the transcript is on disk regardless of
   * whether an agent can start (review finding round 2: the designed notice must come WITH the history, never
   * an empty pane). Same mapping rules as WorkspaceAgent.messages().
   */
  /**
   * The transcript to show for the active thread while it has no agent: its persisted conversation
   * when it could not start (a boot error) or is waiting for a model choice ("ask first"), so the
   * conversation stays on screen while the writer picks a model. Empty otherwise.
   */
  async activeIdleTranscript(): Promise<ChatMessage[]> {
    const id = this.activeId
    if (!id || (!this.bootErrors.has(id) && !this.choiceRequired.has(id))) return []
    return this.readThreadTranscript(id)
  }

  async readThreadTranscript(id: string): Promise<ChatMessage[]> {
    const record = await this.opts.index.get(id)
    if (!record) return []
    // Bridle resolves the CURRENT BRANCH via Pi's own session machinery (read-only; selection
    // mirrors continueRecent); the mapping to UI rows is the SAME function the live agent uses,
    // so the read-only view can never drift from what the thread showed while healthy.
    const { messages, error } = await readLatestSessionTranscript(join(this.threadDir(record), 'sessions'), this.opts.workspaceRoot)
    if (error) {
      recordMainProcessDiagnostic('threads.transcript.error', { threadId: id, message: error })
    }
    return attachTurnExecutions(mapSessionMessages(messages), record.turns ?? [])
  }

  /** The first thing the writer says names the thread (one line, trimmed) — Recent stays readable. */
  async noteUserText(text: string): Promise<void> {
    if (!this.activeId) return
    const record = await this.opts.index.get(this.activeId)
    if (!record) return
    // A skill thread keeps its default name (the skill's title, or the slug form older records
    // carry) until the writer's first line names it.
    const titled = record.kind === 'skill' && record.skillName
      ? await this.opts.skills.get(record.skillName).then(({ skill }) => skill, () => null)
      : null
    const isUnnamed = record.title === 'New chat'
      || record.title === skillDisplayName(record.skillName ?? '')
      || (titled !== null && record.title === skillDisplayName(titled))
    const line = text.trim().split('\n')[0].slice(0, 80)
    await this.opts.index.touch(this.activeId, isUnnamed && line ? { title: line } : undefined)
  }

  /** Abort + dispose one thread's instance. The index record stays — a closed thread is history.
   *  Closing the ACTIVE thread falls back to the most recent remaining thread (or a fresh chat),
   *  so the window never sits agent-less (review finding B1 review P1). */
  async close(id: string): Promise<void> {
    const instance = this.instances.get(id)
    this.instances.delete(id)
    const wasActive = this.activeId === id
    if (wasActive) {
      this.activeId = null
      this.activeRecordCache = null
      this.opts.onActiveChanged(null, null)
    }
    if (instance) await this.disposeInstance(instance)
    if (wasActive && !this.disposed) {
      const { records } = await this.opts.index.list(this.opts.workspaceRoot)
      const next = records.find((record) => record.id !== id)
      if (next) await this.activate(next.id)
      else await this.newChat()
    }
  }

  private disposeAllPromise: Promise<void> | null = null

  /** Window close / workspace rebind: every instance goes down, in-flight boots dispose on arrival
   *  (tracked via trackDisposal so quit awaits their flush). Re-entrant callers JOIN the in-flight
   *  teardown (review finding round 2: rebind's disposeAll then window-close's must not settle early on an
   *  already-cleared map while the first teardown is still flushing). */
  disposeAll(): Promise<void> {
    return (this.disposeAllPromise ??= (async () => {
      this.disposed = true
      const instances = [...this.instances.values()]
      const throwaways = [...this.throwaways]
      this.instances.clear()
      this.throwaways.clear()
      this.activeId = null
      this.activeRecordCache = null
      await Promise.allSettled([...instances, ...throwaways].map((instance) => this.disposeInstance(instance)))
    })())
  }
}

/** A persisted skill thread whose SKILL.md has since vanished or gone malformed: the thread opens as
 *  read-only history with a designed notice, never a crash and never a silent chat fallback. */
export class ThreadSkillGoneError extends Error {
  constructor(skillName: string) {
    super(`The ${skillDisplayName(skillName)} skill behind this thread is missing or unreadable, so the thread is read-only history.`)
    this.name = 'ThreadSkillGoneError'
  }
}

/** A skill's on-screen name: its SKILL.md `title:`, else "copy-edit" → "Copy-edit" (ticket 11). */
export { skillDisplayName }

/**
 * The reply must contain EXACTLY ONE top-level fenced block (review finding B5 review P1): a reply with two
 * blocks — or one whose inner same-length fence closes the outer early, leaving a residue that
 * parses as another block — is ambiguous about which content is "the file", and an ambiguous
 * proposal must fail to the designed copy rather than apply the wrong content. Prose around the
 * single block is fine (models narrate); a second block is not.
 */
function fencedFile(reply: string): string | null {
  const blocks: string[] = []
  let offset = 0
  let opening: { character: '`' | '~'; length: number; contentStart: number } | null = null
  while (offset < reply.length) {
    const newline = reply.indexOf('\n', offset)
    const end = newline === -1 ? reply.length : newline + 1
    const rawLine = reply.slice(offset, end)
    const line = rawLine.replace(/\r?\n$/, '')
    if (!opening) {
      const match = /^[ \t]*(`{3,}|~{3,})[^\r\n]*$/.exec(line)
      if (match) {
        const fence = match[1]
        opening = { character: fence[0] as '`' | '~', length: fence.length, contentStart: end }
      }
    } else {
      const candidate = line.trim()
      const { character, length } = opening
      if (
        candidate.length >= length
        && [...candidate].every((candidateCharacter) => candidateCharacter === character)
      ) {
        blocks.push(reply.slice(opening.contentStart, offset))
        opening = null
      }
    }
    offset = end
  }
  // An unclosed trailing fence is also ambiguity, not a block.
  if (opening !== null) return null
  return blocks.length === 1 ? blocks[0] : null
}
