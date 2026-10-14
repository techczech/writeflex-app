/**
 * Phase 2 lock discipline is deliberately fail-closed. A structurally valid
 * active claim in `.lock.mutation.journal` has no expiry and no automatic repair
 * path: journal poisoning therefore blocks reclamation until a later design adds
 * an authenticated repair protocol.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";

type LockRecord = { pid: number; startedAt: number };
type MutationJournalRecord =
  | { type: "claim"; token: string; owner: LockRecord }
  | { type: "release"; token: string };

type VersioningLockClientOptions = {
  owner: LockRecord;
  pidIsAlive: (pid: number) => boolean;
  /** Narrow test seam for deterministic lock-creation races. */
  createLockFile?: (lockPath: string, owner: LockRecord) => Promise<void>;
  afterLockConflictDetected?: () => void | Promise<void>;
  afterUnreadableLockObserved?: () => void | Promise<void>;
  afterStaleOwnerObserved?: (owner: LockRecord) => void | Promise<void>;
  beforeStaleOwnerRemoval?: (owner: LockRecord) => void | Promise<void>;
  appendMutationJournalRecord?: (
    journalPath: string,
    record: MutationJournalRecord,
  ) => Promise<void>;
};

class InProcessMutex {
  pending = 0;
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const mutexes = new Map<string, InProcessMutex>();
const UNREADABLE_LOCK_GRACE_MS = 5_000;
const UNREADABLE_LOCK_RETRY_DELAY_MS = 20;
const LOCK_CREATION_ATTEMPT_LIMIT = 5;
const LOCK_CREATION_RETRY_DELAY_MS = 10;

export type VersioningLockErrorReason =
  | "live-holder"
  | "unreadable-record"
  | "transient-exhaustion"
  | "reclaim-race";

export class VersioningLockError extends Error {
  readonly reason: VersioningLockErrorReason;
  readonly holderPid: number | null;
  readonly observedPid: number | null;

  constructor(holderPid: number | null);
  constructor(reason: VersioningLockErrorReason, observedPid?: number | null);
  constructor(
    reasonOrHolderPid: VersioningLockErrorReason | number | null,
    observedPid: number | null = null,
  ) {
    const reason = typeof reasonOrHolderPid === "string"
      ? reasonOrHolderPid
      : reasonOrHolderPid === null
        ? "unreadable-record"
        : "live-holder";
    const observed = typeof reasonOrHolderPid === "number"
      ? reasonOrHolderPid
      : observedPid;
    const message = reason === "live-holder"
      ? `The versioning store is locked by live pid ${observed}.`
      : reason === "unreadable-record"
        ? "The versioning store is locked by an unreadable lock record."
        : reason === "transient-exhaustion"
          ? `Versioning lock acquisition exhausted ${LOCK_CREATION_ATTEMPT_LIMIT} attempts because the lock kept changing transiently.`
          : observed === null
            ? "The versioning lock changed during reclaim; no readable pid was observed."
            : `The versioning lock changed during reclaim; observed pid ${observed}.`;
    super(message);
    this.name = "VersioningLockError";
    this.reason = reason;
    this.holderPid = reason === "live-holder" ? observed : null;
    this.observedPid = observed;
  }
}

type LockAcquisitionState = {
  creationAttempts: number;
  reclaimRaceRetries: number;
};

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function readRegularFileNoFollow(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile()) throw new VersioningLockError(null);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isNotFound(error)) throw error;
    throw new VersioningLockError(null);
  }
  try {
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) {
      throw new VersioningLockError(null);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function appendRegularFileNoFollow(
  path: string,
  text: string,
): Promise<void> {
  const before = await lstat(path).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (before && !before.isFile()) throw new VersioningLockError(null);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY
        | constants.O_APPEND
        | constants.O_CREAT
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if (isNotFound(error)) throw error;
    throw new VersioningLockError(null);
  }
  try {
    const after = await handle.stat();
    if (
      !after.isFile()
      || (before && (after.dev !== before.dev || after.ino !== before.ino))
    ) {
      throw new VersioningLockError(null);
    }
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

type LockRead =
  | { kind: "record"; record: LockRecord }
  | { kind: "missing" }
  | { kind: "unreadable" };

async function readLockState(lockPath: string): Promise<LockRead> {
  try {
    const value = JSON.parse(
      await readRegularFileNoFollow(lockPath),
    ) as Partial<LockRecord>;
    if (Number.isInteger(value.pid) && typeof value.startedAt === "number") {
      return {
        kind: "record",
        record: { pid: value.pid!, startedAt: value.startedAt },
      };
    }
    return { kind: "unreadable" };
  } catch (error) {
    return isNotFound(error) ? { kind: "missing" } : { kind: "unreadable" };
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  const state = await readLockState(lockPath);
  return state.kind === "record" ? state.record : null;
}

function sameLockRecord(
  candidate: LockRecord | null,
  expected: LockRecord,
): boolean {
  return candidate?.pid === expected.pid && candidate.startedAt === expected.startedAt;
}

function processPidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

async function createLockFile(lockPath: string, owner: LockRecord): Promise<void> {
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(JSON.stringify(owner));
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
}

async function createLockFileAttempt(
  lockPath: string,
  options: VersioningLockClientOptions,
  state: LockAcquisitionState,
): Promise<void> {
  if (state.creationAttempts >= LOCK_CREATION_ATTEMPT_LIMIT) {
    throw new VersioningLockError("transient-exhaustion");
  }
  state.creationAttempts += 1;
  await (options.createLockFile ?? createLockFile)(lockPath, options.owner);
}

async function waitForLockCreationRetry(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, LOCK_CREATION_RETRY_DELAY_MS);
  });
}

async function removeLockFileIfOwned(
  lockPath: string,
  owner: LockRecord,
): Promise<void> {
  const current = await readLockRecord(lockPath);
  if (sameLockRecord(current, owner)) {
    await rm(lockPath, { force: true });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function parseMutationJournalRecord(line: string): MutationJournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new VersioningLockError(null);
  }

  if (!isObject(value) || typeof value.token !== "string" || value.token.length === 0) {
    throw new VersioningLockError(null);
  }
  if (value.type === "release" && hasExactKeys(value, ["type", "token"])) {
    return { type: "release", token: value.token };
  }
  if (
    value.type === "claim"
    && hasExactKeys(value, ["type", "token", "owner"])
    && isObject(value.owner)
    && hasExactKeys(value.owner, ["pid", "startedAt"])
    && Number.isInteger(value.owner.pid)
    && typeof value.owner.startedAt === "number"
  ) {
    return {
      type: "claim",
      token: value.token,
      owner: {
        pid: value.owner.pid as number,
        startedAt: value.owner.startedAt,
      },
    };
  }
  throw new VersioningLockError(null);
}

async function readMutationJournalText(journalPath: string): Promise<string> {
  try {
    return await readRegularFileNoFollow(journalPath);
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
}

async function appendMutationJournalRecord(
  journalPath: string,
  record: MutationJournalRecord,
): Promise<void> {
  await appendRegularFileNoFollow(
    journalPath,
    `\n${JSON.stringify(record)}\n`,
  );
}

function readMutationJournal(text: string): MutationJournalRecord[] {
  const finalNewline = text.lastIndexOf("\n");
  if (finalNewline === -1) return [];

  const completeLines = text.slice(0, finalNewline).split("\n");
  const records: MutationJournalRecord[] = [];
  for (const line of completeLines) {
    if (line.length === 0) continue;
    try {
      records.push(parseMutationJournalRecord(line));
    } catch {
      // Framed appends self-synchronise at newlines. A malformed frame is a
      // torn append and cannot establish an active mutation claim.
    }
  }
  return records;
}

function electMutationClaim(
  records: MutationJournalRecord[],
  token: string,
  pidIsAlive: (pid: number) => boolean,
): void {
  const claims = new Map<
    string,
    { record: Extract<MutationJournalRecord, { type: "claim" }>; released: boolean }
  >();
  const claimOrder: Array<
    { record: Extract<MutationJournalRecord, { type: "claim" }>; released: boolean }
  > = [];

  for (const record of records) {
    if (record.type === "claim") {
      if (claims.has(record.token)) {
        throw new VersioningLockError(null);
      }
      const claim = { record, released: false };
      claims.set(record.token, claim);
      claimOrder.push(claim);
      continue;
    }

    const claim = claims.get(record.token);
    if (!claim || claim.released) {
      throw new VersioningLockError(null);
    }
    claim.released = true;
  }

  for (const claim of claimOrder) {
    if (claim.released) continue;
    if (claim.record.token === token) return;
    if (pidIsAlive(claim.record.owner.pid)) {
      throw new VersioningLockError(claim.record.owner.pid);
    }
  }

  throw new VersioningLockError(null);
}

function attachCause(error: unknown, cause: unknown): boolean {
  if (
    (typeof error !== "object" || error === null)
    && typeof error !== "function"
  ) {
    return false;
  }

  try {
    const target = error as { cause?: unknown };
    const nextCause = target.cause === undefined
      ? cause
      : new AggregateError(
        [target.cause, cause],
        "Multiple versioning lock errors occurred.",
      );
    Object.defineProperty(target, "cause", {
      configurable: true,
      writable: true,
      value: nextCause,
    });
    return true;
  } catch {
    return false;
  }
}

function combineCleanupErrors(first: unknown, second: unknown): unknown {
  if (attachCause(first, second)) return first;
  return new AggregateError(
    [first, second],
    "Multiple versioning lock cleanup errors occurred.",
  );
}

async function reclaimStaleLock(
  lockPath: string,
  observed:
    | { kind: "record"; holder: LockRecord }
    | { kind: "unreadable"; ino: number; mtimeMs: number },
  options: VersioningLockClientOptions,
  acquisition: LockAcquisitionState,
): Promise<void> {
  const journalPath = `${lockPath}.mutation.journal`;
  const token = randomUUID();
  const claim = { type: "claim", token, owner: options.owner } satisfies MutationJournalRecord;
  const appendJournalRecord =
    options.appendMutationJournalRecord ?? appendMutationJournalRecord;
  let claimAppended = false;
  let installedMainLock = false;
  let primaryFailed = false;
  let primaryError: unknown;

  try {
    await appendJournalRecord(journalPath, claim);
    claimAppended = true;

    const journal = await readMutationJournalText(journalPath);
    const records = readMutationJournal(journal);
    electMutationClaim(records, token, options.pidIsAlive);

    // D3: reclaim only the dead record that was observed. Another process may
    // already have replaced it with a live lock while this client was waiting.
    const current = await readLockState(lockPath);
    if (observed.kind === "record") {
      const currentRecord = current.kind === "record" ? current.record : null;
      if (!sameLockRecord(currentRecord, observed.holder)) {
        throw new VersioningLockError("reclaim-race", currentRecord?.pid ?? null);
      }
      await options.beforeStaleOwnerRemoval?.(observed.holder);
    } else {
      const currentStat = await lstat(lockPath).catch(() => null);
      if (
        current.kind !== "unreadable"
        || !currentStat
        || currentStat.ino !== observed.ino
        || currentStat.mtimeMs !== observed.mtimeMs
      ) {
        throw new VersioningLockError(
          "reclaim-race",
          current.kind === "record" ? current.record.pid : null,
        );
      }
    }

    await rm(lockPath, { force: true });
    try {
      await createLockFileAttempt(lockPath, options, acquisition);
      installedMainLock = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const replacement = await readLockState(lockPath);
      throw new VersioningLockError(
        "reclaim-race",
        replacement.kind === "record" ? replacement.record.pid : null,
      );
    }
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  if (claimAppended) {
    try {
      await appendJournalRecord(journalPath, { type: "release", token });
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;

      if (installedMainLock) {
        try {
          await removeLockFileIfOwned(lockPath, options.owner);
        } catch (removalError) {
          cleanupError = combineCleanupErrors(cleanupError, removalError);
        }
      }
    }
  }

  if (primaryFailed) {
    if (cleanupFailed) {
      attachCause(primaryError, cleanupError);
    }
    throw primaryError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
}

async function acquireLockFile(
  lockPath: string,
  options: VersioningLockClientOptions,
): Promise<void> {
  const acquisition: LockAcquisitionState = {
    creationAttempts: 0,
    reclaimRaceRetries: 0,
  };

  for (;;) {
    try {
      await createLockFileAttempt(lockPath, options, acquisition);
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    await options.afterLockConflictDetected?.();

    let state = await readLockState(lockPath);
    if (state.kind === "missing") {
      await waitForLockCreationRetry();
      continue;
    }

    if (state.kind === "unreadable") {
      await options.afterUnreadableLockObserved?.();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, UNREADABLE_LOCK_RETRY_DELAY_MS);
      });
      state = await readLockState(lockPath);
      if (state.kind === "missing") {
        continue;
      }
      if (state.kind === "unreadable") {
        const stat = await lstat(lockPath).catch(() => null);
        if (!stat) {
          await waitForLockCreationRetry();
          continue;
        }
        if (Date.now() - stat.mtimeMs < UNREADABLE_LOCK_GRACE_MS) {
          throw new VersioningLockError(null);
        }
        try {
          await reclaimStaleLock(
            lockPath,
            { kind: "unreadable", ino: stat.ino, mtimeMs: stat.mtimeMs },
            options,
            acquisition,
          );
          return;
        } catch (error) {
          if (
            error instanceof VersioningLockError
            && error.reason === "reclaim-race"
            && acquisition.reclaimRaceRetries === 0
          ) {
            if (acquisition.creationAttempts >= LOCK_CREATION_ATTEMPT_LIMIT) {
              throw new VersioningLockError("transient-exhaustion");
            }
            acquisition.reclaimRaceRetries += 1;
            await waitForLockCreationRetry();
            continue;
          }
          throw error;
        }
      }
    }

    const holder = state.record;
    if (options.pidIsAlive(holder.pid)) {
      throw new VersioningLockError(holder.pid);
    }
    await options.afterStaleOwnerObserved?.(holder);

    try {
      await reclaimStaleLock(
        lockPath,
        { kind: "record", holder },
        options,
        acquisition,
      );
      return;
    } catch (error) {
      if (
        error instanceof VersioningLockError
        && error.reason === "reclaim-race"
        && acquisition.reclaimRaceRetries === 0
      ) {
        if (acquisition.creationAttempts >= LOCK_CREATION_ATTEMPT_LIMIT) {
          throw new VersioningLockError("transient-exhaustion");
        }
        acquisition.reclaimRaceRetries += 1;
        await waitForLockCreationRetry();
        continue;
      }
      throw error;
    }
  }
}

async function releaseLockFile(
  lockPath: string,
  owner: LockRecord,
): Promise<void> {
  await removeLockFileIfOwned(lockPath, owner);
}

export function createVersioningLockClient(options: VersioningLockClientOptions) {
  const owner = { ...options.owner };

  return {
    async withLock<T>(storeDir: string, operation: () => Promise<T>): Promise<T> {
      const lockPath = join(storeDir, ".lock");
      await acquireLockFile(lockPath, { ...options, owner });
      try {
        return await operation();
      } finally {
        await releaseLockFile(lockPath, owner);
      }
    },
  };
}

/** Serialize local callers, then hold the store's cross-process advisory lock. */
export async function withVersioningLock<T>(
  storeDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(storeDir, ".lock");
  let mutex = mutexes.get(lockPath);
  if (!mutex) {
    mutex = new InProcessMutex();
    mutexes.set(lockPath, mutex);
  }
  mutex.pending += 1;
  try {
    return await mutex.run(async () => {
      const client = createVersioningLockClient({
        owner: { pid: process.pid, startedAt: Date.now() },
        pidIsAlive: processPidIsAlive,
      });
      return client.withLock(storeDir, operation);
    });
  } finally {
    mutex.pending -= 1;
    if (mutex.pending === 0 && mutexes.get(lockPath) === mutex) {
      mutexes.delete(lockPath);
    }
  }
}
