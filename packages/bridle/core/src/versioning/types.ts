import type { WalkEntryKind } from "./walk.ts";

export type UncapturedReason = "mount" | "unreadable-dir";
export type UncapturedPath = { relPath: string; reason: UncapturedReason };
export type VersioningReport = { uncaptured: UncapturedPath[] };
export type NotRolledBackReason =
  | "unreadable-dir"
  | "mount"
  | "unrestorable"
  | "missing-content"
  | "unrecoverable-overwrite"
  | "left-behind";
export type NotRolledBackPath = { relPath: string; reason: NotRolledBackReason };
export type RestoreReport = VersioningReport & {
  notRolledBack: NotRolledBackPath[];
};

/** One path's state within a checkpoint. Regular files carry a content hash;
 *  symlinks carry their target; special files are recorded present-but-not-read. */
export type CheckpointEntry = {
  relPath: string;
  kind: WalkEntryKind;
  size: number;
  /** sha256 of the file's bytes — regular files only. */
  hash?: string;
  /** symlink target string (never followed). */
  linkTarget?: string;
  /** The path exists, but its subtree was deliberately not captured. */
  uncaptured?: { reason: UncapturedReason };
  /** True when the file was too large to preserve cheaply and clonefile was
   *  unavailable — checkpointed, but its bytes are not restorable (PRD Decision 2). */
  unrestorable?: boolean;
};

/** A whole-folder checkpoint: a manifest over shared content objects (PRD Decision 2). */
export type Checkpoint = {
  id: string;
  parentId: string | null;
  createdAt: number;
  label: string;
  trigger: "initial" | "write" | "app-moment" | "restore";
  entries: CheckpointEntry[];
  /** Why this checkpoint was taken when it belongs to an execution or restore flow. */
  origin?: "pre-write" | "restore";
  capability?: string;
  toolCallId?: string;
  attemptId?: string;
  sessionId?: string;
};

export type CreatedCheckpointResult = Checkpoint & {
  noop?: false;
  report: VersioningReport;
};

/** A clean scan reuses the head without copying its historical metadata. */
export type NoopCheckpointResult = {
  id: string;
  noop: true;
  report: VersioningReport;
};

/** Operation results add a current report without persisting the derived data. */
export type CheckpointResult = CreatedCheckpointResult | NoopCheckpointResult;
export type RestoreResult =
  | (Omit<CreatedCheckpointResult, "report"> & {
      beforeCheckpointId: string;
      report: RestoreReport;
    })
  | (Omit<NoopCheckpointResult, "report"> & {
      beforeCheckpointId: null;
      report: RestoreReport;
    });

/** The stat-index carried between checkpoints so unchanged files are never re-read. */
export type StatIndexEntry = { size: number; mtimeMs: number; ino: number; hash: string };
export type StatIndex = Map<string, StatIndexEntry>;
