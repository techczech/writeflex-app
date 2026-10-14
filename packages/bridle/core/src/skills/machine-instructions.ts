import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * PRD 2026-07-18 S5: the machine custom-instructions layer — one file of the
 * user's own "how I like things", shared by ALL Bridle apps on the machine.
 * Apps load it into PromptComposition.customInstructions; S2 composes it above
 * app skills. Machine-wide by design, so it lives under ~/.bridle, never in an
 * app's data dir. The import UI (owed) may pass an explicit path instead.
 */

export function defaultMachineInstructionsPath(): string {
  return join(homedir(), ".bridle", "custom-instructions.md");
}

/**
 * Missing or empty file = the layer simply isn't there (null). ONLY a missing
 * file: any other filesystem failure propagates (Sol F5 — a permission
 * regression must not silently strip the user's machine-wide layer from every
 * app while looking like "no instructions").
 */
export async function loadMachineInstructions(path = defaultMachineInstructionsPath()): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** Atomic: write a sibling temp file, then rename — an interrupted save can never truncate the machine-wide file. */
export async function saveMachineInstructions(text: string, path = defaultMachineInstructionsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temp, text, "utf8");
  await rename(temp, path);
}
