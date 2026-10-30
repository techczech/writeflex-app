import { isAbsolute } from "node:path";
import { safeRelativePath } from "./turn-paths.ts";

/** Only the evidence needed to resume one interrupted undo. */
export type SnapshotUndoIntent = {
  requestedTurnId: string;
  workspaceRoot: string;
  turnIds: string[];
  expected: Record<string, string>;
  states: unknown[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const optionalText = (value: unknown): boolean => value === undefined || typeof value === "string";
const optionalNumber = (value: unknown): boolean => value === undefined || number(value);
const oneOf = (value: unknown, choices: readonly string[]): boolean => typeof value === "string" && choices.includes(value);
const identity = (value: unknown): boolean => typeof value === "string"
  && /^(?:ABSENT|directory|[a-f0-9]{64}|symlink-sha256:[a-f0-9]{64}|special:\d+)$/.test(value);
function pathMap(value: unknown, validValue: (value: unknown) => boolean): value is Record<string, unknown> {
  return record(value) && Object.entries(value).every(([path, item]) => safeRelativePath(path) && validValue(item));
}

function validState(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !number(value.order) || !Number.isSafeInteger(value.order) || value.order < 1
    || !text(value.sessionId) || !text(value.restorePointId)
    || !strings(value.snapshotIds) || !strings(value.checkpointUnrestorable)
    || !strings(value.oversizedAfter) || !strings(value.outsideWrites)
    || !pathMap(value.expected, identity) || !pathMap(value.before, identity)
    || !pathMap(value.writeOrder, (order) => number(order) && Number.isSafeInteger(order) && order > 0)) return false;
  for (const path of Object.keys(value.expected)) {
    if (!Object.hasOwn(value.before, path) || !Object.hasOwn(value.writeOrder, path)) return false;
  }
  const activity = value.activity;
  if (!record(activity) || !text(activity.turnId) || !number(activity.startedAt) || !optionalNumber(activity.endedAt)
    || !oneOf(activity.outcome, ["completed", "aborted", "error", "pending"])
    || !oneOf(activity.mode, ["work", "suggest", "read-only"]) || !optionalText(activity.checkpointId)
    || !record(activity.counts) || !record(activity.responder) || !record(activity.undo)
    || typeof activity.undo.available !== "boolean" || !optionalText(activity.undo.reason)
    || !optionalNumber(activity.undo.undoneAt) || !Array.isArray(activity.items)) return false;
  const counts = activity.counts;
  if (!["read", "created", "modified", "moved", "trashed", "deleted"].every((key) => number(counts[key]))) return false;
  const responder = activity.responder;
  if (!text(responder.providerId) || !text(responder.modelId) || !oneOf(responder.authLane, ["oauth", "apikey", "env", "none"])) return false;
  return activity.items.every((item) => record(item) && text(item.capability)
    && oneOf(item.kind, ["read", "created", "modified", "moved", "trashed", "deleted", "waiting", "asked", "refused", "tool-error", "outside"])
    && optionalText(item.path) && optionalText(item.toPath));
}

export function isSnapshotUndoIntent(value: unknown): value is SnapshotUndoIntent {
  if (!record(value) || !text(value.requestedTurnId) || !text(value.workspaceRoot) || !isAbsolute(value.workspaceRoot)
    || !strings(value.turnIds) || !value.turnIds.length || new Set(value.turnIds).size !== value.turnIds.length
    || !value.turnIds.includes(value.requestedTurnId) || !pathMap(value.expected, identity)
    || !Array.isArray(value.states) || !value.states.every(validState)) return false;
  const stateIds = value.states.map((state) => (state.activity as Record<string, unknown>).turnId);
  if (new Set(stateIds).size !== stateIds.length || stateIds.length !== value.turnIds.length
    || !value.turnIds.every((id) => stateIds.includes(id))) return false;
  const paths = new Set(value.states.flatMap((state) => Object.keys(state.expected as Record<string, unknown>)));
  const expected = value.expected;
  return paths.size === Object.keys(expected).length && [...paths].every((path) => expected[path] !== undefined);
}

/** Recover only turn ids, even when the rest of the recovery record is damaged. */
export function affectedIntentTurns(value: unknown): string[] {
  if (!record(value)) return [];
  const intent = record(value.intent) ? value.intent : {};
  const ids: unknown[] = [intent.requestedTurnId];
  if (Array.isArray(value.turnIds)) ids.push(...value.turnIds);
  if (Array.isArray(intent.turnIds)) ids.push(...intent.turnIds);
  if (Array.isArray(intent.states)) {
    for (const state of intent.states) {
      if (record(state) && record(state.activity)) ids.push(state.activity.turnId);
    }
  }
  return [...new Set(ids.filter(text))];
}
