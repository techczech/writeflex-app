import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { projectUserContext, type TranscriptOptions } from "./transcript-user-context.ts";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * One message of a persisted session's CURRENT BRANCH, as Pi itself would replay it. The shape is
 * Pi's own Message union viewed loosely — callers map roles/content with their existing rules.
 * New user messages project content from the saved split; legacy unsplit content stays verbatim.
 */
export type PersistedSessionMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: unknown;
  hiddenContext?: string;
};

export type PersistedSessionTranscript = {
  messages: PersistedSessionMessage[];
  /** Null when the read succeeded (including "no session was ever flushed"); a human-readable
   *  reason otherwise — absence and failure are different facts (Sol B1 round-4). */
  error: string | null;
};

/**
 * Read the most recent persisted session under `sessionDir` WITHOUT starting an agent — the
 * transcript of a session whose instance cannot boot (e.g. a skill-bound thread whose SKILL.md
 * went malformed) is still on disk.
 *
 * Strictly READ-ONLY: Pi's `SessionManager.open` is a persistent manager that migrates v1/v2
 * files in place and REPLACES a corrupt file with a fresh empty header — a history fallback must
 * never destroy the evidence it failed to read (Sol B1 round-4). This uses the exported read-only
 * trio instead: `loadEntriesFromFile` (O_RDONLY) + `migrateSessionEntries` (in memory) +
 * `buildSessionContext` (current-branch resolution from the file's leaf).
 *
 * Session selection mirrors `SessionManager.continueRecent` for a custom sessionDir — header-valid
 * `.jsonl` files, filtered by cwd when given, newest by MODIFICATION time (an older session file
 * resumed and appended IS the most recent session; filename order is creation order and diverges).
 */
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

function parseSessionHeaderCandidate(line: string): { cwd?: unknown } | null | undefined {
  if (!line.trim()) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const header = entry as { type?: unknown; id?: unknown; cwd?: unknown };
  if (header.type !== "session" || typeof header.id !== "string") return null;
  return header;
}

/** Pi 0.83's bounded discovery read, transcribed without opening a persistent manager. */
async function readSessionHeaderForDiscovery(path: string): Promise<{ cwd?: unknown } | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
    const lineChunks: string[] = [];
    let scannedBytes = 0;
    while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
      const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
      const { bytesRead } = await handle.read(buffer, 0, readLength, null);
      if (bytesRead === 0) {
        lineChunks.push(decoder.end());
        return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
      }
      scannedBytes += bytesRead;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      let lineStart = 0;
      let newlineIndex = chunk.indexOf("\n", lineStart);
      while (newlineIndex !== -1) {
        lineChunks.push(chunk.slice(lineStart, newlineIndex));
        const header = parseSessionHeaderCandidate(lineChunks.join(""));
        if (header !== undefined) return header;
        lineChunks.length = 0;
        lineStart = newlineIndex + 1;
        newlineIndex = chunk.indexOf("\n", lineStart);
      }
      lineChunks.push(chunk.slice(lineStart));
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(probe, 0, 1, null);
    if (bytesRead === 0) {
      lineChunks.push(decoder.end());
      return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Pi's resolvePath for header cwds, re-checked against 0.83.0's default option path
 * (dist/utils/paths.js normalizePath+resolvePath): tilde expansion (incl. win32 `~\\`), then
 * file:// URL conversion, then node resolve. `sessionCwdMatches` passes no options, so trim /
 * unicode-space / at-prefix handling never applies on this path.
 */
function piResolvePath(input: string): string {
  let normalized = input;
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = join(homedir(), normalized.slice(2));
  } else if (/^file:\/\//.test(normalized)) {
    normalized = fileURLToPath(normalized);
  }
  return resolve(normalized);
}

export async function readLatestSessionTranscript(sessionDir: string, cwd?: string, options: TranscriptOptions = {}): Promise<PersistedSessionTranscript> {
  let names: string[];
  try {
    names = (await readdir(sessionDir)).filter((file) => file.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { messages: [], error: null };
    return { messages: [], error: `Could not list the session directory: ${(error as Error).message}` };
  }
  if (names.length === 0) return { messages: [], error: null };

  const resolvedCwd = cwd ? piResolvePath(cwd) : undefined;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of names) {
    const path = join(sessionDir, name);
    try {
      // Pi-parity eligibility: a faithful transcription of Pi 0.83.0's bounded
      // readSessionHeader + sessionCwdMatches (dist/core/session-manager.js — not exported from
      // the package index, and its exports map blocks subpath imports). Pi scans up to 1 MiB,
      // skips blank or malformed physical lines, and accepts ANY string id, empty included.
      const header = await readSessionHeaderForDiscovery(path);
      if (header === null) continue;
      if (resolvedCwd) {
        const headerCwd = typeof header.cwd === "string" ? header.cwd : undefined;
        if (headerCwd === undefined || headerCwd === "" || piResolvePath(headerCwd) !== resolvedCwd) continue;
      }
      candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      continue; // headerless/corrupt candidates are skipped, never "repaired"
    }
  }
  if (candidates.length === 0) {
    return { messages: [], error: "No readable session file — the persisted history may be corrupt." };
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates[0]!;

  try {
    // parseSessionEntries is the read-only line parser (the header row is not a branch entry).
    const parsed = parseSessionEntries(await readFile(newest.path, "utf8"));
    migrateSessionEntries(parsed as never);
    const entries = (parsed as Array<{ type?: string }>).filter((entry) => entry.type !== "session") as SessionEntry[];
    if (entries.length === 0) {
      return { messages: [], error: "The session file could not be parsed." };
    }
    // Default leaf = the file's last entry — the same leaf a live resume of this file starts from.
    return {
      messages: (buildSessionContext(entries).messages as PersistedSessionMessage[])
        .map((message) => projectUserContext(message, options)),
      error: null,
    };
  } catch (error) {
    return { messages: [], error: `Could not read the session: ${(error as Error).message}` };
  }
}
