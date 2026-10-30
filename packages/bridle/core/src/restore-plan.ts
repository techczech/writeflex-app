import { workspacePathRefusal as refusalBelow, dotNameRefused, linkRefusal } from "./workspace-containment.ts";
/**
 * Restore, phase one: the plan. Internal: absent from the package barrel.
 *
 * A restore is two phases with nothing shared between them but an immutable plan.
 * `planRestore` only reads. It turns a Restore Point's journal records, every one
 * of which is someone else's text, into a list of operations on canonical targets,
 * or refuses the whole Restore Point when anything is in doubt. `executeRestore`
 * (restore-execute.ts) acts on that list alone: it never reads the journal and
 * never resolves a path as the journal wrote it.
 *
 * A target is canonical when it is known as: the folder that holds it, by device
 * and inode, reached from the real root through real folders with no dot-named
 * segment; its last name as the disk spells it; and, when something stands there,
 * that entry's own device and inode. Two records that reach one entry are one
 * target, restored once, to the earliest state the Restore Point recorded.
 *
 * Undo steps (move back, remove) change what a path means, so the plan is made
 * in execution order against a model of the folder tree as it will stand at each
 * step: a record's path is resolved in the tree that every earlier operation of
 * the plan will have left. The model is run twice: once with every record acting
 * (to find which records name one file), then with only each file's earliest
 * record acting. If the two runs disagree about which records name one file, the
 * Restore Point is refused.
 *
 * STATED LIMIT. Node has no way to act relative to an open folder. Execution
 * confirms the planned folder's device and inode and the target's expected state
 * immediately before each operation, and confirms a rewritten or created file on
 * its open handle; between the last confirmation and the system call, a folder
 * above the target can still be swapped by a program running at that instant.
 * Planted content and file sync cannot time that. Nothing more is done against it.
 */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMissing } from "./checked-files.ts";
import { Reads, Refuse, foldKey, refuse, restorePlanLimits } from "./restore-reads.ts";
import { PATH_SHOWN_LIMIT, UNSHOWABLE, shown } from "./shown-text.ts";
import type { JournalEntry } from "./snapshots.ts";

/** The journal's marker for "the file did not exist": `ABSENT_HASH` in snapshots.ts,
 *  which owns the journal format. Repeated here so the plan imports no value from the store. */
const ABSENT_HASH = "ABSENT";

/** What the plan expects to find at a target immediately before its operation. */
export type PlannedState =
  | { state: "absent" }
  | { state: "file"; dev: bigint; ino: bigint; size: bigint; nlink: bigint }
  | { state: "folder"; dev: bigint; ino: bigint };

export type PlannedTarget = {
  /** The journal's path for it, in its shown form. For messages and lists only. */
  path: string;
  /** The folder that holds it, as it will stand when the operation runs. */
  parent: { dev: bigint; ino: bigint; real: string };
  /** Its last name, as the disk spells it when something stands there. */
  name: string;
  /** `parent.real` joined with `name`. */
  real: string;
};

export type PlannedOperation = {
  /** Which journal record it came from: its kind and its place after the Restore Point. */
  source: { record: "snapshot" | "undo-action"; position: number };
  target: PlannedTarget;
  expected: PlannedState;
} & (
  | { kind: "rewrite"; bytes: Buffer }
  | { kind: "create"; bytes: Buffer }
  | { kind: "delete" }
  | { kind: "remove-folder" }
  | { kind: "rename"; destination: PlannedTarget }
  /** The state is already as wanted; nothing will be changed. */
  | { kind: "already-so"; wanted: "delete" | "remove" | "rename"; destination?: PlannedTarget }
  /** An undo step would remove a folder that will not be empty; it is left. */
  | { kind: "keep-folder" }
);

export type RestorePlan = {
  kind: "plan";
  restorePointId: string;
  /** The root's real path. */
  root: string;
  operations: readonly PlannedOperation[];
  /** What the journal says about the Restore Point. Planted text; never attribution. */
  untrustedSource: { sessionId: string; proposalId?: string };
};

export type RestoreRefusal = {
  kind: "refusal";
  restorePointId: string;
  /** True when the journal holds no Restore Point of that id. */
  unknownRestorePoint: boolean;
  /** Paths in their shown form, in journal order. */
  refusals: { path: string; reason: string }[];
};

/** What planning may read of a store. */
export type RestoreStoreView = {
  /** The folder a restore may change, as the host named it. */
  root: string;
  /** The store folder's real path; nothing in or above it inside the root is ever a target. */
  storeDir?: string;
  entries(): Promise<JournalEntry[]>;
  /** Bytes that hash to `hash`, or why they cannot be had. */
  readObject(hash: unknown): Promise<Buffer | { refusal: string }>;
};

type Step = { position: number } & (
  | { record: "snapshot"; file: unknown; hash: unknown }
  | { record: "undo-action"; action: { do?: unknown; from?: unknown; to?: unknown; path?: unknown } | null }
);

type Entry = {
  /** Identity for "one file or two": device and inode, or a name for a slot. */
  token: string;
  kind: "file" | "folder" | "link" | "other";
  /** Where it stands on disk now; null for a file this plan would create. */
  disk: { path: string; dev: bigint; ino: bigint; size: bigint; nlink: bigint } | null;
  /** The journal path that put it where the model has it, when the model moved or created it. */
  written?: unknown;
};
type Folder = { token: string; dev: bigint; ino: bigint; diskPath: string; simPath: string };
type Located = {
  written: unknown; parent: Folder; name: string; entry: Entry | null; real: string; through: Set<string>;
  /** True when a folder on the way is missing: `parent` and `name` are then the
   *  last folder that exists and the first name that does not. */
  noFolder?: true;
};

/** The journal paths a step names. */
const pathsOf = (step: Step): unknown[] =>
  step.record === "snapshot" ? [step.file]
    : step.action?.do === "rename" ? [step.action.from, step.action.to]
      : step.action?.do === "remove" ? [step.action.path] : [null];

const DOT = "the path is under a dot-folder or is a dot-file";
const UNPROVEN = "the Restore Point names it in ways that cannot be proved to be one file or two";

/** One run of the model over the steps, in execution order. */
class Run {
  readonly operations: PlannedOperation[] = [];
  readonly tokens = new Map<number, string>();
  readonly refusals: { position: number; path: string; reason: string }[] = [];
  /** Disk entries that no longer stand where the disk has them. */
  private hidden = new Set<string>();
  /** Entries standing where the disk has none, by folder then name. */
  private placed = new Map<string, Map<string, Entry>>();
  /** The file a deleted entry was, kept for the name it stood at. */
  private slotTokens = new Map<string, string>();
  private absentNames = new Map<string, Map<string, { name: string; written: unknown }>>();
  private sizes = new Map<string, bigint>();
  private foldersMoved = 0;
  private fresh = 0;

  constructor(
    private view: RestoreStoreView,
    private realRoot: string,
    private rootFolder: Folder,
    private reads: Reads,
    /** Positions of records that name a file an earlier record already settles. */
    private inactive: Set<number>,
    /** The run whose operations become the plan: objects are read, doubt is refused. */
    private final: boolean,
  ) {}

  async over(steps: Step[]): Promise<this> {
    for (const step of steps) {
      try {
        if (step.record === "snapshot") await this.content(step);
        else if (step.action?.do === "rename") await this.moveBack(step.position, step.action.from, step.action.to);
        else if (step.action?.do === "remove") await this.remove(step.position, step.action.path);
        else refuse("an undo step this store does not know", null);
      } catch (error) {
        if (!(error instanceof Refuse)) throw error;
        const path = error.path === undefined ? pathsOf(step)[0] : error.path;
        this.refusals.push({ position: step.position, path: shown(path, PATH_SHOWN_LIMIT), reason: error.message });
        if (error.also !== undefined) {
          this.refusals.push({ position: step.position, path: shown(error.also, PATH_SHOWN_LIMIT), reason: error.message });
        }
      }
    }
    return this;
  }

  private async lookup(folder: Folder, name: string, written: unknown): Promise<{ entry: Entry | null; name: string }> {
    const placed = this.placed.get(folder.token);
    const exact = placed?.get(name);
    if (exact) return { entry: exact, name };
    const key = foldKey(name);
    for (const [other, standing] of placed ?? []) {
      if (foldKey(other) === key) {
        refuse("its name may be another spelling of a name this restore also acts on", written, standing.written);
      }
    }
    const standing = await lstat(join(folder.diskPath, name), { bigint: true }).catch((error: unknown) =>
      isMissing(error) ? null : refuse("it cannot be looked at"));
    if (standing && !this.hidden.has(`${standing.dev}:${standing.ino}`)) {
      const spelling = await this.reads.spelling(folder.diskPath, name, standing);
      return {
        name: spelling,
        entry: {
          token: `${standing.dev}:${standing.ino}`,
          kind: standing.isSymbolicLink() ? "link" : standing.isDirectory() ? "folder" : standing.isFile() ? "file" : "other",
          disk: { path: join(folder.diskPath, spelling), dev: standing.dev, ino: standing.ino, size: standing.size, nlink: standing.nlink },
        },
      };
    }
    // Nothing stands there. Whether another absent name in this folder would be
    // the same file is the disk's to say, and nothing can be asked of it without
    // writing: the same text is the same name, a different text with a different
    // key is a different name, and anything between refuses both.
    const names = this.absentNames.get(folder.token) ?? new Map<string, { name: string; written: unknown }>();
    this.absentNames.set(folder.token, names);
    const seen = names.get(key);
    if (seen && seen.name !== name) {
      refuse("two names that are not there yet may be one file on this disk", written, seen.written);
    }
    names.set(key, { name, written });
    return { entry: null, name };
  }

  /** Resolve a journal path in the model: once, to a folder identity and a name. */
  private async walk(written: unknown, absentIfNoFolder = false, trashSource = false): Promise<Located> {
    try {
      return await this.walkPlain(written, absentIfNoFolder, trashSource);
    } catch (error) {
      if (error instanceof Refuse) error.path ??= written;
      throw error;
    }
  }

  private async walkPlain(written: unknown, absentIfNoFolder: boolean, trashSource: boolean): Promise<Located> {
    if (typeof written !== "string" || !isAbsolute(written)) return refuse("not an absolute path");
    if (written.length > PATH_SHOWN_LIMIT) refuse(`the path is longer than ${PATH_SHOWN_LIMIT} characters`);
    if (UNSHOWABLE.test(written)) refuse("the path holds control characters or characters that do not show");
    // `..` after a linked folder means one place to the system and another to
    // `resolve`. Neither it nor `.` is a form this store writes, so neither is read.
    if (written.split(sep === "/" ? "/" : /[\\/]/).some((segment) => segment === ".." || segment === ".")) {
      refuse("the path is not written in its plain form");
    }
    const given = resolve(written);
    // As written: inside the root as the host named it, or as it really is.
    const bases = [this.view.root, this.realRoot];
    const asWritten = bases.map((base) => refusalBelow(base, given, "the path", { trashSource }));
    const inside = asWritten.indexOf(null);
    if (inside === -1) refuse(asWritten[0]!);
    let segments = relative(bases[inside]!, given).split(sep);
    trashSource = trashSource && segments[0] === ".bridle-trash";
    let folder = this.rootFolder;
    let through = new Set([folder.token]);
    let links = 0;
    for (let index = 0; ; index += 1) {
      const segment = segments[index]!;
      const trashFolder = trashSource && index === 0 && segment === ".bridle-trash";
      if (dotNameRefused(segment, index, trashSource)) refuse(DOT);
      const found = await this.lookup(folder, segment, written);
      if (dotNameRefused(found.name, index, trashFolder)) refuse(DOT);
      const linked = linkRefusal(found.entry?.kind === "link", trashSource ? "trash-source" : "restore-parent");
      if (linked) refuse(linked);
      if (found.entry?.disk && found.entry.disk.path === this.view.storeDir) refuse("the path is in the snapshot store");
      if (index === segments.length - 1) {
        return { written, parent: folder, name: found.name, entry: found.entry, real: join(folder.simPath, found.name), through };
      }
      const entry = found.entry;
      if (entry === null) {
        // Nothing is ever created on the way to a target. Where the wanted state
        // is "not there", a missing folder already is that state.
        if (!absentIfNoFolder) return refuse("the folder that would hold it does not exist");
        return { written, parent: folder, name: found.name, entry: null, real: join(folder.simPath, found.name), through, noFolder: true };
      }
      if (entry.kind === "link") {
        // A link is followed on the disk as it stands, so only where the model
        // has moved no folder: a moved folder can change where a link leads.
        if (this.foldersMoved > 0 || !entry.disk) refuse("it is reached through a link in a restore that moves folders");
        links += 1;
        if (links > 16) refuse("it is reached through too many links");
        const real = await realpath(entry.disk!.path).catch(() => refuse("a link on the way to it cannot be resolved"));
        const below = real === this.realRoot ? null : refusalBelow(this.realRoot, real, "the path's real location");
        if (below) refuse(below);
        // The real path is walked again from the root, through the model.
        segments = [...(real === this.realRoot ? [] : relative(this.realRoot, real).split(sep)), ...segments.slice(index + 1)];
        folder = this.rootFolder;
        through = new Set([folder.token]);
        index = -1;
        continue;
      }
      if (entry.kind !== "folder" || !entry.disk) return refuse("a name on the way to it is not a folder");
      folder = {
        token: entry.token, dev: entry.disk.dev, ino: entry.disk.ino,
        diskPath: entry.disk.path, simPath: join(folder.simPath, found.name),
      };
      through.add(folder.token);
    }
  }

  private target(at: Located): PlannedTarget {
    return {
      path: shown(at.written, PATH_SHOWN_LIMIT),
      parent: { dev: at.parent.dev, ino: at.parent.ino, real: at.parent.simPath },
      name: at.name,
      real: at.real,
    };
  }

  private expected(entry: Entry): PlannedState {
    const disk = entry.disk!;
    return entry.kind === "folder"
      ? { state: "folder", dev: disk.dev, ino: disk.ino }
      : { state: "file", dev: disk.dev, ino: disk.ino, size: this.sizes.get(entry.token) ?? disk.size, nlink: disk.nlink };
  }

  /** The entry at `at` no longer stands there. */
  private takeOut(at: Located): void {
    const placed = this.placed.get(at.parent.token);
    if (placed?.get(at.name) === at.entry) placed.delete(at.name);
    else this.hidden.add(at.entry!.token);
  }

  private place(folder: Folder, name: string, entry: Entry): void {
    const placed = this.placed.get(folder.token) ?? new Map<string, Entry>();
    this.placed.set(folder.token, placed);
    placed.set(name, entry);
  }

  /** A file a restore may rewrite, delete or move: regular, not a link, one name. */
  private mustBeOneFile(entry: Entry, path: unknown): void {
    if (entry.kind === "link") refuse("the path is a link", path);
    if (entry.kind !== "file") refuse("the path is not a regular file", path);
    if (entry.disk && entry.disk.nlink !== 1n) refuse("the file has more than one name (a hard link)", path);
  }

  private async content(step: Step & { record: "snapshot" }): Promise<void> {
    const wantsAbsent = step.hash === ABSENT_HASH;
    const at = await this.walk(step.file, wantsAbsent);
    const source = { record: "snapshot" as const, position: step.position };
    if (at.noFolder) {
      // Absent with its folder: no other record can be shown to name the same file.
      this.fresh += 1;
      this.tokens.set(step.position, `absent:${this.fresh}`);
      if (!this.inactive.has(step.position)) {
        this.operations.push({ source, target: this.target(at), expected: { state: "absent" }, kind: "already-so", wanted: "delete" });
      }
      return;
    }
    // Keyed so that a name and a spelling of it that may be the same file share one slot.
    const slot = `${at.parent.token}/${foldKey(at.name)}`;
    const entry = at.entry;
    let token = entry?.token ?? this.slotTokens.get(slot);
    if (token === undefined) {
      this.fresh += 1;
      token = `absent:${this.fresh}`;
      this.slotTokens.set(slot, token);
    }
    this.tokens.set(step.position, token);
    if (entry) {
      if (entry.kind === "folder") refuse(wantsAbsent ? "a folder stands where a file would be deleted" : "the path is not a regular file", step.file);
      this.mustBeOneFile(entry, step.file);
    }
    if (this.inactive.has(step.position)) return;
    const target = this.target(at);
    if (wantsAbsent) {
      if (!entry) {
        this.operations.push({ source, target, expected: { state: "absent" }, kind: "already-so", wanted: "delete" });
        return;
      }
      // A file the model itself created: only the first run meets one (every
      // record acts in it); in the plan's own run it is doubt.
      if (!entry.disk && this.final) refuse(UNPROVEN, step.file);
      if (entry.disk) this.operations.push({ source, target, expected: this.expected(entry), kind: "delete" });
      this.takeOut(at);
      this.slotTokens.set(slot, token);
      return;
    }
    // Every object a rewrite needs is read, and so verified, before any change.
    const bytes = this.final ? await this.reads.object(step.hash).catch((error: unknown) => {
      if (error instanceof Refuse) error.path ??= step.file;
      throw error;
    }) : Buffer.alloc(0);
    if (!entry) {
      this.operations.push({ source, target, expected: { state: "absent" }, kind: "create", bytes });
      this.place(at.parent, at.name, { token, kind: "file", disk: null, written: at.written });
      return;
    }
    if (!entry.disk) {
      if (this.final) refuse(UNPROVEN, step.file);
      return;
    }
    this.operations.push({ source, target, expected: this.expected(entry), kind: "rewrite", bytes });
    this.sizes.set(entry.token, BigInt(bytes.length));
  }

  private async moveBack(position: number, fromPath: unknown, toPath: unknown): Promise<void> {
    const source = { record: "undo-action" as const, position };
    const from = await this.walk(fromPath, true, true);
    const to = await this.walk(toPath);
    const entry = from.entry;
    if (!entry) {
      // Nothing to move. Something already at the destination is the wanted state.
      if (!to.entry) refuse("an undo step would move something that is not there", fromPath);
      this.operations.push({
        source, target: this.target(from), expected: { state: "absent" },
        kind: "already-so", wanted: "rename", destination: this.target(to),
      });
      return;
    }
    if (!entry.disk) return refuse("an undo step would move a file this restore creates", fromPath);
    const linked = linkRefusal(entry.kind === "link", "move-source");
    if (linked) refuse(linked, fromPath);
    if (entry.kind === "folder") {
      if (to.through.has(entry.token)) refuse("an undo step would move a folder into itself", toPath);
    } else {
      this.mustBeOneFile(entry, fromPath);
    }
    if (to.entry) refuse("an undo step would move onto something that already stands there", toPath);
    if (to.parent.dev !== entry.disk.dev) refuse("an undo step would move across disks", toPath);
    if (entry.kind === "folder") {
      const why = await this.reads.movable(entry.disk.path);
      if (why) refuse(why, fromPath);
      this.foldersMoved += 1;
    }
    this.operations.push({
      source, target: this.target(from), expected: this.expected(entry), kind: "rename", destination: this.target(to),
    });
    this.takeOut(from);
    this.hidden.add(entry.token);
    this.place(to.parent, to.name, { ...entry, written: to.written });
  }

  private async remove(position: number, path: unknown): Promise<void> {
    const source = { record: "undo-action" as const, position };
    const at = await this.walk(path, true);
    const entry = at.entry;
    const target = this.target(at);
    if (!entry) {
      this.operations.push({ source, target, expected: { state: "absent" }, kind: "already-so", wanted: "remove" });
      return;
    }
    if (!entry.disk) return refuse("an undo step would remove a file this restore creates", path);
    if (entry.kind === "link") refuse("an undo step would remove a link", path);
    if (entry.kind !== "folder") {
      this.mustBeOneFile(entry, path);
      this.operations.push({ source, target, expected: this.expected(entry), kind: "delete" });
      this.takeOut(at);
      return;
    }
    // A folder is removed only when the operations before this one leave it
    // empty. One that holds anything else, a dot-file included, is left whole.
    if (!(await this.willBeEmpty(entry))) {
      this.operations.push({ source, target, expected: this.expected(entry), kind: "keep-folder" });
      return;
    }
    this.operations.push({ source, target, expected: this.expected(entry), kind: "remove-folder" });
    this.takeOut(at);
  }

  private async willBeEmpty(folder: Entry): Promise<boolean> {
    if ((this.placed.get(folder.token)?.size ?? 0) > 0) return false;
    for (const name of await this.reads.listing(folder.disk!.path)) {
      const child = await lstat(join(folder.disk!.path, name), { bigint: true }).catch(() => null);
      if (child === null || !this.hidden.has(`${child.dev}:${child.ino}`)) return false;
    }
    return true;
  }
}

/** The records in the order their operations will run: latest first, so each is
 *  undone before what came before it; and a folder's removal after every removal
 *  of something inside it, so that it is empty by then. */
function inExecutionOrder(records: Step[]): Step[] {
  const sequence = [...records].reverse();
  const empties = (step: Step): unknown[] =>
    step.record === "snapshot" ? (step.hash === ABSENT_HASH ? [step.file] : [])
      : step.action?.do === "remove" ? [step.action.path]
        : step.action?.do === "rename" ? [step.action.from] : [];
  for (let index = sequence.length - 1; index >= 0; index -= 1) {
    const step = sequence[index]!;
    if (step.record !== "undo-action" || step.action?.do !== "remove" || typeof step.action.path !== "string") continue;
    const inside = step.action.path.endsWith(sep) ? step.action.path : `${step.action.path}${sep}`;
    let last = -1;
    for (let later = index + 1; later < sequence.length; later += 1) {
      if (empties(sequence[later]!).some((path) => typeof path === "string" && path.startsWith(inside))) last = later;
    }
    if (last === -1) continue;
    sequence.splice(index, 1);
    sequence.splice(last, 0, step);
  }
  return sequence;
}

/** For each record, the earliest record that names the same file. */
function sameFileGroups(tokens: Map<number, string>): Map<number, number> {
  const earliest = new Map<string, number>();
  for (const [position, token] of tokens) earliest.set(token, Math.min(position, earliest.get(token) ?? position));
  return new Map([...tokens].map(([position, token]) => [position, earliest.get(token)!]));
}

function frozen<T>(value: T): T {
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  for (const inner of Object.values(value)) frozen(inner);
  return Object.freeze(value);
}

/**
 * Plan the restore of `restorePointId`, or refuse it. Reads only: nothing on disk
 * is changed, whatever the answer.
 */
export async function planRestore(
  view: RestoreStoreView,
  restorePointId: string,
  opts?: { origin?: "turn" | "host" },
): Promise<RestorePlan | RestoreRefusal> {
  const refusal = (refusals: { position: number; path: string; reason: string }[], unknownRestorePoint = false): RestoreRefusal => ({
    kind: "refusal", restorePointId, unknownRestorePoint,
    refusals: [...refusals].sort((a, b) => a.position - b.position).map(({ path, reason }) => ({ path, reason })),
  });
  const entries = await view.entries();
  const pointIndex = entries.findIndex((entry) => entry.kind === "restore-point" && entry.id === restorePointId);
  const point = entries[pointIndex];
  if (point?.kind !== "restore-point") return refusal([], true);
  const inOrigin = (origin: unknown): boolean => !opts?.origin || (origin ?? "turn") === opts.origin;
  const records: Step[] = [];
  for (const entry of entries.slice(pointIndex + 1)) {
    if (!inOrigin((entry as { origin?: unknown }).origin)) continue;
    const position = records.length;
    if (entry.kind === "snapshot") records.push({ position, record: "snapshot", file: entry.file, hash: entry.hash });
    if (entry.kind === "undo-action") records.push({ position, record: "undo-action", action: entry.action ?? null });
  }
  const steps = inExecutionOrder(records);

  const realRoot = await realpath(view.root).catch(() => null);
  const rootStat = realRoot === null ? null : await lstat(realRoot, { bigint: true }).catch(() => null);
  if (realRoot === null || !rootStat?.isDirectory()) {
    return refusal(records.flatMap((step) => pathsOf(step).map((path) => ({
      position: step.position, path: shown(path, PATH_SHOWN_LIMIT), reason: "the store's root cannot be read",
    }))));
  }
  const rootFolder: Folder = {
    token: `${rootStat.dev}:${rootStat.ino}`, dev: rootStat.dev, ino: rootStat.ino, diskPath: realRoot, simPath: realRoot,
  };
  const reads = new Reads(view);

  // First run: every record acts, as the turn's own history ran backwards.
  const history = await new Run(view, realRoot, rootFolder, reads, new Set(), false).over(steps);
  if (history.refusals.length > 0) return refusal(history.refusals);
  const groups = sameFileGroups(history.tokens);
  const later = new Set([...groups].filter(([position, earliest]) => position !== earliest).map(([position]) => position));

  // Second run: one record acts for each file, the earliest. This is the plan.
  const run = await new Run(view, realRoot, rootFolder, reads, later, true).over(steps);
  if (run.refusals.length > 0) return refusal(run.refusals);
  const regrouped = sameFileGroups(run.tokens);
  const unproven = records.filter((step) => step.record === "snapshot" && regrouped.get(step.position) !== groups.get(step.position));
  if (unproven.length > 0) {
    return refusal(unproven.map((step) => ({
      position: step.position, path: shown(step.record === "snapshot" ? step.file : null, PATH_SHOWN_LIMIT), reason: UNPROVEN,
    })));
  }
  return frozen({
    kind: "plan" as const,
    restorePointId,
    root: realRoot,
    operations: run.operations,
    untrustedSource: {
      sessionId: shown(point.sessionId),
      ...(point.proposalId ? { proposalId: shown(point.proposalId) } : {}),
    },
  });
}

export { restorePlanLimits };
export { executeRestore, type RestoreOperationReport, type RestoreOutcome, type RestoreReport } from "./restore-execute.ts";
