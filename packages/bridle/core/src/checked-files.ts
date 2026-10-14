// Checked access to files and folders, shared by the snapshot store, the restore
// plan and the retention sweep. Internal: absent from the package barrel.
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

/** The store's own folders or journal are not what a store may work through: a
 *  link, a folder that is not where it should be or is no longer the one that was
 *  opened, or a journal that is a link, not a regular file, or has a second name.
 *  Thrown by `SnapshotStore.open` (nothing is created) and by every later journal
 *  or object operation (nothing is written). */
export class SnapshotStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SnapshotStoreError";
  }
}

/** Internal seam, absent from the package barrel: this platform's flag for
 *  "open the name itself, not what a link there points at". Windows has none.
 *  Tests clear it to run the path a platform without the flag takes. */
export const snapshotPlatform: {
  noFollow: number | undefined;
  /** Runs after `restoreTo` has its plan and before it executes it. */
  afterPlan?: () => void | Promise<void>;
  /** Runs after a restore has opened (or created) a file and before it confirms where the file stands. */
  afterRewriteOpen?: () => void | Promise<void>;
  /** Runs after a restore has truncated or created a file and before it writes the bytes. */
  beforeRestoreWrite?: () => void | Promise<void>;
  /** Runs when a store write finds another write of the same store in flight and waits for it. */
  onStoreWait?: () => void;
  /** Runs after a snapshot has written its temporary object and before it renames it to its hash name. */
  beforeObjectRename?: () => void | Promise<void>;
  /** Runs after an object's name has been looked at and before it is opened for reading. */
  afterObjectLook?: () => void | Promise<void>;
} = { noFollow: constants.O_NOFOLLOW };

const storeWrites = new Map<string, Promise<void>>();

/**
 * Run `write` after every write already started on the store at `dir` (its real
 * path) in this process, whichever `SnapshotStore` instance started it.
 *
 * A store's writes are each several system calls: look at the journal or at an
 * object's name, then create, rename or append. Two of them interleaved can each
 * find a name absent and each create it, and a reader between another write's
 * look and open then holds a file that was replaced under it. In one process they
 * therefore never interleave: appends, the journal's first creation, and an
 * object write with the append that follows it all pass through here, one at a
 * time per store folder. Another process is not held by this; there the exclusive
 * create decides, and the one that loses looks again and appends.
 */
export function inStoreOrder<T>(dir: string, write: () => Promise<T>): Promise<T> {
  const before = storeWrites.get(dir);
  if (before) snapshotPlatform.onStoreWait?.();
  const mine = (before ?? Promise.resolve()).then(write);
  const settled = mine.then(() => {}, () => {});
  storeWrites.set(dir, settled);
  void settled.then(() => {
    if (storeWrites.get(dir) === settled) storeWrites.delete(dir);
  });
  return mine;
}

export class NotTheCheckedFile extends Error {
  constructor() {
    super("what stands at the name is a link, is not a regular file, has more than one name, or is not the file that was checked");
    this.name = "NotTheCheckedFile";
  }
}

export type FileIdentity = { dev: bigint; ino: bigint };

export const sameFile = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino;

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Open the last name of `path` itself, never the target of a link standing there.
 *
 * The guarantee does not rest on the platform's no-follow flag. On every platform
 * the name is looked at first (a link or a non-file is refused), the open neither
 * truncates nor replaces (a missing name is created exclusively, which fails on any
 * name that has appeared, link or not), and the opened handle must be the file that
 * was looked at and the file standing at the name afterwards. Where the flag exists
 * it is added, so the kernel refuses a swapped-in link as well; where it does not, a
 * link swapped in after the look is opened but not changed, fails the identity
 * comparison, and is refused. Nothing is written before these checks pass.
 *
 * - "read": the name must exist.
 * - "create": the name must not exist.
 * - "rewrite": either; the caller truncates through the handle once it is satisfied.
 * - "append": either; every write through the handle lands at the end.
 *
 * `oneName` also refuses a file with more than one name (a hard link): such a
 * file is, under another name, some other file that this open would read or change.
 */
export async function openLastName(
  path: string,
  mode: "read" | "create" | "rewrite" | "append",
  seam?: { afterLook?: () => void | Promise<void>; oneName?: boolean },
): Promise<{ handle: FileHandle; created: boolean; identity: FileIdentity }> {
  const looked = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isMissing(error) && mode !== "read") return null;
    throw error;
  });
  if (looked && (mode === "create" || !looked.isFile())) throw new NotTheCheckedFile();
  if (looked && seam?.oneName && looked.nlink !== 1n) throw new NotTheCheckedFile();
  await seam?.afterLook?.();
  const flags = (looked
    ? (mode === "read" ? constants.O_RDONLY : constants.O_WRONLY)
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    | (mode === "append" ? constants.O_APPEND : 0)
    | (snapshotPlatform.noFollow ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(path, flags, 0o666);
  } catch (error) {
    // A name that appeared, or turned into a link, between the look and the open.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP" || code === "EMLINK") throw new NotTheCheckedFile();
    throw error;
  }
  try {
    const held = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true }).catch(() => null);
    if (
      !held.isFile() || !named?.isFile() || !sameFile(held, named)
      || (looked !== null && !sameFile(held, looked))
      || (seam?.oneName === true && held.nlink !== 1n)
    ) {
      throw new NotTheCheckedFile();
    }
    return { handle, created: looked === null, identity: { dev: held.dev, ino: held.ino } };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** `path` (a real path: nothing above its last name is a link) as a folder that
 *  is itself real, or null when nothing stands there. A link, a file, or a folder
 *  whose real location is not `path` throws. */
export async function realFolderAt(path: string, what: string): Promise<FileIdentity | null> {
  const standing = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw new SnapshotStoreError(`The snapshot store cannot be used: ${what} cannot be read.`, { cause: error });
  });
  if (standing === null) return null;
  if (!standing.isDirectory()) {
    throw new SnapshotStoreError(
      `The snapshot store cannot be used: ${what} is ${standing.isSymbolicLink() ? "a link" : "not a folder"}.`,
    );
  }
  // The last name is not a link and nothing above it is, so the real path can
  // differ from `path` only in how the disk spells the name.
  const real = await realpath(path);
  if (dirname(real) !== dirname(path)) {
    throw new SnapshotStoreError(`The snapshot store cannot be used: ${what} is not where it should be.`);
  }
  return { dev: standing.dev, ino: standing.ino };
}

/** Make `path` as one new folder (never a chain) and confirm what now stands there. */
export async function makeRealFolder(path: string, what: string): Promise<FileIdentity> {
  await mkdir(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new SnapshotStoreError(`The snapshot store cannot be used: ${what} cannot be created.`, { cause: error });
    }
  });
  const made = await realFolderAt(path, what);
  if (made === null) throw new SnapshotStoreError(`The snapshot store cannot be used: ${what} cannot be created.`);
  return made;
}
