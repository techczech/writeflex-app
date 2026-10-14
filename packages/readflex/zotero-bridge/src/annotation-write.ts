/**
 * Writing annotations into Zotero's own database, with Zotero closed (ADR-0031).
 *
 * ```
 * refuse if Zotero is open ──▶ refuse if the schema moved past the pin ──▶ COPY the database
 *   ──▶ take an exclusive lock ──▶ one transaction per user action ──▶ items + itemAnnotations
 * ```
 *
 * This reverses ADR-0002's **write** half; its read half is untouched. The reasoning is in ADR-0031:
 * a web-API key with write access to shared group libraries can damage other researchers' work
 * remotely, in the authoritative copy, with no feedback here — while the worst a local write can do
 * is corrupt one file that has both an online copy and, because of the pre-write copy below, a
 * local one from seconds ago.
 *
 * **Everything here is verified against the installed beta, not against documentation.** The facts
 * the code depends on, each read out of `zotero.sqlite` and out of Zotero 10.0's own source:
 *
 * - `items` carries `version INT NOT NULL DEFAULT 0` and `synced INT NOT NULL DEFAULT 0`, with
 *   `CREATE INDEX items_synced ON items(synced)`. A locally created item is `version = 0`,
 *   `synced = 0` — Zotero's `DataObject.prototype._saveData` writes exactly that.
 * - `itemAnnotations` has two columns beyond the API's field list: `textNormalized` and
 *   `commentNormalized`, both nullable, populated by Zotero's `normalizeForSearchStorage`. They are
 *   ported faithfully below, because writing NULL where Zotero would write a value makes the
 *   annotation unfindable by a search that folds diacritics.
 * - `itemAnnotations.parentItemID` is a foreign key to **`itemAttachments(itemID)`**, not to
 *   `items(itemID)`, and `isExternal INT NOT NULL` has no default.
 * - Zotero's `Sync.Data.Local.getUnsynced` selects `synced=0` **and**
 *   `(IAn.isExternal IS NULL OR IAn.isExternal=0)`, so every row written here sets `isExternal = 0`.
 *   See {@link ZOTERO_SYNC_UNSYNCED_ITEM_PREDICATE}.
 * - Object keys are 8 characters from `23456789ABCDEFGHIJKLMNPQRSTUVWXYZ`
 *   (`Zotero.Utilities.allowedKeyChars`).
 * - `dateAdded`, `dateModified` and `clientDateModified` are UTC `YYYY-MM-DD HH:MM:SS` at
 *   second granularity (`Zotero.DB.transactionDateTime`).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import {
  assertNotInZoteroDataDirectory,
  assertZoteroAnnotationWriteTarget,
  discoverZoteroDataDirectory,
} from "@readflex/zotero-paths";
import type {
  SqliteDatabase,
  SqliteDriver,
} from "@readflex/sqlite-driver";
import { pathToFileURL } from "node:url";
// Type-only, so this module has no runtime edge back to `index.ts`, which re-exports it. A value
// import here would make the pair a cycle for the bundler to resolve.
import type { ZoteroAnnotationType } from "./index.js";

/**
 * ADR-0005's structural pin. `zotero-pin.json` at the repo root is the canonical artefact — the
 * probe reads it and `annotation-write.test.ts` asserts this constant equals it, so the two cannot
 * drift the way ADR-0005's own correction record describes.
 */
export const ZOTERO_STRUCTURAL_SCHEMA_PIN = {
  userdata: 129,
  system: 32,
} as const;

/**
 * Zotero's own predicate for "a row the sync engine will upload", quoted from
 * `chrome/content/zotero/xpcom/sync/syncLocal.js` (`getUnsynced`) in the installed Zotero 10.0, so
 * a reviewer can check the write against the thing that consumes it rather than against a summary.
 */
export const ZOTERO_SYNC_UNSYNCED_ITEM_PREDICATE =
  "libraryID=? AND synced=0 AND (IAn.isExternal IS NULL OR IAn.isExternal=0)";

/** `Zotero.Utilities.allowedKeyChars`. Verified against every key in the live library. */
const ZOTERO_KEY_ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
const ZOTERO_KEY_LENGTH = 8;
const ZOTERO_KEY_PATTERN = new RegExp(
  `^[${ZOTERO_KEY_ALPHABET}]{${ZOTERO_KEY_LENGTH}}$`,
);

/** `Zotero.Annotations.DEFAULT_COLOR` — `COLORS[0][1]`, the general yellow. */
export const ZOTERO_DEFAULT_ANNOTATION_COLOUR = "#ffd400";

/** `Zotero.Annotations.ANNOTATION_TYPE_*`. `unknown` has no numeric type and cannot be written. */
const ANNOTATION_TYPE_IDS = {
  highlight: 1,
  note: 2,
  image: 3,
  ink: 4,
  underline: 5,
  text: 6,
} as const;

export type WritableZoteroAnnotationType = keyof typeof ANNOTATION_TYPE_IDS;

/** `Zotero.Utilities.Internal._searchNormalizeMap`. */
const SEARCH_NORMALIZE_MAP: Record<string, string> = {
  "ø": "o",
  "œ": "oe",
  "æ": "ae",
  "ł": "l",
  "đ": "d",
  "ð": "d",
  "þ": "th",
  "ß": "ss",
  "ı": "i",
  "⁄": "/",
};

/** `Zotero.Utilities.Internal._searchFormattingTagRE`. */
const SEARCH_FORMATTING_TAG_PATTERN =
  /<\/?(?:i|b|sub|sup)>|<span (?:style="font-variant:small-caps;"|class="nocase")>|<\/span>/g;

/**
 * `Zotero.Utilities.Internal.normalizeForSearch`, ported line for line from the installed Zotero.
 * Not simplified: the order of the folds is what makes a search term match a stored value, and a
 * "tidier" equivalent would silently produce a different string.
 */
export function normaliseForZoteroSearch(value: string): string {
  if (!value) {
    return value;
  }
  const withoutFormatting = value.includes("<")
    ? value.replace(SEARCH_FORMATTING_TAG_PATTERN, "")
    : value;
  return withoutFormatting
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(
      /[øœæłđðþßı⁄]/g,
      (character) => SEARCH_NORMALIZE_MAP[character]!,
    )
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .normalize("NFC");
}

/**
 * `Zotero.Utilities.Internal.normalizeForSearchStorage` — what goes in `textNormalized`,
 * `commentNormalized` and `tags.nameNormalized`. NULL is not "we did not bother": it is Zotero's
 * signal that normalising changed nothing SQLite's `LIKE` would not already fold, and queries fall
 * back to the raw column through `COALESCE`.
 */
export function normaliseForZoteroSearchStorage(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const normalised = normaliseForZoteroSearch(value);
  const asciiLowercased = value.replace(/[A-Z]/g, (character) =>
    character.toLowerCase(),
  );
  return normalised === asciiLowercased ? null : normalised;
}

/** `Zotero.DB.transactionDateTime`: UTC `YYYY-MM-DD HH:MM:SS`, second granularity. */
export function zoteroSqlDateTime(now: Date = new Date()): string {
  return new Date(Math.floor(now.getTime() / 1000) * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

/** `Zotero.Utilities.generateObjectKey`. */
export function generateZoteroObjectKey(
  random: () => number = Math.random,
): string {
  let key = "";
  for (let index = 0; index < ZOTERO_KEY_LENGTH; index += 1) {
    key += ZOTERO_KEY_ALPHABET.charAt(
      Math.floor(random() * ZOTERO_KEY_ALPHABET.length),
    );
  }
  return key;
}

export function isValidZoteroObjectKey(key: string): boolean {
  return ZOTERO_KEY_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// Is Zotero open?
// ---------------------------------------------------------------------------

/**
 * Why the write is refused. Each is a separate reading, and **any one of them refuses**: a false
 * "it is closed" is the single answer that can corrupt the library, so the checks are deliberately
 * eager rather than balanced against each other (ADR-0031, decision 2).
 */
export type ZoteroLivenessSignal =
  /** A Zotero process is running. Never the only check — a renamed bundle would defeat it. */
  | "zotero-process-running"
  /** Some process holds `zotero.sqlite` open, whatever it is called. */
  | "database-file-open"
  /**
   * A non-empty `-wal`. Either Zotero has uncommitted pages or it died without a checkpoint; in
   * both cases the plain `.sqlite` file is an incomplete picture, so copying it would produce a
   * backup that silently omits recent work. A **stale `-shm` is not a signal**: it can remain after Zotero closes,
   * so its presence alone does not establish an unflushed write-ahead log.
   */
  | "unflushed-write-ahead-log"
  /** An exclusive lock could not be taken. Read as "open" by construction. */
  | "database-locked";

export interface ZoteroLivenessProbes {
  /** Identified Zotero executables. Defaults to filtering `ps` by executable only. */
  runningZoteroProcesses?: () => string[];
  /** Processes holding the database file open. Defaults to `lsof`. */
  processesHoldingDatabase?: (databasePath: string) => string[];
}

export interface ZoteroLiveness {
  open: boolean;
  signals: ZoteroLivenessSignal[];
  details: string[];
}

export type LivenessCommandRunner = (
  command: string,
  arguments_: string[],
) => string;

function runLivenessCommand(command: string, arguments_: string[]): string {
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
}

function outputLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Read a command whose successful output cannot legitimately be empty. Any unusable reading throws,
 * so the liveness caller's existing catch reports the corresponding probe as open.
 */
function requiredCommandOutputLines(
  command: string,
  arguments_: string[],
  runner: LivenessCommandRunner,
  emptyMessage: string,
): string[] {
  const lines = outputLines(runner(command, arguments_));
  if (lines.length === 0) {
    throw new Error(emptyMessage);
  }
  return lines;
}

/**
 * Read a matcher command for which exit status 1 means "no matches". Other failures still throw,
 * so the liveness caller reports an unreadable probe as open.
 */
function matchingCommandOutputLines(
  command: string,
  arguments_: string[],
  runner: LivenessCommandRunner,
): string[] {
  try {
    return outputLines(runner(command, arguments_));
  } catch (error) {
    // `lsof` exits 1 when nothing holds the file. That is a trustworthy empty reading, unlike a
    // failed `ps`, whose output must always contain at least the process running the probe.
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return [];
    }
    throw error;
  }
}

const ZOTERO_EXECUTABLE_PATTERN = /^zotero(?:-bin)?$/i;

/**
 * Keep only Zotero executables from lines shaped `<pid> <executable path>`.
 *
 * The production probe reads `ps`'s `comm` field, which emits the executable path and no arguments.
 * The whole remainder after the pid is therefore the path, including any spaces in its directories.
 * A command line is outside this function's contract; arguments never reach it in production.
 */
export function filterRunningZoteroProcesses(processLines: string[]): string[] {
  return processLines.filter((line) => {
    const executable = line.trim().replace(/^\d+\s+/, "");
    return ZOTERO_EXECUTABLE_PATTERN.test(basename(executable));
  });
}

export function runningZoteroProcessesFromPs(
  runner: LivenessCommandRunner = runLivenessCommand,
): string[] {
  return filterRunningZoteroProcesses(
    requiredCommandOutputLines(
      "/bin/ps",
      ["-axo", "pid=,comm="],
      runner,
      "ps returned no process lines",
    ),
  );
}

/**
 * The holders `lsof -F pc` reports, **minus our own process** (ADR-0031, defect section).
 *
 * ReadFlex opens the library read-only. Desktop reads use `immutable=1`; the library service uses
 * WAL-aware `mode=ro`, which may create or attach the content-free `zotero.sqlite-shm` file. Both
 * handles show up in `lsof` exactly like any other holder — so without this the gate detects itself
 * and refuses a write while Zotero is plainly closed. Only our own pid is dropped: `lsof` is the
 * check that catches a renamed or relocated Zotero bundle, so relaxing it is not an option and
 * **every other holder still refuses.**
 *
 * `-F pc` emits one `p<pid>` line per process followed by its `c<command>` line, so the pid in force
 * is whichever `p` line was seen last.
 */
export function holdersExcludingSelf(
  lsofLines: string[],
  ownProcessId: number = process.pid,
): string[] {
  const holders: string[] = [];
  let processId: number | null = null;
  for (const line of lsofLines) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      processId = Number.isNaN(parsed) ? null : parsed;
      continue;
    }
    if (!line.startsWith("c")) {
      continue;
    }
    // A `c` line with no pid in force means the output was not the shape we asked for; treating it
    // as a holder keeps the gate eager, which is the direction that cannot corrupt.
    if (processId === ownProcessId) {
      continue;
    }
    holders.push(line);
  }
  return holders;
}

export function processesHoldingDatabaseFromLsof(
  databasePath: string,
  runner: LivenessCommandRunner = runLivenessCommand,
): string[] {
  return holdersExcludingSelf(
    matchingCommandOutputLines(
      "/usr/sbin/lsof",
      ["-F", "pc", "--", databasePath],
      runner,
    ),
  );
}

/**
 * Whether Zotero has the library. **Process name is never the sole reading** — the brief case that
 * breaks it is a bundle renamed or run from elsewhere, which `lsof` independently catches.
 *
 * An idle running Zotero is not guaranteed to leave a non-empty `-wal` or to hold a competing write
 * lock: after a checkpoint the WAL may be empty, and `BEGIN IMMEDIATE` conflicts only with another
 * writer. The `lsof` holder reading carries that file-level case on its own.
 *
 * A probe that throws is reported as a signal too: an unreadable probe is not a closed Zotero.
 */
export function zoteroLibraryLiveness(
  databasePath: string,
  probes: ZoteroLivenessProbes = {},
): ZoteroLiveness {
  const signals: ZoteroLivenessSignal[] = [];
  const details: string[] = [];

  const runningProcesses =
    probes.runningZoteroProcesses ?? runningZoteroProcessesFromPs;
  const holders =
    probes.processesHoldingDatabase ?? processesHoldingDatabaseFromLsof;

  try {
    const processes = runningProcesses();
    if (processes.length > 0) {
      signals.push("zotero-process-running");
      details.push(`A Zotero process is running: ${processes.join("; ")}`);
    }
  } catch (error) {
    signals.push("zotero-process-running");
    details.push(
      `Could not check whether Zotero is running, so it is treated as running: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const openedBy = holders(databasePath);
    if (openedBy.length > 0) {
      signals.push("database-file-open");
      details.push(
        `Your Zotero library file is open in: ${openedBy
          .map((line) => line.replace(/^c/, ""))
          .join(", ")}`,
      );
    }
  } catch (error) {
    signals.push("database-file-open");
    details.push(
      `Could not check whether your Zotero library file is open, so it is treated as open: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const writeAheadLogPath = `${databasePath}-wal`;
  try {
    if (existsSync(writeAheadLogPath) && statSync(writeAheadLogPath).size > 0) {
      signals.push("unflushed-write-ahead-log");
      details.push(
        `Your Zotero library has unsaved changes waiting in ${basename(writeAheadLogPath)}.`,
      );
    }
  } catch (error) {
    signals.push("unflushed-write-ahead-log");
    details.push(
      `Could not read ${basename(writeAheadLogPath)}, so the library is treated as in use: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { details, open: signals.length > 0, signals };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface ZoteroStructuralSchemaVersions {
  userdata: number;
  system: number;
}

export interface ZoteroAnnotationWriteSessionOptions {
  /** Defaults to the discovered data directory's `zotero.sqlite` (ADR-0012 §2). */
  databasePath?: string;
  /** Where the pre-write copy goes. ReadFlex-owned, and checked by the general guard. */
  backupDirectory: string;
  /** Additive second forbidden tree, exactly as the general guard treats it (ADR-0012 §1). */
  zoteroDataDirectory?: string;
  liveness?: ZoteroLivenessProbes;
  schemaPin?: ZoteroStructuralSchemaVersions;
  /** How many pre-write copies to keep. Older ones are deleted, newest first. */
  keepBackups?: number;
  now?: () => Date;
  random?: () => number;
}

export type ZoteroAnnotationWriteRefusalCode =
  | "zotero-is-open"
  | "schema-drift"
  | "schema-unreadable"
  | "library-missing";

export interface ZoteroAnnotationWriteRefusal {
  kind: "refused";
  code: ZoteroAnnotationWriteRefusalCode;
  /** What to tell a person, in their own words. A plain instruction, never a warning. */
  reason: string;
  signals: ZoteroLivenessSignal[];
  details: string[];
}

export interface NewZoteroAnnotation {
  libraryId: number;
  /** The attachment the annotation belongs to — the API's `parentItem`. */
  parentAttachmentKey: string;
  type: WritableZoteroAnnotationType;
  text: string | null;
  comment: string | null;
  color: string | null;
  pageLabel: string | null;
  sortIndex: string;
  /** JSON, in Zotero's own shape: `{ pageIndex, rects }`. Stored verbatim. */
  position: string;
  tags?: string[];
  /**
   * The reader's own key. Kept when it is valid and free, because ADR-0029 deduplicates the painted
   * union on it; replaced with a fresh one when it is malformed or already taken, and the caller is
   * told which key was actually written.
   */
  key?: string | null;
  authorName?: string | null;
}

export interface WrittenZoteroAnnotation {
  /** The key in the database, which may not be the key that was asked for. */
  key: string;
  itemId: number;
  /** True when `key` differs from the requested one. */
  keyReplaced: boolean;
}

export interface ImageAnnotationQuotation {
  libraryId: number;
  parentAttachmentKey: string;
  key: string;
  /** A complete human-readable `Quoted in "…" — date` line, formatted by the host. */
  comment: string;
}

export interface ImageAnnotationQuotationResult {
  /** False means this exact quotation line was already present and nothing was changed. */
  recorded: boolean;
}

export interface ZoteroAnnotationWriteSession {
  kind: "open";
  databasePath: string;
  /** The copy taken before this session wrote anything. Restore target if anything goes wrong. */
  backupPath: string;
  schema: ZoteroStructuralSchemaVersions;
  insert(annotation: NewZoteroAnnotation): WrittenZoteroAnnotation;
  insertMany(annotations: readonly NewZoteroAnnotation[]): WrittenZoteroAnnotation[];
  setImageQuotation?(input: ImageAnnotationQuotation): ImageAnnotationQuotationResult;
  close(): void;
}

interface ParentAttachmentRow {
  itemId: number;
  libraryId: number;
  contentType: string | null;
}

interface LibraryRow {
  type: string;
  editable: number;
}

function readStructuralSchemaVersions(
  databaseDriver: SqliteDriver,
  databasePath: string,
): ZoteroStructuralSchemaVersions {
  // The same immutable read-only open the read half uses (ADR-0002's read half, unchanged): it
  // cannot create or touch `-wal`/`-shm`, so a refusal on drift leaves the data directory alone.
  const database = databaseDriver.open(
    `${pathToFileURL(databasePath).href}?mode=ro&immutable=1`,
    { readonly: true },
  );
  try {
    const rows = database
      .prepare(
        `SELECT schema, version FROM version
         WHERE schema IN ('userdata', 'system')`,
      )
      .all() as Array<{ schema: string; version: number }>;
    const versions = new Map(rows.map((row) => [row.schema, row.version]));
    const userdata = versions.get("userdata");
    const system = versions.get("system");
    if (!Number.isInteger(userdata) || !Number.isInteger(system)) {
      throw new Error(
        "the database has no userdata/system version rows",
      );
    }
    return { system: system!, userdata: userdata! };
  } finally {
    database.close();
  }
}

/**
 * The pre-write copy (ADR-0031, decision 3). ~35 MB, so the cost is nothing and it turns recovery
 * from "re-sync from online" into "put back the copy from seconds ago" — local, instant, no network.
 *
 * The copy is named after the source's modification time, so a second write in the same session
 * reuses the existing copy rather than overwriting the only pre-write state with post-write state.
 */
export function copyZoteroDatabaseBeforeWriting(
  databasePath: string,
  backupDirectory: string,
  keep = 3,
): string {
  // The destination is ReadFlex's own, so the GENERAL guard applies to it with no exception.
  assertNotInZoteroDataDirectory(backupDirectory);
  mkdirSync(backupDirectory, { recursive: true });
  const backupPath = join(
    backupDirectory,
    `zotero-before-${Math.floor(statSync(databasePath).mtimeMs)}.sqlite`,
  );
  if (!existsSync(backupPath)) {
    copyFileSync(databasePath, backupPath);
  }
  pruneBackups(backupDirectory, keep);
  return backupPath;
}

function pruneBackups(backupDirectory: string, keep: number): void {
  if (keep <= 0) {
    return;
  }
  const backups = readdirSync(backupDirectory)
    .filter((name) => /^zotero-before-\d+\.sqlite$/.test(name))
    .map((name) => ({
      name,
      stamp: Number(name.replace(/\D/g, "")),
    }))
    .sort((left, right) => right.stamp - left.stamp);
  for (const stale of backups.slice(keep)) {
    const path = join(backupDirectory, stale.name);
    assertNotInZoteroDataDirectory(path);
    rmSync(path, { force: true });
  }
}

/**
 * Open a write session, or refuse and say why. **A refusal writes nothing** — every check that can
 * refuse runs before the database is opened for writing at all, so a refused call cannot change a
 * byte of the library. The order matters and is the order of ADR-0031's decisions:
 *
 * 1. The named guard exception, so a mistyped path throws rather than being written to.
 * 2. Is Zotero open? (decision 2)
 * 3. Has the schema moved past the pin? (decision 4)
 * 4. Copy the database. (decision 3)
 * 5. Take an exclusive lock — the last reading of "is Zotero open", and the one that cannot be
 *    fooled, because it asks SQLite instead of asking the operating system about names.
 */
export function openZoteroAnnotationWriteSession(
  databaseDriver: SqliteDriver,
  options: ZoteroAnnotationWriteSessionOptions,
): ZoteroAnnotationWriteSession | ZoteroAnnotationWriteRefusal {
  const databasePath =
    options.databasePath ??
    join(discoverZoteroDataDirectory().path, "zotero.sqlite");

  // ADR-0031 §5: the one named exception. Anything else inside Zotero's tree still throws.
  assertZoteroAnnotationWriteTarget(databasePath, {
    ...(options.zoteroDataDirectory
      ? { zoteroDataDirectory: options.zoteroDataDirectory }
      : {}),
  });

  if (!existsSync(databasePath)) {
    return {
      code: "library-missing",
      details: [`No Zotero library was found at ${databasePath}.`],
      kind: "refused",
      reason:
        "ReadFlex could not find your Zotero library, so the highlight is waiting instead.",
      signals: [],
    };
  }

  const liveness = zoteroLibraryLiveness(databasePath, options.liveness ?? {});
  if (liveness.open) {
    return {
      code: "zotero-is-open",
      details: liveness.details,
      kind: "refused",
      reason: "Close Zotero and this highlight will be saved to your library.",
      signals: liveness.signals,
    };
  }

  const pin = options.schemaPin ?? ZOTERO_STRUCTURAL_SCHEMA_PIN;
  let schema: ZoteroStructuralSchemaVersions;
  try {
    schema = readStructuralSchemaVersions(databaseDriver, databasePath);
  } catch (error) {
    return {
      code: "schema-unreadable",
      details: [error instanceof Error ? error.message : String(error)],
      kind: "refused",
      reason:
        "ReadFlex could not read your Zotero library's schema version, so it is not writing to it. The highlight is waiting.",
      signals: [],
    };
  }
  const drift = (["userdata", "system"] as const).filter(
    (name) => schema[name] !== pin[name],
  );
  if (drift.length > 0) {
    return {
      code: "schema-drift",
      details: drift.map(
        (name) =>
          `${name}: ReadFlex is built for ${pin[name]}, your Zotero database reports ${schema[name]}`,
      ),
      kind: "refused",
      // ADR-0005: a staged failure, never a guess. The highlight stays in the outbox.
      reason:
        "Zotero has updated its database since this version of ReadFlex was checked against it, so ReadFlex is not writing to it. Your highlight is saved here and waiting.",
      signals: [],
    };
  }

  const backupPath = copyZoteroDatabaseBeforeWriting(
    databasePath,
    options.backupDirectory,
    options.keepBackups ?? 3,
  );

  const database = databaseDriver.open(databasePath);
  try {
    // No waiting: a lock we cannot take instantly means someone else has the library, and the
    // honest answer is to refuse rather than to block the reader's save behind a timeout.
    database.run("PRAGMA busy_timeout = 0");
    database.run("PRAGMA foreign_keys = ON");
    database.run("BEGIN IMMEDIATE");
    database.run("ROLLBACK");
  } catch (error) {
    database.close();
    return {
      code: "zotero-is-open",
      details: [
        `Your Zotero library is locked by another program: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      kind: "refused",
      reason: "Close Zotero and this highlight will be saved to your library.",
      signals: ["database-locked"],
    };
  }

  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  return {
    backupPath,
    close() {
      database.close();
    },
    databasePath,
    insert(annotation) {
      return insertZoteroAnnotation(database, annotation, { now, random });
    },
    insertMany(annotations) {
      return insertZoteroAnnotationsAtomically(database, annotations, { now, random });
    },
    setImageQuotation(input) {
      return setZoteroImageQuotation(database, input, now);
    },
    kind: "open",
    schema,
  };
}

/**
 * Append one quotation-provenance line to a ReadFlex-created Zotero image annotation.
 *
 * This is intentionally not a general annotation update. The complete annotation identity is
 * re-established inside the transaction and the SQL can touch only the comment and Zotero's local
 * sync bookkeeping. Geometry, colour, text, tags and remote version are absent from the input and
 * absent from every UPDATE statement.
 */
export function setZoteroImageQuotation(
  database: SqliteDatabase,
  input: ImageAnnotationQuotation,
  now: () => Date = () => new Date(),
): ImageAnnotationQuotationResult {
  const quotation = input.comment.trim();
  if (!/^Quoted in ".+" — \d{1,2} [A-Za-z]+ \d{4}$/.test(quotation)) {
    throw new Error("The Area quotation record was not in the accepted form.");
  }
  if (new TextEncoder().encode(quotation).length > 4096) {
    throw new Error("The Area quotation record was too long.");
  }

  database.run("BEGIN IMMEDIATE");
  try {
    const library = database.prepare(
      "SELECT type, editable FROM libraries WHERE libraryID = ?",
    ).get(input.libraryId) as LibraryRow | undefined;
    if (!library || library.editable !== 1 || library.type !== "user") {
      throw new Error("ReadFlex can record Area quotations only in your editable personal Zotero library.");
    }
    const row = database.prepare(
      `SELECT annotation.itemID AS itemId, annotation.comment
       FROM itemAnnotations AS annotation
       JOIN items AS item ON item.itemID = annotation.itemID
       JOIN items AS parent ON parent.itemID = annotation.parentItemID
       WHERE item.libraryID = ?
         AND item.key = ?
         AND parent.libraryID = item.libraryID
         AND parent.key = ?
         AND annotation.type = 3
         AND annotation.isExternal = 0`,
    ).get(
      input.libraryId,
      input.key,
      input.parentAttachmentKey,
    ) as { itemId: number; comment: string | null } | undefined;
    if (!row) {
      throw new Error("The matching Zotero Area annotation could not be found, so its quotation was not recorded.");
    }
    const current = row.comment ?? "";
    const lines = current.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (lines.includes(quotation)) {
      database.run("COMMIT");
      return { recorded: false };
    }
    const comment = current ? `${current}\n\n${quotation}` : quotation;
    if (new TextEncoder().encode(comment).length > 2048) {
      throw new Error("The existing Zotero comment leaves no safe room for this quotation record.");
    }
    const timestamp = zoteroSqlDateTime(now());
    database.prepare(
      `UPDATE libraries
       SET clientVersion = clientVersion + 1
       WHERE libraryID = ?`,
    ).run(input.libraryId);
    const version = database.prepare(
      "SELECT clientVersion FROM libraries WHERE libraryID = ?",
    ).get(input.libraryId) as { clientVersion: number };
    database.prepare(
      `UPDATE itemAnnotations
       SET comment = ?, commentNormalized = ?
       WHERE itemID = ?`,
    ).run(comment, normaliseForZoteroSearchStorage(comment), row.itemId);
    database.prepare(
      `UPDATE items
       SET dateModified = ?, clientDateModified = ?, synced = 0, clientVersion = ?
       WHERE itemID = ?`,
    ).run(timestamp, timestamp, version.clientVersion, row.itemId);
    database.run("COMMIT");
    checkpointWriteAheadLog(database);
    return { recorded: true };
  } catch (error) {
    try {
      database.run("ROLLBACK");
    } catch {
      // Preserve the error that required the rollback.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The insert
// ---------------------------------------------------------------------------

/**
 * Fold the write-ahead log back into `zotero.sqlite` and empty it.
 *
 * **Not housekeeping — a correctness requirement, and one that only shows up at the seam.** Zotero's
 * database is persistently in WAL mode, so a committed insert lives in `zotero.sqlite-wal` until a
 * checkpoint. The read half opens the library with `immutable=1` (ADR-0002), which tells SQLite the
 * file cannot change and therefore to **ignore the `-wal` entirely** — so without this, ReadFlex
 * would write a highlight, report success, and then not be able to read it back. Checkpointing also
 * leaves the data directory in the state a cleanly quit Zotero leaves it: an empty `-wal`, which is
 * what {@link zoteroLibraryLiveness} expects to see next time.
 *
 * A failed checkpoint is not a failed write. The transaction has already committed, so the row is
 * durable either way and swallowing the error is the honest response.
 */
function checkpointWriteAheadLog(database: SqliteDatabase): void {
  try {
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Committed is committed. The next session's checkpoint will pick this up.
  }
}

function annotationTypeId(type: WritableZoteroAnnotationType): number {
  const id = ANNOTATION_TYPE_IDS[type];
  if (!id) {
    throw new Error(`Zotero has no annotation type called '${type}'.`);
  }
  return id;
}

function requireValidPosition(position: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(position);
  } catch {
    throw new Error(
      "This highlight's position could not be read, so it was not written to Zotero.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { pageIndex?: unknown }).pageIndex !== "number"
  ) {
    throw new Error(
      "This highlight's position is not in Zotero's own shape, so it was not written.",
    );
  }
  return position;
}

function freeKey(
  database: SqliteDatabase,
  libraryId: number,
  requested: string | null | undefined,
  random: () => number,
): { key: string; keyReplaced: boolean } {
  // `null` and `undefined` both mean "no row": `bun:sqlite` returns the first and `node:sqlite` the
  // second, and reading only one of them would report every key as taken.
  const taken = (key: string): boolean =>
    database
      .prepare("SELECT 1 FROM items WHERE libraryID = ? AND key = ?")
      .get(libraryId, key) != null;

  if (requested && isValidZoteroObjectKey(requested) && !taken(requested)) {
    return { key: requested, keyReplaced: false };
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const key = generateZoteroObjectKey(random);
    if (!taken(key)) {
      return { key, keyReplaced: true };
    }
  }
  throw new Error("Could not generate an unused Zotero item key.");
}

function tagId(
  database: SqliteDatabase,
  name: string,
): number {
  const existing = database
    .prepare("SELECT tagID AS tagId FROM tags WHERE name = ?")
    .get(name) as { tagId: number } | undefined;
  if (existing) {
    return existing.tagId;
  }
  const inserted = database
    .prepare("INSERT INTO tags (name, nameNormalized) VALUES (?, ?)")
    .run(name, normaliseForZoteroSearchStorage(name));
  return Number(inserted.lastInsertRowid);
}

function insertZoteroAnnotationRow(
  database: SqliteDatabase,
  annotation: NewZoteroAnnotation,
  helpers: { now: () => Date; random: () => number },
): WrittenZoteroAnnotation {
  if (!annotation.sortIndex) {
    throw new Error(
      "This highlight has no sort index, so Zotero could not place it in the document.",
    );
  }
  const position = requireValidPosition(annotation.position);
  const typeId = annotationTypeId(annotation.type);

  const library = database
    .prepare("SELECT type, editable FROM libraries WHERE libraryID = ?")
    .get(annotation.libraryId) as LibraryRow | undefined;
  if (!library) {
    throw new Error(
      "That Zotero library is not on this machine, so the highlight was not written.",
    );
  }
  if (library.editable !== 1) {
    throw new Error(
      "That Zotero library is read-only, so the highlight was not written.",
    );
  }
  // Group libraries are excluded deliberately (ADR-0031): a local group-library write
  // can be synchronised to other members. Restrict writes to the personal library.
  if (library.type !== "user") {
    throw new Error(
      "ReadFlex only writes highlights to your own library, not to a shared group library. This highlight is saved here and waiting.",
    );
  }

  const parent = database
    .prepare(
      `SELECT
         attachment.itemID AS itemId,
         attachmentItem.libraryID AS libraryId,
         attachment.contentType AS contentType
       FROM itemAttachments AS attachment
       JOIN items AS attachmentItem
         ON attachmentItem.itemID = attachment.itemID
       WHERE attachmentItem.libraryID = ?
         AND attachmentItem.key = ?`,
    )
    .get(
      annotation.libraryId,
      annotation.parentAttachmentKey,
    ) as ParentAttachmentRow | undefined;
  if (!parent) {
    throw new Error(
      "The document this highlight belongs to is no longer in Zotero, so the highlight was not written.",
    );
  }

  const annotationTypeRow = database
    .prepare(
      "SELECT itemTypeID AS itemTypeId FROM itemTypes WHERE typeName = 'annotation'",
    )
    .get() as { itemTypeId: number } | undefined;
  if (!annotationTypeRow) {
    throw new Error(
      "This Zotero database has no annotation item type, so the highlight was not written.",
    );
  }

  const { key, keyReplaced } = freeKey(
    database,
    annotation.libraryId,
    annotation.key,
    helpers.random,
  );
  const timestamp = zoteroSqlDateTime(helpers.now());

  const insertedItem = database
    .prepare(
      `INSERT INTO items (
         itemTypeID, dateAdded, dateModified, clientDateModified,
         libraryID, key, version, synced
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      annotationTypeRow.itemTypeId,
      timestamp,
      timestamp,
      timestamp,
      annotation.libraryId,
      key,
    );
  const itemId = Number(insertedItem.lastInsertRowid);

  const text = annotation.text || null;
  const comment = annotation.comment || null;
  database
    .prepare(
      `INSERT INTO itemAnnotations (
         itemID, parentItemID, type, authorName,
         text, textNormalized, comment, commentNormalized,
         color, pageLabel, sortIndex, position, isExternal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      itemId,
      parent.itemId,
      typeId,
      annotation.authorName || null,
      text,
      normaliseForZoteroSearchStorage(text),
      comment,
      normaliseForZoteroSearchStorage(comment),
      annotation.color || ZOTERO_DEFAULT_ANNOTATION_COLOUR,
      annotation.pageLabel || null,
      annotation.sortIndex,
      position,
    );

  for (const rawTag of annotation.tags ?? []) {
    const name = rawTag.trim();
    if (!name) {
      continue;
    }
    database
      .prepare(
        "INSERT OR REPLACE INTO itemTags (itemID, tagID, type) VALUES (?, ?, 0)",
      )
      .run(itemId, tagId(database, name));
  }

  return { itemId, key, keyReplaced };
}

/**
 * The transaction boundary is the user's action. One PDF-view mark is the one-element case; a
 * clean-view selection crossing a page break supplies every per-page row together.
 */
function insertZoteroAnnotationsAtomically(
  database: SqliteDatabase,
  annotations: readonly NewZoteroAnnotation[],
  helpers: { now: () => Date; random: () => number },
): WrittenZoteroAnnotation[] {
  if (annotations.length === 0) {
    return [];
  }
  database.run("BEGIN IMMEDIATE");
  try {
    const written = annotations.map((annotation) =>
      insertZoteroAnnotationRow(database, annotation, helpers),
    );
    database.run("COMMIT");
    checkpointWriteAheadLog(database);
    return written;
  } catch (error) {
    try {
      database.run("ROLLBACK");
    } catch {
      // Preserve the error that required the rollback.
    }
    throw error;
  }
}

/** The existing single-annotation API is the one-element user-action case. */
export function insertZoteroAnnotation(
  database: SqliteDatabase,
  annotation: NewZoteroAnnotation,
  helpers: { now: () => Date; random: () => number } = {
    now: () => new Date(),
    random: Math.random,
  },
): WrittenZoteroAnnotation {
  return insertZoteroAnnotationsAtomically(database, [annotation], helpers)[0]!;
}

/** The annotation types this write path can produce. `unknown` is not one of them. */
export function isWritableAnnotationType(
  type: ZoteroAnnotationType,
): type is WritableZoteroAnnotationType {
  return type in ANNOTATION_TYPE_IDS;
}
