import { stat } from "node:fs/promises";
import type { PackRunResult, PackRunner } from "@bridle/contract";
import type { Adapter, RunContext } from "@bridle/model-access";

type SuccessfulPackRun = Extract<PackRunResult, { ok: true }>;

export interface TaskPackMapping {
  scriptId: string;
  toArgs: (input: unknown) => Record<string, unknown>;
  touchedPaths: (input: unknown) => string[];
  toOutput: (result: SuccessfulPackRun, input: unknown) => unknown;
}

export interface PackAdapterOptions {
  id: string;
  packRoot: string;
  workspaceDir: string;
  mappings: Record<string, TaskPackMapping>;
  overwritePolicy?: "error-if-exists" | "allow";
}

export function makePackAdapter(runner: PackRunner, opts: PackAdapterOptions): Adapter {
  const tasks = Object.keys(opts.mappings);
  const overwritePolicy = opts.overwritePolicy ?? "error-if-exists";

  return {
    id: opts.id,
    transport: "pack",
    egress: "none",
    tasks,
    async isAvailable() {
      const availability = await Promise.all(
        Object.values(opts.mappings).map((mapping) => runner.availability(opts.packRoot, mapping.scriptId)),
      );
      return availability.every((item) => item.ready);
    },
    async execute(taskId: string, input: unknown, ctx: RunContext) {
      const mapping = opts.mappings[taskId];
      if (!mapping) throw new Error(`perception pack adapter does not serve task: ${taskId}`);

      const touchedPaths = mapping.touchedPaths(input);
      if (overwritePolicy === "error-if-exists") await assertNoExistingOutputs(touchedPaths);
      const result = await runner.run({
        packRoot: opts.packRoot,
        scriptId: mapping.scriptId,
        args: mapping.toArgs(input),
        workspaceDir: opts.workspaceDir,
        touchedPaths,
        signal: ctx.signal,
        onEvent: ctx.onEvent,
      });
      return mapping.toOutput(interpretPackResult(result, mapping.scriptId), input);
    },
  };
}

export function interpretPackResult(result: PackRunResult, scriptId: string): SuccessfulPackRun {
  if (result.ok) return result;
  if (result.denied) {
    const detail = result.denied.detail ? `: ${result.denied.detail}` : "";
    throw new Error(`Pack script ${scriptId} denied by Runner Sandbox rule ${result.denied.rule}${detail}`);
  }
  throw new Error(result.error ?? `Pack script ${scriptId} failed without an error message.`);
}

async function assertNoExistingOutputs(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (await pathExists(path)) {
      throw new Error(`perception pack adapter refuses to overwrite existing output: ${path} (pass overwritePolicy:'allow' to permit)`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
