import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AuditEvent, BridleMode, Capability } from "./types.ts";
import type { TurnEndReason, TurnOutcome, TurnResponder, TurnToolError } from "./events.ts";
import type { BridleVersioning, BridleVersioningRestoreResult } from "./harness.ts";
import { persistSnapshotUndoIntent, planSnapshotRestore, RestoreNotRecordedError, RestoreRefusedError, settleSnapshotUndoIntent, snapshotJournalDamaged, snapshotRestorePointPath, snapshotUndoIntents, type JournalEntry, type SnapshotStore, type SnapshotUndoIntent } from "./snapshots.ts";
import type { RecorderStore } from "./recorder/store.ts";
import { ABSENT_PATH, captureTurnPaths, safeRelativePath, turnPathIdentity, workspaceRelativePath } from "./turn-paths.ts";

export type TurnActivityItem = {
  kind: "read" | "created" | "modified" | "moved" | "trashed" | "deleted" | "waiting" | "asked" | "refused" | "tool-error" | "outside";
  path?: string;
  toPath?: string;
  capability: string;
  proposalId?: string;
  toolCallId?: string;
  message?: string;
};
type TurnUndo = { available: boolean; reason?: string; path?: string; undoneAt?: number; paths?: string[]; remaining?: string[] };
export type TurnActivity = {
  turnId: string;
  startedAt: number;
  endedAt?: number;
  outcome: TurnOutcome | "pending";
  reason?: TurnEndReason;
  responder: TurnResponder;
  mode: BridleMode;
  checkpointId?: string;
  counts: { read: number; created: number; modified: number; moved: number; trashed: number; deleted: number };
  items: TurnActivityItem[];
  undo: TurnUndo;
};
export type UndoTurnResult =
  | { undone: true; turnIds: string[]; paths: string[]; alreadyRestored?: true }
  | { undone: false; reason: "turn-active" | "already-undone" | "later-turns-exist" | "unknown-turn" | "undo-unavailable" | "unrestorable-file" | "outside-workspace" | "partially-undone" | "journal-damaged" | "store-read-only" | "adoption-in-flight"; path?: string; laterTurnIds?: string[]; resumeRequires?: { includingLater: true } };
export type BridleTurns = {
  list(): Promise<TurnActivity[]>;
  get(turnId: string): Promise<TurnActivity | undefined>;
  undo(turnId: string, opts?: { includingLater?: boolean }): Promise<UndoTurnResult>;
};
type State = {
  order: number;
  activity: TurnActivity;
  sessionId: string;
  restorePointId?: string;
  snapshotIds: string[];
  expected: Record<string, string>;
  before: Record<string, string>;
  writeOrder: Record<string, number>;
  checkpointUnrestorable: string[];
  oversizedAfter: string[];
  outsideWrites: string[];
};
export type TurnVersionRestore = {
  checkpointId: string;
  paths: string[];
  sourceCheckpoints: Record<string, string>;
  guard(): Promise<void>;
};
type Deps = {
  root?: string;
  recorder: RecorderStore | null;
  snapshots: SnapshotStore;
  versioning?: BridleVersioning;
  largeFileCeiling?: number;
  restoreVersion?: (options: TurnVersionRestore) => Promise<BridleVersioningRestoreResult>;
  audit(event: AuditEvent): Promise<void>;
  emit(activity: TurnActivity): void;
  active(): string | null;
  writable?(): Promise<boolean>;
  cancel(turnId: string): Promise<"store-read-only" | "adoption-in-flight" | void>;
};

function pathRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Evidence, activity and undo coordination; the stores own all restore writes. */
export class TurnHistory {
  private readonly states = new Map<string, State>();
  private writeSequence = 0;
  private readonly intents = new Map<string, SnapshotUndoIntent>();
  private readonly corruptIntentTurns = new Set<string>();

  constructor(private readonly deps: Deps) {}

  async load(): Promise<void> {
    const recorder = this.deps.recorder;
    const events: AuditEvent[] = [];
    if (recorder) {
      for (const name of (await readdir(recorder.auditDir)).sort()) {
        if (name.endsWith(".jsonl")) events.push(...await recorder.readJsonl(join(recorder.auditDir, name)) as AuditEvent[]);
      }
    }
    events.sort((left, right) => left.timestamp - right.timestamp);
    for (const event of events) {
      if (event.type !== "turn.activity" || !event.metadata || event.metadata.workspaceRoot !== this.deps.root || !event.metadata.state) continue;
      this.loadState(event.metadata.state as State);
    }
    const recovery = await snapshotUndoIntents(this.deps.snapshots);
    for (const id of recovery.corruptTurnIds) {
      this.corruptIntentTurns.add(id);
      const state = this.states.get(id);
      if (state && !state.activity.undo.undoneAt) state.activity.undo = { available: false, reason: "corrupt-intent" };
    }
    for (const intent of recovery.intents) {
      if (intent.workspaceRoot !== this.deps.root) continue;
      const saved = intent.states as State[];
      const superseded = saved.some((state) => {
        const current = this.states.get(state.activity.turnId);
        return current && (current.activity.undo.undoneAt || current.activity.undo.reason === "partially-undone" || !this.sameWriteEvidence(current, state));
      });
      if (superseded || saved.some((state) => this.corruptIntentTurns.has(state.activity.turnId))) {
        await settleSnapshotUndoIntent(this.deps.snapshots, intent.requestedTurnId, "abandoned");
        continue;
      }
      this.intents.set(intent.requestedTurnId, intent);
      // Recovery may fill absent history (recording off), never replace audit state.
      for (const state of saved) {
        if (!this.states.has(state.activity.turnId)) this.loadState(state);
      }
    }
    for (const state of this.states.values()) {
      if (state.activity.outcome !== "pending") continue;
      state.activity.outcome = "error";
      state.activity.reason = "tool-error";
      const reason = state.activity.undo.reason;
      state.activity.undo = { available: false, reason: reason === "legacy-record" || reason === "corrupt-intent" ? reason : "incomplete-turn" };
    }
  }

  private sameWriteEvidence(current: State, saved: State): boolean {
    const sameMap = (left: Record<string, unknown>, right: Record<string, unknown>): boolean =>
      Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([path, value]) => right[path] === value);
    return current.restorePointId === saved.restorePointId && current.activity.checkpointId === saved.activity.checkpointId
      && sameMap(current.expected, saved.expected) && sameMap(current.before, saved.before)
      && sameMap(current.writeOrder, saved.writeOrder) && current.snapshotIds.length === saved.snapshotIds.length
      && current.snapshotIds.every((id, index) => saved.snapshotIds[index] === id);
  }

  private async abandonIntent(id: string, settleCompleted = true, cancellationRefused = false): Promise<void> {
    const intent = this.intents.get(id);
    if (!intent) return;
    const progress = await this.intentProgress(intent);
    // A failed cancellation/history write keeps the ordinary idempotent retry;
    // abandonment by a new turn or another undo settles completed restores.
    if (progress && progress.paths.length && (progress.remaining.length || settleCompleted)) {
      for (const saved of intent.states as State[]) {
        const state = this.states.get(saved.activity.turnId);
        if (!state || state.activity.undo.undoneAt || !Object.keys(saved.expected).length) continue;
        const owns = (path: string): boolean => Object.hasOwn(saved.expected, path);
        const paths = progress.paths.filter(owns);
        const remaining = progress.remaining.filter(owns);
        if (!paths.length) continue;
        if (remaining.length || cancellationRefused) {
          state.activity.undo = { available: false, reason: "partially-undone", paths, remaining };
        } else {
          if (await this.deps.cancel(state.activity.turnId)) {
            state.activity.undo = { available: false, reason: "partially-undone", paths, remaining };
          } else {
            state.activity.undo = { available: false, reason: "already-undone", undoneAt: Date.now() };
            await this.deps.audit({ type: "turn.undo", timestamp: Date.now(), sessionId: state.sessionId,
              turnId: state.activity.turnId, metadata: { requestedTurnId: id, interruptedRestoreCompleted: true } });
          }
        }
        await this.publish(state);
      }
      await this.deps.recorder?.flush();
    }
    await settleSnapshotUndoIntent(this.deps.snapshots, id, "abandoned");
    this.intents.delete(id);
  }

  private async abandonIntents(except?: string): Promise<void> {
    for (const id of this.intents.keys()) {
      if (id !== except) await this.abandonIntent(id);
    }
  }

  private loadState(stored: State): void {
    const expected = this.safeIdentities(stored.expected);
    const writeOrder = pathRecord<number>();
    const activity = structuredClone(stored.activity);
    activity.items = activity.items.map((item) => this.sanitizeStoredItem(item));
    let legacy = !stored.writeOrder;
    for (const path of Object.keys(expected)) {
      const order = stored.writeOrder?.[path];
      if (order === undefined) {
        legacy = true;
        continue;
      }
      writeOrder[path] = order;
      this.writeSequence = Math.max(this.writeSequence, order);
    }
    if (legacy) activity.undo = { available: false, reason: "legacy-record" };
    this.states.set(activity.turnId, {
      order: stored.order, activity, sessionId: stored.sessionId,
      restorePointId: stored.restorePointId, snapshotIds: stored.snapshotIds,
      expected, before: this.safeIdentities(stored.before), writeOrder,
      checkpointUnrestorable: stored.checkpointUnrestorable, oversizedAfter: stored.oversizedAfter,
      outsideWrites: stored.outsideWrites,
    });
  }

  async activePath(): Promise<string | undefined> {
    const active = this.deps.active();
    return active ? snapshotRestorePointPath(this.deps.snapshots, this.states.get(active)?.restorePointId) : undefined;
  }

  private safeIdentities(identities: Record<string, string>): Record<string, string> {
    const safe = pathRecord<string>();
    for (const [path, identity] of Object.entries(identities)) {
      if (!safeRelativePath(path)) continue;
      safe[path] = identity;
    }
    return safe;
  }

  private sanitizeStoredItem(item: TurnActivityItem): TurnActivityItem {
    const outside = [item.path, item.toPath].some((path) => path !== undefined && path !== "." && !safeRelativePath(path));
    return {
      ...item,
      ...(outside ? { kind: "outside" } : {}),
      ...(item.path !== undefined ? { path: outside ? basename(item.path) : item.path } : {}),
      ...(item.toPath !== undefined ? { toPath: outside ? basename(item.toPath) : item.toPath } : {}),
    };
  }

  private ordered(): State[] {
    return [...this.states.values()].sort((left, right) => left.order - right.order);
  }

  private changed(state: State): boolean {
    return Object.keys(state.expected).length > 0 || state.outsideWrites.length > 0
      || state.activity.items.some((item) => ["created", "modified", "moved", "trashed", "deleted"].includes(item.kind));
  }

  private unavailable(state: State): TurnUndo | undefined {
    const outside = state.outsideWrites[0];
    if (outside) return { available: false, reason: "outside-workspace", path: outside };
    const unrestorable = Object.keys(state.expected).find((path) => state.checkpointUnrestorable.includes(path) || state.oversizedAfter.includes(path));
    if (unrestorable) return { available: false, reason: "unrestorable-file", path: unrestorable };
    return undefined;
  }

  private async view(state: State): Promise<TurnActivity> {
    const activity = structuredClone(state.activity);
    if (!activity.undo.available) return activity;
    const unavailable = this.unavailable(state);
    if (unavailable) activity.undo = unavailable;
    else if (this.ordered().some((candidate) => candidate.order > state.order && !candidate.activity.undo.undoneAt && this.changed(candidate))) {
      activity.undo = { available: false, reason: "later-turns-exist" };
    } else if (!this.versionedRestore([state]) && state.restorePointId
      && await snapshotJournalDamaged(this.deps.snapshots, state.restorePointId)) {
      activity.undo = { available: false, reason: "journal-damaged" };
    }
    return activity;
  }

  list = async (): Promise<TurnActivity[]> => Promise.all(this.ordered().reverse().map((state) => this.view(state)));

  get = async (id: string): Promise<TurnActivity | undefined> => {
    const state = this.states.get(id);
    return state ? this.view(state) : undefined;
  };

  async start(activity: Pick<TurnActivity, "turnId" | "startedAt" | "mode" | "responder">, sessionId: string): Promise<void> {
    await this.abandonIntents();
    const order = Math.max(0, ...[...this.states.values()].map((state) => state.order)) + 1;
    const state: State = {
      order, sessionId,
      activity: {
        ...activity, outcome: "pending", items: [],
        counts: { read: 0, created: 0, modified: 0, moved: 0, trashed: 0, deleted: 0 },
        undo: { available: false, reason: "turn-active" },
      },
      snapshotIds: [], expected: pathRecord<string>(), before: pathRecord<string>(), writeOrder: pathRecord<number>(),
      checkpointUnrestorable: [], oversizedAfter: [], outsideWrites: [],
    };
    this.states.set(activity.turnId, state);
    await this.publish(state);
  }

  async protect(id: string, restorePointId: string, checkpointId?: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error("Cannot protect an unknown turn.");
    state.restorePointId = restorePointId;
    if (checkpointId) await this.checkpoint(id, checkpointId);
  }

  async checkpoint(id: string | undefined, checkpointId: string): Promise<void> {
    const state = id ? this.states.get(id) : undefined;
    const versioning = this.deps.versioning;
    if (!state || state.activity.checkpointId || !versioning) return;
    const checkpoint = (await versioning.checkpoints()).find((candidate) => candidate.id === checkpointId);
    if (!checkpoint) throw new Error("Turn checkpoint disappeared before execution.");
    state.activity.checkpointId = checkpointId;
    state.checkpointUnrestorable = checkpoint.entries.filter((entry) => entry.unrestorable).map((entry) => entry.relPath);
  }

  private item(kind: TurnActivityItem["kind"], capability: string, path?: string, toPath?: string): TurnActivityItem {
    const from = path === undefined ? undefined : workspaceRelativePath(this.deps.root, path);
    const to = toPath === undefined ? undefined : workspaceRelativePath(this.deps.root, toPath);
    const outside = path !== undefined && from === undefined || toPath !== undefined && to === undefined;
    return {
      kind: outside ? "outside" : kind, capability,
      ...(path !== undefined ? { path: outside ? basename(path) : from || "." } : {}),
      ...(toPath !== undefined ? { toPath: outside ? basename(toPath) : to || "." } : {}),
    };
  }

  async contextReads(id: string, paths: string[], capability: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    state.activity.items.push(...paths.map((path) => this.item("read", capability, path)));
    if (paths.length) await this.publish(state);
  }

  async end(id: string, outcome: TurnOutcome, reason?: TurnEndReason, toolErrors: TurnToolError[] = []): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    for (const error of toolErrors) this.toolError(state, error);
    Object.assign(state.activity, { endedAt: Date.now(), outcome, ...(reason ? { reason } : {}) });
    state.activity.undo = state.restorePointId && this.deps.root
      ? this.unavailable(state) ?? { available: true }
      : { available: false, reason: "undo-unavailable" };
    await this.publish(state);
  }

  async executed(id: string | undefined, cap: Capability, input: unknown, paths: readonly string[], before: Map<string, string>, snapshotIds: string[], succeeded: boolean): Promise<void> {
    const state = id ? this.states.get(id) : undefined;
    if (!state) return;
    const after = await captureTurnPaths(paths);
    if (cap.risk !== "read") {
      state.snapshotIds.push(...snapshotIds);
      await this.recordWrites(state, before, after);
    }
    if (succeeded) this.recordItems(state, cap, input, paths, before, after);
    if (state.activity.endedAt && !state.activity.undo.undoneAt && state.activity.undo.reason !== "partially-undone") {
      state.activity.undo = this.unavailable(state) ?? { available: true };
    }
    await this.publish(state);
  }

  private async recordWrites(state: State, before: Map<string, string>, after: Map<string, string>): Promise<void> {
    const paths = new Set([...before.keys(), ...after.keys()]);
    const order = ++this.writeSequence;
    for (const path of paths) {
      const previous = before.get(path) ?? ABSENT_PATH;
      const current = after.get(path) ?? ABSENT_PATH;
      if (previous === current) continue;
      const relative = workspaceRelativePath(this.deps.root, path);
      if (relative === undefined) {
        state.outsideWrites = [...new Set([...state.outsideWrites, basename(path)])];
        continue;
      }
      if (!relative) continue;
      state.before[relative] ??= previous;
      state.expected[relative] = current;
      state.writeOrder[relative] = order;
      const ceiling = this.deps.largeFileCeiling;
      if (ceiling === undefined || !this.deps.versioning) continue;
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      state.oversizedAfter = state.oversizedAfter.filter((candidate) => candidate !== relative);
      if (stat?.isFile() && stat.size > ceiling) state.oversizedAfter.push(relative);
    }
  }

  private recordItems(state: State, cap: Capability, input: unknown, paths: readonly string[], before: Map<string, string>, after: Map<string, string>): void {
    const operations = cap.risk === "read" ? undefined : cap.renderOps?.(input);
    if (operations?.length) {
      for (const operation of operations) {
        const kind = operation.op === "create" ? "created" : operation.op === "modify" ? "modified"
          : operation.op === "delete" ? "deleted" : cap.risk === "destructive" ? "trashed" : "moved";
        state.activity.items.push(this.item(kind, cap.name, operation.path, operation.toPath));
      }
      return;
    }
    const reversals = cap.renderUndo?.(input)?.filter((action) => action.do === "rename");
    if (reversals?.length) {
      const kind = cap.risk === "destructive" ? "trashed" : "moved";
      for (const action of reversals) {
        state.activity.items.push(this.item(kind, cap.name, action.to, action.from));
      }
      return;
    }
    for (const path of paths) {
      const kind = cap.risk === "read" ? "read" : after.get(path) === ABSENT_PATH ? "deleted"
        : before.get(path) === ABSENT_PATH ? "created" : "modified";
      state.activity.items.push(this.item(kind, cap.name, path));
    }
  }

  async observe(event: AuditEvent): Promise<void> {
    const state = event.turnId ? this.states.get(event.turnId) : undefined;
    if (!state) return;
    if (event.type === "capability.failed" || event.type === "approval.observer_error" || event.type === "capability.executed" && event.resultIsError) {
      this.toolError(state, { capability: event.capability, toolCallId: event.toolCallId, message: event.resultText ?? event.message ?? "Approval observer failed." });
    } else if (event.type === "policy.decision" && (event.message === "deny" || event.message === "ask")) {
      const previous = state.activity.items.at(-1);
      if (event.message === "deny" && previous?.kind === "refused" && previous.capability === event.capability) return;
      state.activity.items.push({ kind: event.message === "ask" ? "asked" : "refused", capability: event.capability ?? "unknown" });
    } else if (event.type === "proposal_created") {
      const proposal = event.metadata?.proposal as { id: string; baseline?: { path: string }[] };
      const waiting = this.item("waiting", event.capability ?? "unknown", proposal.baseline?.[0]?.path);
      state.activity.items.push({ ...waiting, proposalId: proposal.id });
    } else if (event.type === "proposal_settled") {
      state.activity.items = state.activity.items.filter((item) => item.proposalId !== event.metadata?.proposalId || item.kind !== "waiting");
    } else return;
    await this.publish(state);
  }

  private toolError(state: State, error: TurnToolError): void {
    const capability = error.capability ?? "unknown";
    const recorded = state.activity.items.some((item) => item.kind === "tool-error" && (error.toolCallId
      ? item.toolCallId === error.toolCallId : item.capability === capability && item.message === error.message));
    if (recorded) return;
    state.activity.items.push({ kind: "tool-error", capability, message: error.message, ...(error.toolCallId ? { toolCallId: error.toolCallId } : {}) });
  }

  private async publish(state: State): Promise<void> {
    for (const kind of Object.keys(state.activity.counts) as (keyof TurnActivity["counts"])[]) {
      state.activity.counts[kind] = state.activity.items.filter((item) => item.kind === kind).length;
    }
    await this.deps.audit({
      type: "turn.activity", timestamp: Date.now(), sessionId: state.sessionId, turnId: state.activity.turnId,
      metadata: { workspaceRoot: this.deps.root, state: structuredClone(state) },
    });
    this.deps.emit(await this.view(state));
  }

  private latestExpectations(paths: string[]): Map<string, string> {
    const latest = new Map<string, { order: number; identity: string }>();
    for (const state of this.states.values()) {
      if (state.activity.undo.undoneAt) continue;
      for (const path of paths) {
        const identity = state.expected[path];
        const order = state.writeOrder[path];
        if (identity === undefined || order === undefined) continue;
        if (order > (latest.get(path)?.order ?? -1)) latest.set(path, { order, identity });
      }
    }
    return new Map([...latest].map(([path, entry]) => [path, entry.identity]));
  }

  /** One comparison rule for the drift guard, interrupted recovery and progress. */
  private async compareUndoPath(root: string, path: string, expected?: string, target?: string): Promise<{ atExpected: boolean; atTarget: boolean }> {
    const absolute = resolve(root, path);
    if (workspaceRelativePath(root, absolute) === undefined) return { atExpected: false, atTarget: false };
    const current = await turnPathIdentity(absolute);
    return { atExpected: expected !== undefined && current === expected, atTarget: target !== undefined && current === target };
  }

  private async guard(root: string, restorePointId: string, expected: Map<string, string>, restored?: Map<string, string>): Promise<void> {
    const refusals: { path: string; reason: string }[] = [];
    for (const [path, identity] of expected) {
      const match = await this.compareUndoPath(root, path, identity, restored?.get(path));
      if (!match.atExpected && !match.atTarget) refusals.push({ path, reason: "changed-after-turn" });
    }
    if (refusals.length) throw new RestoreRefusedError(restorePointId, refusals);
  }

  /** Check every hand-off, not only the head: a later agent write cannot erase user drift. */
  private undoTargets(selected: State[], restorePointId: string): Map<string, string> {
    const paths = new Set(selected.flatMap((candidate) => Object.keys(candidate.expected)));
    const targets = new Map<string, string>();
    const refusals: { path: string; reason: string }[] = [];
    for (const path of paths) {
      const writers = selected.flatMap((candidate) => {
        const expected = candidate.expected[path];
        if (expected === undefined) return [];
        const before = candidate.before[path];
        const order = candidate.writeOrder[path];
        if (before === undefined || order === undefined) throw new Error(`Turn write evidence missing for ${path}`);
        return [{ before, expected, order }];
      }).sort((left, right) => right.order - left.order);
      for (let index = 0; index < writers.length - 1; index++) {
        const newer = writers[index];
        const older = writers[index + 1];
        if (newer && older && newer.before !== older.expected) {
          refusals.push({ path, reason: "changed-after-turn" });
          break;
        }
      }
      const oldest = writers.at(-1);
      if (oldest) targets.set(path, oldest.before);
    }
    if (refusals.length) throw new RestoreRefusedError(restorePointId, refusals);
    return targets;
  }

  private async matches(root: string, targets: Map<string, string>): Promise<boolean> {
    for (const [path, identity] of targets) {
      const absolute = resolve(root, path);
      if (workspaceRelativePath(root, absolute) === undefined || await turnPathIdentity(absolute) !== identity) return false;
    }
    return true;
  }

  private async snapshotSelection(selected: State[], changedPaths: Set<string>): Promise<string[]> {
    const entries = new Map((await this.deps.snapshots.entries()).map((entry) => [entry.id, entry]));
    const intersects = (path: string): boolean => {
      const relative = workspaceRelativePath(this.deps.root, path);
      return relative !== undefined && changedPaths.has(relative);
    };
    const relevant = (entry: JournalEntry): boolean => {
      if (entry.kind === "snapshot") return intersects(entry.file);
      if (entry.kind !== "undo-action") return false;
      return entry.action.do === "remove" ? intersects(entry.action.path) : intersects(entry.action.from) || intersects(entry.action.to);
    };
    return [...new Set(selected.flatMap((state) => state.snapshotIds))].filter((id) => {
      const entry = entries.get(id);
      return !entry || relevant(entry);
    });
  }

  private async intentProgress(intent: SnapshotUndoIntent): Promise<{ paths: string[]; remaining: string[]; safe: boolean } | undefined> {
    const root = this.deps.root;
    if (!root) return undefined;
    let targets: Map<string, string>;
    try { targets = this.undoTargets(intent.states as State[], intent.requestedTurnId); }
    catch { return undefined; }
    const paths: string[] = [];
    const remaining: string[] = [];
    let safe = true;
    for (const [path, target] of targets) {
      const after = intent.expected[path];
      const match = await this.compareUndoPath(root, path, after, target).catch(() => ({ atExpected: false, atTarget: false }));
      if (!match.atTarget && !match.atExpected) safe = false;
      if (target === after) continue;
      if (match.atTarget) paths.push(path);
      else remaining.push(path);
    }
    return { paths, remaining, safe };
  }

  /** Retain recovery authority only while an interrupted restore is genuinely partial. */
  private async interruptedRestore(id: string): Promise<boolean> {
    const intent = this.intents.get(id);
    if (!intent) return false;
    const progress = await this.intentProgress(intent);
    return progress !== undefined && progress.safe && progress.paths.length > 0 && progress.remaining.length > 0;
  }

  async undo(id: string, opts?: { includingLater?: boolean }): Promise<UndoTurnResult> {
    if (this.deps.writable && !await this.deps.writable()) return { undone: false, reason: "store-read-only" };
    try {
      const result = await this.performUndo(id, opts);
      if (!result.undone && !result.resumeRequires) await this.abandonIntent(id);
      return result;
    } catch (error) {
      if (error instanceof RestoreRefusedError || !await this.interruptedRestore(id)) {
        await this.abandonIntent(id, error instanceof RestoreRefusedError);
      }
      if (error instanceof RestoreRefusedError && error.reason === "journal-damaged") {
        return { undone: false, reason: "journal-damaged" };
      }
      throw error;
    }
  }

  private versionedRestore(selected: State[]): boolean {
    const paths = selected.flatMap((state) => Object.keys(state.expected));
    return paths.length > 0 && this.deps.restoreVersion !== undefined
      && paths.every((path) => selected.some((state) => Object.hasOwn(state.expected, path) && state.activity.checkpointId));
  }

  private async performUndo(id: string, opts?: { includingLater?: boolean }): Promise<UndoTurnResult> {
    if (this.deps.active()) return { undone: false, reason: "turn-active" };
    const state = this.states.get(id);
    if (this.corruptIntentTurns.has(id) && !state?.activity.undo.undoneAt) return { undone: false, reason: "undo-unavailable" };
    if (!state) return { undone: false, reason: "unknown-turn" };
    if (state.activity.undo.undoneAt) return { undone: false, reason: "already-undone" };
    if (state.activity.undo.reason === "partially-undone") return { undone: false, reason: "partially-undone" };
    const unavailable = this.unavailable(state);
    if (unavailable?.reason === "unrestorable-file" || unavailable?.reason === "outside-workspace") {
      return { undone: false, reason: unavailable.reason, path: unavailable.path };
    }
    const root = this.deps.root;
    const restorePointId = state.restorePointId;
    if (!state.activity.undo.available || !root || !restorePointId) return { undone: false, reason: "undo-unavailable" };
    const later = this.ordered().filter((candidate) => candidate.order > state.order && !candidate.activity.undo.undoneAt).reverse();
    const laterWrites = later.filter((candidate) => this.changed(candidate));
    const pendingIntent = this.intents.get(id);
    if (laterWrites.length && !opts?.includingLater) {
      const canResumeChain = pendingIntent && laterWrites.every((candidate) => pendingIntent.turnIds.includes(candidate.activity.turnId));
      return { undone: false, reason: "later-turns-exist", laterTurnIds: laterWrites.map((candidate) => candidate.activity.turnId),
        ...(canResumeChain ? { resumeRequires: { includingLater: true as const } } : {}),
      };
    }
    let selected = [...(opts?.includingLater ? later : []), state];
    if (pendingIntent) {
      const candidates = pendingIntent.turnIds.map((turnId) => this.states.get(turnId));
      if (candidates.some((candidate) => !candidate)) return { undone: false, reason: "undo-unavailable" };
      selected = candidates.filter((candidate): candidate is State => candidate !== undefined);
      if (selected.some((candidate) => candidate.activity.undo.undoneAt)) return { undone: false, reason: "undo-unavailable" };
    }
    for (const candidate of selected) {
      if (candidate.activity.undo.reason === "partially-undone") return { undone: false, reason: "partially-undone" };
      if (candidate.activity.undo.reason === "legacy-record" || this.corruptIntentTurns.has(candidate.activity.turnId)) {
        return { undone: false, reason: "undo-unavailable" };
      }
      const problem = this.unavailable(candidate);
      if (problem?.reason === "unrestorable-file" || problem?.reason === "outside-workspace") return { undone: false, reason: problem.reason, path: problem.path };
    }
    if (!this.versionedRestore(selected) && await snapshotJournalDamaged(this.deps.snapshots, restorePointId)) {
      return { undone: false, reason: "journal-damaged" };
    }
    const targets = this.undoTargets(selected, restorePointId);
    const changedPaths = new Set(targets.keys());
    const alreadyRestored = await this.matches(root, targets);
    const expected = pendingIntent ? new Map(Object.entries(this.safeIdentities(pendingIntent.expected))) : this.latestExpectations([...changedPaths]);
    const guard = () => this.guard(root, restorePointId, expected, this.intents.has(id) ? targets : undefined);
    if (!alreadyRestored) await guard();
    const remainingPaths = new Set<string>();
    for (const path of changedPaths) {
      if (!pendingIntent || await turnPathIdentity(resolve(root, path)) !== targets.get(path)) remainingPaths.add(path);
    }
    const sources = pathRecord<string>();
    for (const candidate of [...selected].reverse()) {
      const checkpointId = candidate.activity.checkpointId;
      if (!checkpointId) continue;
      for (const path of Object.keys(candidate.expected)) {
        sources[path] ??= checkpointId;
      }
    }
    const checkpointId = Object.values(sources)[0];
    const restoreVersion = this.deps.restoreVersion;
    const allVersioned = [...changedPaths].every((path) => sources[path] !== undefined);
    const persistIntent = async (): Promise<void> => {
      if (this.intents.has(id)) return;
      const intent: SnapshotUndoIntent = {
        requestedTurnId: id, workspaceRoot: root,
        turnIds: selected.map((candidate) => candidate.activity.turnId),
        expected: Object.fromEntries(expected),
        states: selected.map((candidate) => structuredClone(candidate)),
      };
      await persistSnapshotUndoIntent(this.deps.snapshots, intent);
      this.intents.set(id, intent);
    };
    let notRecorded: RestoreNotRecordedError | undefined;
    let restoredPaths: string[] = [];
    if (alreadyRestored) {
      // A previous attempt may have restored everything and failed during settlement.
      // Finish cancellation and persistence below without replaying structural undo.
    } else if (changedPaths.size && checkpointId && restoreVersion && allVersioned) {
      await persistIntent();
      await restoreVersion({ checkpointId, paths: [...remainingPaths], sourceCheckpoints: sources, guard });
      restoredPaths = [...remainingPaths];
    } else {
      const snapshotIds = await this.snapshotSelection(selected, remainingPaths);
      const plan = await planSnapshotRestore(this.deps.snapshots, restorePointId, { entryIds: snapshotIds });
      if (plan.kind === "refusal") throw new RestoreRefusedError(restorePointId, plan.refusals);
      await guard();
      await persistIntent();
      try {
        const restored = await this.deps.snapshots.restoreTo(restorePointId, { entryIds: snapshotIds });
        restoredPaths = restored.map((path) => workspaceRelativePath(root, path) ?? basename(path));
      } catch (error) {
        if (!(error instanceof RestoreNotRecordedError)) throw error;
        restoredPaths = error.restored.map((path) => workspaceRelativePath(root, path) ?? basename(path));
        notRecorded = error;
      }
    }
    // Cancellation and history settlement follow a completed restore only.
    for (const candidate of selected) {
      const cancellationRefusal = await this.deps.cancel(candidate.activity.turnId);
      if (cancellationRefusal) {
        await this.abandonIntent(id, true, true);
        return { undone: false, reason: cancellationRefusal };
      }
    }
    const previousUndo = selected.map((candidate) => candidate.activity.undo);
    try {
      const undoneAt = Date.now();
      for (const candidate of selected) {
        candidate.activity.undo = { available: false, reason: "already-undone", undoneAt };
      }
      for (const candidate of selected) {
        await this.deps.audit({ type: "turn.undo", timestamp: Date.now(), sessionId: candidate.sessionId, turnId: candidate.activity.turnId, metadata: { requestedTurnId: id, includingLater: opts?.includingLater === true } });
        await this.publish(candidate);
      }
      await this.deps.recorder?.flush();
      await settleSnapshotUndoIntent(this.deps.snapshots, id);
      this.intents.delete(id);
      await this.abandonIntents();
    } catch (error) {
      // Keep an in-process retry possible too; the files already match targets.
      selected.forEach((candidate, index) => {
        const previous = previousUndo[index];
        if (previous) candidate.activity.undo = previous;
      });
      throw error;
    }
    if (notRecorded) throw notRecorded;
    return { undone: true, turnIds: selected.map((candidate) => candidate.activity.turnId), paths: [...new Set(restoredPaths)], ...(alreadyRestored ? { alreadyRestored: true as const } : {}) };
  }
}
