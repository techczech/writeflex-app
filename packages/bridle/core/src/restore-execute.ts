/**
 * Restore, phase two: execution. Internal: absent from the package barrel.
 *
 * `executeRestore` acts on a plan from `planRestore` (restore-plan.ts, which also
 * states the limit of what the confirmations here can hold) and on nothing else:
 * it never reads the journal and never resolves a path as the journal wrote it.
 * Before each operation it looks again at the planned folder, by its real path,
 * and requires the planned device and inode and the planned state of the target.
 * The first mismatch or failure stops the restore. Every operation is reported
 * with what actually happened to it.
 */
import { lstat, rename, rmdir, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { NotTheCheckedFile, isMissing, openLastName, sameFile, snapshotPlatform } from "./checked-files.ts";
import { PATH_SHOWN_LIMIT, shown } from "./shown-text.ts";
import type { PlannedOperation, PlannedState, PlannedTarget, RestorePlan } from "./restore-plan.ts";

export type RestoreOutcome =
  /** Done as planned. */
  | "changed"
  /** The state was already as wanted; nothing was changed. */
  | "already-so"
  /** A folder an undo step would remove holds something else; it was left. Nothing was changed. */
  | "kept"
  /** The operation failed after changing something; `done` says what. */
  | "partly-changed"
  /** The operation was tried and stopped before it changed anything. */
  | "failed"
  /** The restore stopped before this operation. */
  | "not-attempted";

export type RestoreOperationReport = {
  kind: PlannedOperation["kind"];
  /** The journal's path, in its shown form. For a move, the path moved from. */
  path: string;
  /** Where the operation acted: the real path, in its shown form. */
  realPath: string;
  /** For a move: where to. */
  to?: { path: string; realPath: string };
  outcome: RestoreOutcome;
  /** What was done to the target, in order (for example `truncated`, `written`). */
  done: string[];
  /** Why it stopped, when it did. Never journal text. */
  detail?: string;
};

export type RestoreReport = {
  restorePointId: string;
  /** True when no operation failed. */
  complete: boolean;
  /** Every planned operation, in the order of execution. */
  operations: RestoreOperationReport[];
  /** Paths that were changed, as the journal wrote them (shown form; a move by
   *  its destination): undo steps first, then files in journal order. */
  restored: string[];
  /** Paths whose operation failed or was not reached, the failing one first. */
  notRestored: string[];
  failure?: { reason: string; cause?: unknown };
  untrustedSource: { sessionId: string; proposalId?: string };
};

/** The restore found, at the moment of acting, that the disk is not as planned. */
class Stop extends Error {}

function isAs(expected: PlannedState, now: BigIntStats | null): boolean {
  if (expected.state === "absent") return now === null;
  if (now === null || now.dev !== expected.dev || now.ino !== expected.ino) return false;
  if (expected.state === "folder") return now.isDirectory();
  return now.isFile() && now.size === expected.size && now.nlink === expected.nlink;
}

async function look(path: string): Promise<BigIntStats | null> {
  return lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
}

/** The planned folder is still the folder at its real path. */
async function confirmFolder(target: PlannedTarget): Promise<void> {
  const parent = await look(target.parent.real);
  if (!parent?.isDirectory() || !sameFile(parent, target.parent)) {
    throw new Stop("its folder is not the folder that was planned");
  }
}

/** The planned folder is still there and the target is in the planned state. */
async function confirm(target: PlannedTarget, expected: PlannedState): Promise<void> {
  await confirmFolder(target);
  if (!isAs(expected, await look(target.real))) {
    throw new Stop(expected.state === "absent"
      ? "something now stands where the plan found nothing"
      : "what stands there is not what the plan found");
  }
}

async function writeThrough(
  operation: PlannedOperation & { kind: "rewrite" | "create" },
  done: string[],
): Promise<void> {
  const { target, expected, bytes } = operation;
  const creating = operation.kind === "create";
  const opened = await openLastName(target.real, creating ? "create" : "rewrite", { oneName: true }).catch((error: unknown) => {
    if (error instanceof NotTheCheckedFile) throw new Stop(error.message);
    throw error;
  });
  const { handle, identity } = opened;
  if (opened.created) done.push("created");
  try {
    await snapshotPlatform.afterRewriteOpen?.();
    // On the handle, before any byte changes: this is the planned file, and it
    // stands in the planned folder.
    const held = await handle.stat({ bigint: true });
    const folder = await look(target.parent.real);
    const named = await look(target.real);
    const inPlace = folder?.isDirectory() === true && sameFile(folder, target.parent)
      && named?.isFile() === true && sameFile(named, identity);
    if (!inPlace || opened.created !== creating || (!creating && !isAs(expected, held))) {
      // Nothing has been written. A file this call created is empty; it is taken
      // away again when it still stands at the name it was created under.
      if (opened.created && named?.isFile() && sameFile(named, identity)) {
        await unlink(target.real).then(() => done.push("removed again"), () => {});
      }
      throw new Stop(creating
        ? "the new file could not be confirmed in the folder that was planned"
        : "the file is not the one that was planned, or is no longer in the planned folder");
    }
    if (creating) done.push("confirmed in the planned folder");
    else {
      await handle.truncate(0);
      done.push("truncated");
    }
    await snapshotPlatform.beforeRestoreWrite?.();
    await handle.writeFile(bytes);
    done.push("written");
    if ((await handle.stat({ bigint: true })).size !== BigInt(bytes.length)) {
      throw new Stop("the file does not have the size that was written");
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function run(operation: PlannedOperation, done: string[]): Promise<RestoreOutcome> {
  const { target, expected } = operation;
  await confirm(target, expected);
  switch (operation.kind) {
    case "already-so":
      return "already-so";
    case "keep-folder":
      return "kept";
    case "rewrite":
    case "create":
      await writeThrough(operation, done);
      return "changed";
    case "delete":
      await unlink(target.real);
      done.push("removed");
      return "changed";
    case "remove-folder":
      await rmdir(target.real);
      done.push("removed");
      return "changed";
    case "rename": {
      await confirm(operation.destination, { state: "absent" });
      await rename(target.real, operation.destination.real);
      done.push("moved");
      if (!isAs(expected, await look(operation.destination.real))) {
        throw new Stop("what now stands at the destination is not what was moved");
      }
      return "changed";
    }
  }
}

const listedPath = (operation: PlannedOperation): string =>
  operation.kind === "rename" ? operation.destination.path : operation.target.path;

/**
 * Carry out `plan`. Never throws for a failed operation: the report says what
 * happened to each one, and `complete` is false when the restore stopped.
 */
export async function executeRestore(plan: RestorePlan): Promise<RestoreReport> {
  const operations: RestoreOperationReport[] = plan.operations.map((operation) => ({
    kind: operation.kind,
    path: operation.target.path,
    realPath: shown(operation.target.real, PATH_SHOWN_LIMIT),
    ...("destination" in operation && operation.destination
      ? { to: { path: operation.destination.path, realPath: shown(operation.destination.real, PATH_SHOWN_LIMIT) } }
      : {}),
    outcome: "not-attempted",
    done: [],
  }));
  let failure: RestoreReport["failure"];
  for (const [index, operation] of plan.operations.entries()) {
    const record = operations[index]!;
    try {
      record.outcome = await run(operation, record.done);
    } catch (error) {
      // The reason never carries journal text: the restore's own wording, or the
      // system's error code. The error itself travels as `cause`.
      const reason = error instanceof Stop ? error.message
        : `the system refused it: ${(error as NodeJS.ErrnoException)?.code ?? "unknown error"}`;
      record.outcome = record.done.length > 0 ? "partly-changed" : "failed";
      record.detail = reason;
      failure = { reason, cause: error };
      break;
    }
  }
  const changed = plan.operations.filter((_, index) => operations[index]!.outcome === "changed");
  const unfinished = plan.operations.filter((_, index) =>
    ["partly-changed", "failed", "not-attempted"].includes(operations[index]!.outcome));
  return {
    restorePointId: plan.restorePointId,
    complete: failure === undefined,
    operations,
    restored: [
      ...changed.filter((operation) => operation.source.record === "undo-action"),
      ...changed.filter((operation) => operation.source.record === "snapshot")
        .sort((a, b) => a.source.position - b.source.position),
    ].map(listedPath),
    notRestored: unfinished.map(listedPath),
    ...(failure ? { failure } : {}),
    untrustedSource: { ...plan.untrustedSource },
  };
}
