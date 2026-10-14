import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * PRD 2026-07-18 S6: AGENTS.md is the space's contract for roaming external
 * agents — folder conventions + the machine custom-instructions projected down.
 * It never mirrors the app's internal SKILL.md bundles (those are app UI
 * actions, meaningless to an outside agent).
 *
 * Marker discipline (Sol review round 2, F4): markers are parsed as exact
 * STANDALONE LINES, never substrings — a hand-authored file that merely
 * mentions the markers in prose is preserved wholesale. Exactly one start line
 * followed by exactly one end line is a generated region we own; zero of both
 * is a hand-authored file we fold in below the new region; anything else is
 * malformed and FAILS LOUDLY with the file untouched — never a silent slice
 * that discards someone's hand-written content. Generated inputs are rejected
 * if they contain a marker line of their own (no smuggling).
 */

const START = (appId: string) => `<!-- bridle:generated:start (${appId}) — this region is regenerated; write below the end marker -->`;
const START_LINE_RE = /^<!-- bridle:generated:start .*-->$/;
const END = "<!-- bridle:generated:end -->";

export type ProjectAgentsMdOptions = {
  folder: string;
  appId: string;
  /** Folder conventions the app wants a visiting agent to respect. */
  conventions?: readonly string[];
  /** The machine custom-instructions layer (S5), projected down; null = absent. */
  machineInstructions?: string | null;
};

const isStartLine = (line: string) => START_LINE_RE.test(line.trim());
const isEndLine = (line: string) => line.trim() === END;

function assertNoMarkerLines(text: string, what: string): void {
  for (const line of text.split("\n")) {
    if (isStartLine(line) || isEndLine(line)) {
      throw new Error(`AGENTS.md projection: ${what} contains a generated-region marker line — refusing to project.`);
    }
  }
}

export async function projectAgentsMd(opts: ProjectAgentsMdOptions): Promise<string> {
  const path = join(opts.folder, "AGENTS.md");

  const generated: string[] = [START(opts.appId), "# Working in this folder", ""];
  for (const convention of opts.conventions ?? []) {
    assertNoMarkerLines(convention, "a convention");
    generated.push(`- ${convention}`);
  }
  if (opts.machineInstructions?.trim()) {
    assertNoMarkerLines(opts.machineInstructions, "the machine instructions");
    generated.push("", "Your user's standing instructions:", "", opts.machineInstructions.trim());
  }
  generated.push("", END);

  let hand = "";
  let existing: string | null = null;
  try { existing = await readFile(path, "utf8"); } catch { /* no file yet */ }
  if (existing !== null) {
    const lines = existing.split("\n");
    const startAt = lines.reduce<number[]>((hits, line, index) => (isStartLine(line) ? [...hits, index] : hits), []);
    const endAt = lines.reduce<number[]>((hits, line, index) => (isEndLine(line) ? [...hits, index] : hits), []);
    if (startAt.length === 0 && endAt.length === 0) {
      // A file we did not generate: all of it is hand-authored.
      hand = existing;
    } else if (startAt.length === 1 && endAt.length === 1 && startAt[0]! < endAt[0]!) {
      hand = lines.slice(endAt[0]! + 1).join("\n").replace(/^\n+/, "");
    } else {
      throw new Error(
        `AGENTS.md projection: malformed generated-region markers in ${path} ` +
        `(${startAt.length} start / ${endAt.length} end) — fix the file by hand; nothing was changed.`,
      );
    }
  }

  const content = hand.trim() ? `${generated.join("\n")}\n\n${hand.replace(/\n+$/, "")}\n` : `${generated.join("\n")}\n`;
  await writeFile(path, content, "utf8");
  return content;
}
