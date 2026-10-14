import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { readWorkspaceIdentityId } from "./identity.ts";
import { withVersioningLock } from "./lock.ts";
import type { Checkpoint, CheckpointEntry, StatIndex } from "./types.ts";

type ReadJournal = (journalPath: string) => Promise<string>;
type CheckpointMetadata = Omit<Checkpoint, "entries">;
type WorkspaceMetadata = { workspaceRoot: string };

export type WorkspaceClaim = "current" | "moved" | "collision";

type FullCheckpointRecord = CheckpointMetadata & {
  version: 1;
  kind: "full";
  entries: CheckpointEntry[];
};

type DeltaCheckpointRecord = CheckpointMetadata & {
  version: 1;
  kind: "delta";
  baseId: string;
  upserts: CheckpointEntry[];
  removes: string[];
};

type JournalState = {
  size: number;
  mtimeMs: number;
  ino: number;
  cachedAt: number;
  endsWithNewline: boolean;
  checkpoints: Checkpoint[];
};

const FULL_CHECKPOINT_INTERVAL = 50;

export class VersioningCheckpointParentError extends Error {
  constructor(
    readonly expectedParentId: string | null,
    readonly actualParentId: string | null,
  ) {
    super(
      `Checkpoint parentId ${String(actualParentId)} does not match current head ${String(expectedParentId)}.`,
    );
    this.name = "VersioningCheckpointParentError";
  }
}

function cloneEntry(entry: CheckpointEntry): CheckpointEntry {
  return {
    ...entry,
    ...(entry.uncaptured ? { uncaptured: { ...entry.uncaptured } } : {}),
  };
}

function sortedEntries(entries: CheckpointEntry[]): CheckpointEntry[] {
  return entries.map(cloneEntry).sort((left, right) =>
    left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0);
}

function cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return { ...checkpoint, entries: sortedEntries(checkpoint.entries) };
}

function sameEntry(left: CheckpointEntry, right: CheckpointEntry): boolean {
  return left.relPath === right.relPath
    && left.kind === right.kind
    && left.size === right.size
    && left.hash === right.hash
    && left.linkTarget === right.linkTarget
    && left.uncaptured?.reason === right.uncaptured?.reason
    && left.unrestorable === right.unrestorable;
}

function checkpointMetadata(checkpoint: Checkpoint): CheckpointMetadata {
  const metadata: Partial<Checkpoint> = { ...checkpoint };
  delete metadata.entries;
  return metadata as CheckpointMetadata;
}

function parsedCheckpointMetadata(
  record: Record<string, unknown>,
  recordFields: string[],
): CheckpointMetadata {
  const metadata = { ...record };
  for (const field of recordFields) delete metadata[field];
  return metadata as CheckpointMetadata;
}

function journalRecord(
  checkpoint: Checkpoint,
  previous: Checkpoint | undefined,
  checkpointIndex: number,
): FullCheckpointRecord | DeltaCheckpointRecord {
  const entries = sortedEntries(checkpoint.entries);
  const metadata = checkpointMetadata(checkpoint);
  if (!previous || checkpointIndex === 0 || (checkpointIndex + 1) % FULL_CHECKPOINT_INTERVAL === 0) {
    return { ...metadata, version: 1, kind: "full", entries };
  }

  const previousByPath = new Map(previous.entries.map((entry) => [entry.relPath, entry]));
  const nextByPath = new Map(entries.map((entry) => [entry.relPath, entry]));
  const upserts = entries.filter((entry) => {
    const prior = previousByPath.get(entry.relPath);
    return !prior || !sameEntry(prior, entry);
  });
  const removes = [...previousByPath.keys()]
    .filter((relPath) => !nextByPath.has(relPath))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  return {
    ...metadata,
    version: 1,
    kind: "delta",
    baseId: previous.id,
    upserts,
    removes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCheckpointEntry(value: unknown): value is CheckpointEntry {
  if (!isRecord(value)) return false;
  const entry = value;
  const uncaptured = entry.uncaptured;
  return typeof entry.relPath === "string"
    && (entry.kind === "file"
      || entry.kind === "dir"
      || entry.kind === "symlink"
      || entry.kind === "special")
    && typeof entry.size === "number"
    && Number.isFinite(entry.size)
    && entry.size >= 0
    && (entry.hash === undefined || typeof entry.hash === "string")
    && (entry.linkTarget === undefined || typeof entry.linkTarget === "string")
    && (uncaptured === undefined
      || (isRecord(uncaptured)
        && (uncaptured.reason === "mount" || uncaptured.reason === "unreadable-dir")))
    && (entry.unrestorable === undefined || typeof entry.unrestorable === "boolean");
}

function isCheckpointMetadata(value: Record<string, unknown>): boolean {
  return typeof value.id === "string"
    && (value.parentId === null || typeof value.parentId === "string")
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && typeof value.label === "string"
    && (value.trigger === "initial"
      || value.trigger === "write"
      || value.trigger === "app-moment"
      || value.trigger === "restore")
    && (value.origin === undefined
      || value.origin === "pre-write"
      || value.origin === "restore")
    && (value.capability === undefined || typeof value.capability === "string")
    && (value.toolCallId === undefined || typeof value.toolCallId === "string")
    && (value.attemptId === undefined || typeof value.attemptId === "string")
    && (value.sessionId === undefined || typeof value.sessionId === "string");
}

function corruptJournal(lineNumber: number, reason: string): Error {
  return new Error(
    `Version checkpoint journal is corrupt at line ${lineNumber}: ${reason}.`,
  );
}

function reconstructJournal(raw: string): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  let previous: Checkpoint | undefined;
  let lineNumber = 0;

  for (const line of raw.split("\n")) {
    lineNumber += 1;
    if (!line) continue;
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(line);
    } catch {
      // A crash can leave the final append torn. Later valid full records remain readable.
      continue;
    }

    if (!isRecord(parsedValue)) {
      throw corruptJournal(lineNumber, "record is not an object");
    }
    const parsed = parsedValue;
    let checkpoint: Checkpoint;

    if ("version" in parsed || "kind" in parsed) {
      if (parsed.version !== 1) {
        throw corruptJournal(lineNumber, "unsupported record version");
      }
      if (parsed.kind === "full") {
        if (!isCheckpointMetadata(parsed)
          || !Array.isArray(parsed.entries)
          || !parsed.entries.every(isCheckpointEntry)) {
          throw corruptJournal(lineNumber, "malformed full checkpoint record");
        }
        checkpoint = {
          ...parsedCheckpointMetadata(parsed, ["version", "kind", "entries"]),
          entries: sortedEntries(parsed.entries as CheckpointEntry[]),
        };
      } else if (parsed.kind === "delta") {
        if (!previous) {
          throw corruptJournal(lineNumber, "delta has no preceding checkpoint");
        }
        if (parsed.baseId !== previous.id) {
          throw corruptJournal(lineNumber, "delta baseId does not match its preceding checkpoint");
        }
        if (!isCheckpointMetadata(parsed)
          || !Array.isArray(parsed.upserts)
          || !parsed.upserts.every(isCheckpointEntry)
          || !Array.isArray(parsed.removes)
          || !parsed.removes.every((relPath) => typeof relPath === "string")) {
          throw corruptJournal(lineNumber, "malformed delta checkpoint record");
        }
        const entriesByPath = new Map(
          previous.entries.map((entry) => [entry.relPath, cloneEntry(entry)]),
        );
        for (const relPath of parsed.removes as string[]) entriesByPath.delete(relPath);
        for (const entry of parsed.upserts as CheckpointEntry[]) {
          entriesByPath.set(entry.relPath, cloneEntry(entry));
        }
        checkpoint = {
          ...parsedCheckpointMetadata(
            parsed,
            ["version", "kind", "baseId", "upserts", "removes"],
          ),
          entries: sortedEntries([...entriesByPath.values()]),
        };
      } else {
        throw corruptJournal(lineNumber, "unsupported record kind");
      }
    } else {
      if (!isCheckpointMetadata(parsed)
        || !Array.isArray(parsed.entries)
        || !parsed.entries.every(isCheckpointEntry)) {
        throw corruptJournal(lineNumber, "malformed legacy checkpoint record");
      }
      // Version 0 was a raw Checkpoint JSON object per line.
      checkpoint = {
        ...parsedCheckpointMetadata(parsed, ["entries"]),
        entries: sortedEntries(parsed.entries as CheckpointEntry[]),
      };
    }

    const expectedParentId = previous?.id ?? null;
    if (checkpoint.parentId !== expectedParentId) {
      throw corruptJournal(
        lineNumber,
        "checkpoint parentId does not match its preceding checkpoint",
      );
    }
    checkpoints.push(checkpoint);
    previous = checkpoint;
  }
  return checkpoints;
}

/**
 * The versioning store (PRD tickets T2, T6-support). Lives OUTSIDE the workspace
 * (PRD Decision 3), so the agent can never reach it. Two parts:
 *  - a content-addressed object store: file bytes keyed by sha256, deduplicated,
 *    written atomically (temp + rename) and hash-VERIFIED on read (the review
 *    required tamper-evidence before restore);
 *  - an append-only checkpoint journal: one JSON line per checkpoint (a manifest
 *    of path -> object hash). Manifests are kilobytes; bytes are shared.
 */
export class VersionStore {
  private journalState: JournalState | null = null;

  private constructor(
    private storeDir: string,
    private objectsDir: string,
    private journalPath: string,
    private indexPath: string,
    private readJournal: ReadJournal,
    private now: () => number,
  ) {}

  static async open(opts: {
    dir: string;
    readJournal?: ReadJournal;
    /** Narrow clock seam for deterministic cache-race coverage. */
    now?: () => number;
  }): Promise<VersionStore> {
    await mkdir(opts.dir, { recursive: true });
    const storeDir = await realpath(opts.dir);
    const objectsDir = join(storeDir, "objects");
    await mkdir(objectsDir, { recursive: true });
    return new VersionStore(
      storeDir,
      objectsDir,
      join(storeDir, "checkpoints.jsonl"),
      join(storeDir, "index.json"),
      opts.readJournal ?? ((journalPath) => readFile(journalPath, "utf8")),
      opts.now ?? Date.now,
    );
  }

  /** Hold the per-store operation lock across a complete checkpoint, restore, or GC pass. */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withVersioningLock(this.storeDir, operation);
  }

  /**
   * Associate this ID-keyed store with one resolved folder path. Only the same
   * marker ID at a different recorded path proves a copy; every other recorded
   * path state is stale move metadata.
   */
  async claimWorkspace(
    workspaceRoot: string,
    workspaceId: string,
  ): Promise<WorkspaceClaim> {
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const metadataPath = join(this.storeDir, "workspace.json");
    return this.withLock(async () => {
      let metadata: WorkspaceMetadata | null = null;
      let rawMetadata: string | null = null;
      let removeUnreadableMetadata = false;
      try {
        rawMetadata = await readFile(metadataPath, "utf8");
      } catch {
        // workspace.json is a self-healing path hint, not an integrity journal.
        removeUnreadableMetadata = true;
      }
      if (rawMetadata !== null) {
        try {
          const parsed = JSON.parse(rawMetadata) as unknown;
          if (
            typeof parsed === "object"
            && parsed !== null
            && typeof (parsed as Partial<WorkspaceMetadata>).workspaceRoot === "string"
          ) {
            metadata = {
              workspaceRoot: (parsed as WorkspaceMetadata).workspaceRoot,
            };
          }
        } catch {
          // workspace.json is a self-healing path hint, not an integrity journal.
        }
      }

      if (metadata?.workspaceRoot === resolvedWorkspaceRoot) return "current";
      if (
        metadata
        && await readWorkspaceIdentityId(metadata.workspaceRoot) === workspaceId
      ) {
        return "collision";
      }

      const tmp = `${metadataPath}.tmp-${randomUUID()}`;
      await writeFile(
        tmp,
        JSON.stringify({ workspaceRoot: resolvedWorkspaceRoot }),
        "utf8",
      );
      if (removeUnreadableMetadata) {
        await rm(metadataPath, { recursive: true, force: true });
      }
      await rename(tmp, metadataPath);
      return metadata ? "moved" : "current";
    });
  }

  /** The stat-index (git-style): last-checkpointed size/mtime/ino/hash per path,
   *  so the next checkpoint re-reads only files whose stat actually changed.
   *  `savedAt` is the wall-clock time it was written — a file whose mtime is at or
   *  after it is treated as possibly-changed ("racily clean") and re-hashed, which
   *  defeats the same-millisecond in-place-overwrite false-negative. */
  async loadIndex(): Promise<{ savedAt: number; index: StatIndex }> {
    if (!existsSync(this.indexPath)) return { savedAt: 0, index: new Map() };
    const raw = JSON.parse(await readFile(this.indexPath, "utf8")) as { savedAt?: number; entries?: Record<string, StatIndex extends Map<string, infer V> ? V : never> };
    return { savedAt: raw.savedAt ?? 0, index: new Map(Object.entries(raw.entries ?? {})) };
  }

  async saveIndex(index: StatIndex): Promise<void> {
    const tmp = `${this.indexPath}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify({ savedAt: Date.now(), entries: Object.fromEntries(index) }), "utf8");
    await rename(tmp, this.indexPath);
  }

  /** Store bytes content-addressed; returns the hash. Deduplicated + atomic. */
  async putBytes(bytes: Buffer): Promise<string> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = join(this.objectsDir, hash);
    if (existsSync(target)) return hash; // dedup: identical content stored once
    const tmp = `${target}.tmp-${randomUUID()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, target); // atomic publish — a reader never sees a partial object
    return hash;
  }

  hasObject(hash: string): boolean {
    return existsSync(join(this.objectsDir, hash));
  }

  /** Read an object, verifying its bytes still hash to its name (tamper-evident). */
  async readObject(hash: string): Promise<Buffer> {
    const bytes = await readFile(join(this.objectsDir, hash));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) throw new Error(`Version object ${hash.slice(0, 12)} is corrupt (hash mismatch).`);
    return bytes;
  }

  async appendCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const state = await this.loadJournalState();
    const expectedParentId = state.checkpoints.at(-1)?.id ?? null;
    if (checkpoint.parentId !== expectedParentId) {
      throw new VersioningCheckpointParentError(
        expectedParentId,
        checkpoint.parentId,
      );
    }
    const normalized = cloneCheckpoint(checkpoint);
    const record = journalRecord(
      normalized,
      state.checkpoints.at(-1),
      state.checkpoints.length,
    );
    // A newline before the next record quarantines a torn tail instead of
    // concatenating a valid append onto incomplete JSON.
    const serialized = `${state.size > 0 && !state.endsWithNewline ? "\n" : ""}${JSON.stringify(record)}\n`;
    await appendFile(this.journalPath, serialized, "utf8");
    const fingerprint = await this.journalFingerprint();
    this.journalState = {
      ...fingerprint,
      cachedAt: this.now(),
      endsWithNewline: true,
      checkpoints: [...state.checkpoints, normalized],
    };
  }

  async checkpoints(): Promise<Checkpoint[]> {
    return (await this.loadJournalState()).checkpoints.map(cloneCheckpoint);
  }

  async head(): Promise<Checkpoint | null> {
    const head = (await this.loadJournalState()).checkpoints.at(-1);
    return head ? cloneCheckpoint(head) : null;
  }

  async checkpoint(id: string): Promise<Checkpoint | null> {
    return (await this.checkpoints()).find((c) => c.id === id) ?? null;
  }

  /** Every content object currently stored (for garbage collection). */
  async objectHashes(): Promise<string[]> {
    return (await readdir(this.objectsDir)).filter((name) => !name.includes(".tmp-"));
  }

  async deleteObject(hash: string): Promise<void> {
    await rm(join(this.objectsDir, hash), { force: true });
  }

  private async journalFingerprint(): Promise<{
    size: number;
    mtimeMs: number;
    ino: number;
  }> {
    try {
      const journalStat = await stat(this.journalPath);
      return {
        size: journalStat.size,
        mtimeMs: journalStat.mtimeMs,
        ino: journalStat.ino,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { size: 0, mtimeMs: 0, ino: 0 };
      }
      throw error;
    }
  }

  private async loadJournalState(): Promise<JournalState> {
    const fingerprint = await this.journalFingerprint();
    if (
      this.journalState?.size === fingerprint.size
      && this.journalState.mtimeMs === fingerprint.mtimeMs
      && this.journalState.ino === fingerprint.ino
      // An equal-length in-place rewrite can retain this stat tuple within one
      // clock tick. Trust it only once the observed mtime predates the cache.
      && fingerprint.mtimeMs < this.journalState.cachedAt
    ) {
      return this.journalState;
    }
    if (fingerprint.size === 0) {
      this.journalState = {
        ...fingerprint,
        cachedAt: this.now(),
        endsWithNewline: true,
        checkpoints: [],
      };
      return this.journalState;
    }

    const raw = await this.readJournal(this.journalPath);
    this.journalState = {
      // The bytes actually read are the cache token. Growth during the read is
      // observed by the next stat rather than hidden behind an older pre-read stat.
      size: Buffer.byteLength(raw),
      mtimeMs: fingerprint.mtimeMs,
      ino: fingerprint.ino,
      cachedAt: this.now(),
      endsWithNewline: raw.endsWith("\n"),
      checkpoints: reconstructJournal(raw),
    };
    return this.journalState;
  }
}
