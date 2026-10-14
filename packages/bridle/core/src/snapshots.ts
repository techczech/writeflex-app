import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  NotTheCheckedFile, SnapshotStoreError, inStoreOrder, isMissing, makeRealFolder, openLastName, realFolderAt, sameFile,
  snapshotPlatform, type FileIdentity,
} from "./checked-files.ts";
import {
  executeRestore, planRestore, type RestoreOperationReport, type RestorePlan, type RestoreRefusal,
} from "./restore-plan.ts";
import { MESSAGE_SHOWN_LIMIT, PATH_SHOWN_LIMIT, shown } from "./shown-text.ts";
import type { UndoAction } from "./types.ts";

export { SnapshotStoreError, openLastName, snapshotPlatform };
export type { RestoreOperationReport };

export type JournalEntry = { id: string; ts: number; sessionId: string } & (
  | { kind: "restore-point"; label: string; proposalId?: string }
  | { kind: "snapshot"; file: string; hash: string; capability?: string; toolCallId?: string; attemptId?: string; origin?: "turn" | "host" }
  // A structural reversal step (rename/remove) for an op whose undo is not a
  // content rewind — a folder move/delete/create (ADR-0028 typed-ops path).
  | { kind: "undo-action"; action: UndoAction; capability?: string; toolCallId?: string; attemptId?: string; origin?: "turn" | "host" }
);

type RestorePointDiscardTombstone = {
  kind: "discard-restore-point";
  id: string;
  ts: number;
  restorePointId: string;
};

type SnapshotJournalRecord = JournalEntry | RestorePointDiscardTombstone;

/** Journal hash marker meaning the file did not exist when snapshotted (restore deletes it). Note: the hash field stays typed string — a union with "ABSENT" would collapse to string anyway. */
export const ABSENT_HASH = "ABSENT";

/** Session named in a restore event when the caller gave none and the store is bound to none. */
export const UNATTRIBUTED_SESSION = "unattributed";

export type SnapshotRestoreEvent = {
  restorePointId: string;
  /** The session doing the restore: the caller's (`restoreTo`'s `sessionId`, or
   *  the session the store is bound to), never the journal's. */
  sessionId: string;
  /** Set only when the caller of `restoreTo` passed it. */
  proposalId?: string;
  /** Paths that were changed, as `restoreTo` returns them. */
  paths: string[];
  /** Every operation of the restore and what happened to it. */
  operations: RestoreOperationReport[];
  /** What the journal says about the Restore Point, in shown form. The journal
   *  can be planted, so this is a claim to check, never attribution. */
  untrustedSource: { sessionId: string; proposalId?: string };
};

const operationsOfRestore = new WeakMap<string[], RestoreOperationReport[]>();

/** Every operation of the restore that returned `restored` (the list `restoreTo`
 *  resolved with, or `RestoreNotRecordedError.restored`) and what happened to
 *  each; null for any other list. */
export function restoreOperations(restored: string[]): RestoreOperationReport[] | null {
  return operationsOfRestore.get(restored) ?? null;
}

export class RestorePointNotEmptyError extends Error {
  constructor(readonly restorePointId: string) {
    super(`Restore point ${restorePointId} has snapshots or undo actions and cannot be discarded.`);
    this.name = "RestorePointNotEmptyError";
  }
}

/** An object in the store's objects folder is not what its name says: a link, a
 *  folder, bytes that do not hash to the name, or a name that is not a hash. */
export class SnapshotObjectError extends Error {
  /** True when a regular, singly named file stands at a well-formed hash name
   *  and its bytes do not hash to that name: a damaged or substituted object. */
  readonly wrongBytes: boolean;
  constructor(message: string, options?: { cause?: unknown; wrongBytes?: boolean }) {
    super(message, options);
    this.name = "SnapshotObjectError";
    this.wrongBytes = options?.wrongBytes === true;
  }
}

/** A Restore Point names something the store will not write, move or delete, or
 *  cannot plan without doubt. The whole restore is refused before anything is
 *  changed. `refusals[].path` is the journal's path in its shown form (at most
 *  1024 characters, control characters replaced); the message lists the first
 *  five, each cut to 200 characters. */
export class RestoreRefusedError extends Error {
  /** Nothing was changed. */
  readonly restoredCompletely = false as const;
  readonly refusals: { path: string; reason: string }[];
  constructor(
    readonly restorePointId: string,
    refusals: { path: unknown; reason: string }[],
  ) {
    const safe = refusals.map((refusal) => ({ path: shown(refusal.path, PATH_SHOWN_LIMIT), reason: refusal.reason }));
    super(
      `Restore point ${shown(restorePointId)} was refused and nothing was changed: `
      + safe.slice(0, 5).map((refusal) => `${shown(refusal.path)} (${refusal.reason})`).join("; ")
      + (safe.length > 5 ? `; and ${safe.length - 5} more` : ""),
    );
    this.name = "RestoreRefusedError";
    this.refusals = safe;
  }
}

/** A restore passed every check and then stopped part-way. `restored` holds the
 *  paths that were changed, `notRestored` the ones whose operation failed or was
 *  not reached (the failing one first), both in the shown form. `operations` is
 *  every planned operation with what actually happened to it, including a change
 *  the failing operation made before it failed. No restore event is emitted. */
export class RestoreIncompleteError extends Error {
  /** Some of it may have been changed; `operations` says what. */
  readonly restoredCompletely = false as const;
  readonly restored: string[];
  readonly notRestored: string[];
  readonly operations: RestoreOperationReport[];
  constructor(
    readonly restorePointId: string,
    restored: unknown[],
    notRestored: unknown[],
    readonly reason: string,
    options?: { cause?: unknown; operations?: RestoreOperationReport[] },
  ) {
    const partly = options?.operations?.find((operation) => operation.outcome === "partly-changed");
    super(
      `Restore point ${shown(restorePointId)} stopped part-way: ${restored.length} of `
      + `${restored.length + notRestored.length} paths were restored; it failed at `
      + `${shown(notRestored[0])} (${reason})`
      + (partly ? `, after this was done to it: ${partly.done.join(", ")}.` : "."),
      options,
    );
    this.name = "RestoreIncompleteError";
    this.restored = restored.map((path) => shown(path, PATH_SHOWN_LIMIT));
    this.notRestored = notRestored.map((path) => shown(path, PATH_SHOWN_LIMIT));
    this.operations = options?.operations ?? [];
  }
}

/** NOT a failed restore. The restore changed everything it planned, and then its
 *  completion callback (`onRestore`: the harness's event and audit record) threw.
 *  Every file is back; only the record of the restore is missing. `restored` and
 *  `operations` are the completed report, `cause` is what the callback threw, and
 *  `restoredCompletely` is `true` here and `false` on the two errors that mean
 *  the files are not all back. */
export class RestoreNotRecordedError extends Error {
  readonly restoredCompletely = true as const;
  constructor(
    readonly restorePointId: string,
    readonly restored: string[],
    readonly operations: RestoreOperationReport[],
    options?: { cause?: unknown },
  ) {
    super(
      `The files WERE put back: restore point ${shown(restorePointId)} was restored completely `
      + `(${restored.length} paths changed). Only the record of the restore failed to be written.`,
      options,
    );
    this.name = "RestoreNotRecordedError";
  }
}

/** The only form a journal hash may take before it is joined to a path. */
const OBJECT_HASH = /^[0-9a-f]{64}$/;

const defaultSessionIds = new WeakMap<SnapshotStore, string>();
const discardUnappliedRestorePoint = Symbol("discardUnappliedRestorePoint");

const planRestoreOf = Symbol("planRestore");

/** Internal seam, absent from the package barrel: the plan `restoreTo` would
 *  execute for a Restore Point, or its refusal. Reads only. */
export async function planSnapshotRestore(
  store: SnapshotStore,
  restorePointId: string,
  opts?: { origin?: "turn" | "host" },
): Promise<RestorePlan | RestoreRefusal> {
  return store[planRestoreOf](restorePointId, opts);
}

/** Internal Proposal-store seam. This is deliberately absent from the package barrel and
 * from the host-visible SnapshotStore surface because only the executor can prove no write ran. */
export async function discardUnappliedProposalRestorePoint(
  store: SnapshotStore,
  id: string,
): Promise<void> {
  await store[discardUnappliedRestorePoint](id);
}

/** Bind the store owned by a Bridle handle to that handle's Runtime session. */
export function bindSnapshotSession(store: SnapshotStore, sessionId: string): void {
  defaultSessionIds.set(store, sessionId);
}

function resolveSessionId(store: SnapshotStore, sessionId?: string): string {
  const resolved = sessionId ?? defaultSessionIds.get(store);
  if (!resolved) throw new Error("Snapshot sessionId is required outside a Bridle handle.");
  return resolved;
}

/**
 * ADR-0008: sync-safe by format — whole-file content-addressed objects,
 * append-only JSONL journal, no locks, no rewrite-in-place. Safe inside
 * file-sync services; default placement is a hidden folder in the workspace.
 *
 * Single-writer by design: one app process owns a store directory. "Sync-safe"
 * (ADR-0008) means the on-disk format survives file-sync services, not
 * concurrent multi-process writers.
 */
export class SnapshotStore {
  private constructor(
    /** The store folder's real path: nothing in it is a link. */
    private dir: string,
    private journalPath: string,
    private objectsDir: string,
    private root: string,
    /** The two folders as they were when the store was opened. */
    private dirIdentity: FileIdentity,
    private objectsIdentity: FileIdentity,
    private onRestore?: (event: SnapshotRestoreEvent) => void | Promise<void>,
  ) {}

  /**
   * Open the store at `dir`, creating its folder and `objects` inside it when they
   * are missing. The store never works through a link: the folder that holds the
   * store is resolved to its real path first (links there are the caller's own
   * choice of place); below it the store folder and `objects` must each be absent
   * or a real folder, and are checked before anything is created. A missing folder
   * is made on its own, never as a chain, and looked at again. Anything else throws
   * SnapshotStoreError and creates nothing.
   */
  static async open(opts: {
    dir: string;
    /** The folder a restore may change. Defaults to the folder that holds the
     *  store (ADR-0008: the store is a hidden folder inside the workspace); a
     *  store placed elsewhere must name it, or every restore is refused. */
    root?: string;
    onRestore?: (event: SnapshotRestoreEvent) => void | Promise<void>;
  }): Promise<SnapshotStore> {
    const asGiven = resolve(opts.dir);
    // The nearest folder above the store that exists, as it really is. Folders
    // between it and the store do not exist yet, so none of them can be a link.
    const toMake: string[] = [];
    let anchor = dirname(asGiven);
    let realAnchor: string;
    for (;;) {
      try {
        realAnchor = await realpath(anchor);
        break;
      } catch (error) {
        const above = dirname(anchor);
        if (!isMissing(error) || above === anchor) {
          throw new SnapshotStoreError("The snapshot store cannot be used: the folder that holds it cannot be read.", { cause: error });
        }
        toMake.unshift(basename(anchor));
        anchor = above;
      }
    }
    const dir = join(realAnchor, ...toMake, basename(asGiven));
    const objectsDir = join(dir, "objects");
    // Look at everything that exists before making anything.
    let dirIdentity = toMake.length > 0 ? null : await realFolderAt(dir, "its folder");
    let objectsIdentity = dirIdentity === null ? null : await realFolderAt(objectsDir, "its objects folder");
    let holder = realAnchor;
    for (const name of toMake) {
      holder = join(holder, name);
      await makeRealFolder(holder, "the folder that holds it");
    }
    dirIdentity ??= await makeRealFolder(dir, "its folder");
    objectsIdentity ??= await makeRealFolder(objectsDir, "its objects folder");
    const root = resolve(opts.root ?? dirname(asGiven));
    return new SnapshotStore(
      dir, join(dir, "journal.jsonl"), objectsDir, root, dirIdentity, objectsIdentity, opts.onRestore,
    );
  }

  /** Before every journal or object operation: the store folder and `objects` are
   *  still real folders, and still the two that were opened. A link put in their
   *  place, or another folder moved there, stops the operation before it writes. */
  private async confirmFolders(): Promise<void> {
    const dirNow = await realFolderAt(this.dir, "its folder");
    const objectsNow = await realFolderAt(this.objectsDir, "its objects folder");
    if (
      dirNow === null || objectsNow === null
      || !sameFile(dirNow, this.dirIdentity) || !sameFile(objectsNow, this.objectsIdentity)
    ) {
      throw new SnapshotStoreError("The snapshot store cannot be used: its folders are not the ones that were opened.");
    }
  }

  /** Open the journal itself: absent, or a regular file with one name. Never a
   *  link, and never a file that is also some other file under a second name. */
  private async openJournal(mode: "read" | "append"): Promise<FileHandle | null> {
    await this.confirmFolders();
    // Appends of one process never run side by side (`inStoreOrder`). Another
    // process can still create the journal between this one's look and its
    // exclusive create; this one then finds a file where it expected none. That
    // is the one refusal worth a second look: the file is looked at afresh and
    // held to the same rule, so a link or a second name is refused then as well.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await openLastName(this.journalPath, mode, { oneName: true })).handle;
      } catch (error) {
        if (mode === "read" && isMissing(error)) return null;
        if (!(error instanceof NotTheCheckedFile)) throw error;
        if (mode === "append" && attempt === 0) continue;
        throw new SnapshotStoreError(
          "The snapshot store cannot be used: its journal is a link, is not a regular file, or has more than one name.",
        );
      }
    }
  }

  /** Read an object's bytes. The name must be a hash; what stands there must be
   *  a regular file with one name (a link is never followed, a hard link never
   *  read); and the bytes read through that handle must hash to the name. Every
   *  reader of an object goes through here, so none of them sees other bytes. */
  private async readObject(hash: string): Promise<Buffer> {
    if (typeof hash !== "string" || !OBJECT_HASH.test(hash)) {
      throw new SnapshotObjectError("Snapshot hash is not 64 lower-case hex digits.");
    }
    await this.confirmFolders();
    let handle: FileHandle;
    try {
      ({ handle } = await openLastName(join(this.objectsDir, hash), "read", {
        oneName: true, afterLook: () => snapshotPlatform.afterObjectLook?.(),
      }));
    } catch (error) {
      if (isMissing(error)) throw error;
      throw new SnapshotObjectError(`Snapshot object ${hash} cannot be opened as a regular file with one name.`);
    }
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw new SnapshotObjectError(`Snapshot object ${hash} does not hold the bytes its name says.`, { wrongBytes: true });
    }
    return bytes;
  }

  /** Put `content` at its hash name without ever writing through, or trusting,
   *  anything already there. Nothing outside the objects folder is created. */
  private async storeObject(hash: string, content: Buffer): Promise<void> {
    await this.confirmFolders();
    const objectPath = join(this.objectsDir, hash);
    const standing = await lstat(objectPath).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (standing) {
      // Reused only as what `readObject` accepts: regular, one name, the right bytes.
      try {
        await this.readObject(hash);
      } catch (error) {
        if (error instanceof SnapshotObjectError || error instanceof SnapshotStoreError) throw error;
        throw new SnapshotObjectError(`Snapshot object ${hash} cannot be read.`);
      }
      return;
    }
    // A random name, created exclusively: a file left by a killed run is never
    // reused and never in the way. It holds the same bytes the object would, in the
    // same folder; `sweepSnapshots` removes it as an unreferenced name.
    const temporary = join(this.objectsDir, `tmp-${randomUUID()}`);
    let created = false;
    try {
      const { handle } = await openLastName(temporary, "create");
      created = true;
      let written;
      try {
        await handle.writeFile(content);
        written = await handle.stat({ bigint: true });
      } finally {
        await handle.close();
      }
      // The file this handle wrote must be the one standing at the temporary name,
      // an ordinary file with one name and exactly these bytes.
      const named = await lstat(temporary, { bigint: true });
      if (
        !written.isFile() || !named.isFile() || written.nlink !== 1n
        || written.size !== BigInt(content.length)
        || named.dev !== written.dev || named.ino !== written.ino
      ) {
        throw new SnapshotObjectError(`Snapshot object ${hash} could not be written as a regular file.`);
      }
      await snapshotPlatform.beforeObjectRename?.();
      // Rename replaces a name; it never writes through a link put there meanwhile.
      await rename(temporary, objectPath);
      const placed = await lstat(objectPath, { bigint: true });
      if (placed.dev !== written.dev || placed.ino !== written.ino) {
        // Another snapshot of the same bytes in this process renamed its own file
        // over this one. What stands there is accepted only as any object is.
        await this.readObject(hash);
      }
    } catch (error) {
      if (created) await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof SnapshotObjectError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new SnapshotObjectError(`Snapshot object ${hash} could not be written${code ? ` (${code})` : ""}.`, { cause: error });
    }
  }

  /** Append one line, after every write of this store already under way in this process. */
  private append(entry: SnapshotJournalRecord): Promise<void> {
    return inStoreOrder(this.dir, () => this.appendNow(entry));
  }

  /** The append itself. Only ever called from inside `inStoreOrder`. */
  private async appendNow(entry: SnapshotJournalRecord): Promise<void> {
    const handle = (await this.openJournal("append"))!;
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  private async journalRecords(): Promise<SnapshotJournalRecord[]> {
    const handle = await this.openJournal("read");
    if (handle === null) return [];
    let raw: string;
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    return raw.split("\n").filter(Boolean).map(
      (line) => JSON.parse(line) as SnapshotJournalRecord,
    );
  }

  async entries(): Promise<JournalEntry[]> {
    const records = await this.journalRecords();
    const discarded = new Set(
      records.flatMap((entry) =>
        entry.kind === "discard-restore-point" ? [entry.restorePointId] : []),
    );
    return records.flatMap((entry) => {
      if (entry.kind === "discard-restore-point") return [];
      if (entry.kind === "restore-point" && discarded.has(entry.id)) return [];
      return [entry];
    });
  }

  async snapshotEntry(entryId: string): Promise<JournalEntry | null> {
    return (await this.entries()).find((entry) => entry.id === entryId) ?? null;
  }

  async beginRestorePoint(label: string, sessionId?: string, meta?: { proposalId?: string }): Promise<string> {
    const id = randomUUID();
    await this.append({
      kind: "restore-point", id, ts: Date.now(), sessionId: resolveSessionId(this, sessionId), label,
      ...(meta?.proposalId ? { proposalId: meta.proposalId } : {}),
    });
    return id;
  }

  /** Hide an unused Restore Point by appending a tombstone; journal bytes are never rewritten. */
  async discardRestorePoint(id: string): Promise<void> {
    const records = await this.journalRecords();
    if (
      records.some(
        (entry) =>
          entry.kind === "discard-restore-point"
          && entry.restorePointId === id,
      )
    ) {
      return;
    }
    const restorePointIndex = records.findIndex(
      (entry) => entry.kind === "restore-point" && entry.id === id,
    );
    if (restorePointIndex === -1) throw new Error(`Unknown restore point: ${id}`);
    if (
      records.slice(restorePointIndex + 1).some(
        (entry) =>
          entry.kind === "snapshot"
          || entry.kind === "undo-action",
      )
    ) {
      throw new RestorePointNotEmptyError(id);
    }
    await this.append({
      kind: "discard-restore-point",
      id: randomUUID(),
      ts: Date.now(),
      restorePointId: id,
    });
  }

  /** Hide a Restore Point after the executor has proved that the capability did
   * not run. Unlike discardRestorePoint, pre-write snapshots may exist: they are
   * inert evidence, not undo data for an applied write, so
   * RestorePointNotEmptyError's completed-write protection does not apply. */
  async [discardUnappliedRestorePoint](id: string): Promise<void> {
    const records = await this.journalRecords();
    if (records.some((entry) => entry.kind === "discard-restore-point" && entry.restorePointId === id)) return;
    if (!records.some((entry) => entry.kind === "restore-point" && entry.id === id)) {
      throw new Error(`Unknown restore point: ${id}`);
    }
    await this.append({
      kind: "discard-restore-point",
      id: randomUUID(),
      ts: Date.now(),
      restorePointId: id,
    });
  }

  async snapshotFile(absPath: string, meta: { sessionId?: string; capability?: string; toolCallId?: string; attemptId?: string; origin?: "turn" | "host" }): Promise<JournalEntry> {
    // The object write and the append that records it are one write of the store:
    // no other write of this store in this process runs between or beside them.
    return inStoreOrder(this.dir, () => this.snapshotFileNow(absPath, meta));
  }

  private async snapshotFileNow(absPath: string, meta: { sessionId?: string; capability?: string; toolCallId?: string; attemptId?: string; origin?: "turn" | "host" }): Promise<JournalEntry> {
    let hash = ABSENT_HASH;
    if (existsSync(absPath)) {
      const content = await readFile(absPath);
      hash = createHash("sha256").update(content).digest("hex");
      await this.storeObject(hash, content);
    }
    const entry: JournalEntry = {
      kind: "snapshot", id: randomUUID(), ts: Date.now(),
      sessionId: resolveSessionId(this, meta.sessionId), file: absPath, hash,
      ...(meta.capability !== undefined ? { capability: meta.capability } : {}),
      ...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
      ...(meta.attemptId !== undefined ? { attemptId: meta.attemptId } : {}),
      origin: meta.origin ?? "host",
    };
    await this.appendNow(entry);
    return entry;
  }

  /** Record a structural reversal step into the current restore point (ADR-0028). */
  async recordUndoAction(action: UndoAction, meta: { sessionId?: string; capability?: string; toolCallId?: string; attemptId?: string; origin?: "turn" | "host" }): Promise<void> {
    await this.append({
      kind: "undo-action", id: randomUUID(), ts: Date.now(),
      sessionId: resolveSessionId(this, meta.sessionId), action,
      ...(meta.capability !== undefined ? { capability: meta.capability } : {}),
      ...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
      ...(meta.attemptId !== undefined ? { attemptId: meta.attemptId } : {}),
      origin: meta.origin ?? "host",
    });
  }

  async readSnapshotContent(entryId: string): Promise<string | null> {
    const entry = await this.snapshotEntry(entryId);
    if (!entry || entry.kind !== "snapshot" || entry.hash === ABSENT_HASH) return null;
    // A hash from the journal is joined to a path only in this one form.
    if (typeof entry.hash !== "string" || !OBJECT_HASH.test(entry.hash)) return null;
    try {
      return (await this.readObject(entry.hash)).toString("utf8");
    } catch (error) {
      // Bytes that do not hash to the name are a damaged entry: no content, as for a missing snapshot.
      if (error instanceof SnapshotObjectError && error.wrongBytes) return null;
      throw error;
    }
  }

  /** Plan the restore of a Restore Point without changing anything (reads only). */
  async [planRestoreOf](restorePointId: string, opts?: { origin?: "turn" | "host" }): Promise<RestorePlan | RestoreRefusal> {
    return planRestore({
      root: this.root,
      storeDir: this.dir,
      entries: () => this.entries(),
      readObject: async (hash) => {
        try {
          return await this.readObject(hash as string);
        } catch (error) {
          if (error instanceof SnapshotStoreError) throw error;
          return { refusal: error instanceof SnapshotObjectError ? error.message : "its snapshot object cannot be read" };
        }
      },
    }, restorePointId, opts);
  }

  /**
   * Put files back to the state the Restore Point recorded: every file first
   * snapshotted after it, and its undo steps (move back, remove), latest first.
   *
   * The restore is planned first, from reads alone (restore-plan.ts). Every path
   * and hash comes from the journal, so any doubt refuses the whole Restore Point
   * with RestoreRefusedError and changes nothing. The plan is then executed
   * without the journal being read again. A failure or a disk that is no longer
   * as planned stops the restore with RestoreIncompleteError, which lists every
   * operation and what happened to it; no restore event is emitted for it. If the
   * restore completes and `onRestore` throws, RestoreNotRecordedError carries the
   * completed report.
   *
   * Returns the paths that were changed; `restoreOperations(list)` gives every
   * operation beside them. A path whose state was already as wanted, or a folder
   * left because it is not empty, is among the operations and not in the list.
   *
   * `sessionId` and `proposalId` say who is restoring, for the restore event; the
   * journal's own session and proposal ids are passed on only as `untrustedSource`.
   */
  async restoreTo(
    restorePointId: string,
    opts?: { origin?: "turn" | "host"; sessionId?: string; proposalId?: string },
  ): Promise<string[]> {
    const plan = await this[planRestoreOf](restorePointId, opts?.origin ? { origin: opts.origin } : undefined);
    if (plan.kind === "refusal") {
      if (plan.unknownRestorePoint) throw new Error(`Unknown restore point: ${shown(restorePointId, MESSAGE_SHOWN_LIMIT)}`);
      throw new RestoreRefusedError(restorePointId, plan.refusals);
    }
    await snapshotPlatform.afterPlan?.();
    const report = await executeRestore(plan);
    if (!report.complete) {
      throw new RestoreIncompleteError(
        restorePointId, report.restored, report.notRestored, report.failure?.reason ?? "unknown error",
        { cause: report.failure?.cause, operations: report.operations },
      );
    }
    // The report is complete before anyone is told, so a callback that throws
    // cannot lose it.
    const restored = [...report.restored];
    operationsOfRestore.set(restored, report.operations);
    try {
      await this.onRestore?.({
        restorePointId,
        sessionId: opts?.sessionId ?? defaultSessionIds.get(this) ?? UNATTRIBUTED_SESSION,
        ...(opts?.proposalId ? { proposalId: opts.proposalId } : {}),
        paths: [...report.restored],
        operations: report.operations,
        untrustedSource: report.untrustedSource,
      });
    } catch (error) {
      throw new RestoreNotRecordedError(restorePointId, restored, report.operations, { cause: error });
    }
    return restored;
  }
}
