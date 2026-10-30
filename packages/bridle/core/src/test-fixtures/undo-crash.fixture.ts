import { spyOn } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { TurnScript } from "@bridle/contract";
import { BridleAuth } from "../auth.ts";
import { createBridle } from "../harness.ts";
import { scriptedSessionFactory } from "../scripted.ts";
import { VersionStore } from "../versioning/store.ts";
import type { Capability } from "../types.ts";

export const writeTurn = (prompt: string, names: string[]): TurnScript => ({ prompt, rounds: [
  { kind: "tool-calls", calls: names.map((name) => ({ name: `fixture.${name}`, arguments: {} })) },
  { kind: "message", text: "Done" },
] });
export async function crashFixture(dir: string, scripts: TurnScript[], versioning: boolean, recording: boolean) {
  const root = join(dir, "workspace");
  const capabilities: Capability[] = ["doc", "other"].map((name) => ({
    name: `fixture.${name}`, risk: "write", description: "Fixture write", parameters: Type.Object({}),
    touchedPaths: () => [join(root, `${name}.md`)],
    execute: async () => { await writeFile(join(root, `${name}.md`), "A"); return { text: "written" }; },
  }));
  return createBridle({
    manifest: { appId: "undo-crash", workspaceRoot: root, capabilities },
    appDataDir: join(dir, "app"), auth: BridleAuth.inMemory(), recording: recording ? "full" : "off",
    session: scriptedSessionFactory(scripts), ...(versioning ? { versioning: { enabled: true } } : {}),
  });
}

if (import.meta.main) {
  const [dir, versionFlag, recordingFlag, mode] = process.argv.slice(2);
  if (!dir) throw new Error("Missing fixture directory");
  const versioning = versionFlag === "1";
  const scripts = mode === "single" ? [writeTurn("one", ["doc", "other"])]
    : [writeTurn("one", ["doc"]), writeTurn("two", ["other"])];
  const bridle = await crashFixture(dir, scripts, versioning, recordingFlag === "1");
  const one = await bridle.prompt("one");
  const two = mode === "single" ? undefined : await bridle.prompt("two");
  await writeFile(join(dir, "ids.json"), JSON.stringify({ one: one.turnId, two: two?.turnId }));
  const crash = async (): Promise<never> => {
    await writeFile(join(dir, "workspace", mode === "single" ? "doc.md" : "other.md"), mode === "single" ? "X" : "other X");
    process.exit(9);
  };
  if (versioning) spyOn(VersionStore.prototype, "readObject").mockImplementation(crash);
  else spyOn(bridle.snapshots, "restoreTo").mockImplementation(crash);
  await bridle.turns.undo(one.turnId, two ? { includingLater: true } : undefined);
  throw new Error("Fixture did not crash");
}
