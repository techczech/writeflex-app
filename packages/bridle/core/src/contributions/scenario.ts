import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PackRunner, RecorderExpectation, ScenarioDecl } from "@bridle/contract";

const CHECKER_MESSAGE_MAX_BYTES = 4_096;
const CHECKER_STDOUT_MAX_BYTES = 64 * 1_024;

type SearchRecorder = {
  searchRecord(query: string, filter?: { from?: number; to?: number }): Promise<{
    items: Array<{ entryId: string; preview: string }>;
  }>;
};

export type ScenarioAssertion = {
  kind: "golden" | "output" | "evidence";
  label: string;
  passed: boolean;
  message?: string;
};

export type ScenarioCheckerEvidence = {
  trusted: false;
  passed: boolean;
  message: string;
  truncated: boolean;
};

export type ScenarioEvaluation = {
  state: "passed" | "failed" | "skipped" | "infra-error" | "not-assessable";
  assertions: ScenarioAssertion[];
  reason?: string;
  checker?: ScenarioCheckerEvidence;
};

export type ScenarioEvaluationOptions = {
  scenarioRoot?: string;
  platform?: string;
  recording?: "full" | "off" | { retainDays: number };
  packRunner?: Pick<PackRunner, "run">;
  checkerConfinementVerified?: boolean;
};

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function safePath(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  if (!isWithin(resolve(root), absolute)) throw new Error("scenario-path-outside-root");
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(absolute)]);
  if (!isWithin(resolvedRoot, resolvedPath)) throw new Error("scenario-path-outside-root");
  return resolvedPath;
}

async function assertTreeConfined(root: string, path: string): Promise<void> {
  const [resolvedRoot, resolved] = await Promise.all([realpath(root), realpath(path)]);
  if (!isWithin(resolvedRoot, resolved)) throw new Error("scenario-path-outside-root");
  const info = await lstat(resolved);
  if (!info.isDirectory()) return;
  for (const name of await readdir(resolved)) await assertTreeConfined(resolvedRoot, join(resolved, name));
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function checkEvidence(recorder: SearchRecorder, expectation: RecorderExpectation, runId: string): Promise<ScenarioAssertion> {
  const result = await recorder.searchRecord(expectation.contains);
  const passed = result.items.some((item) =>
    (item.entryId.includes(runId) || item.preview.includes(runId))
    && item.entryId.includes(expectation.store)
    && item.preview.includes(expectation.contains));
  return {
    kind: "evidence",
    label: `${expectation.store}:${expectation.contains}`,
    passed,
    ...(!passed ? { message: `No ${expectation.store} evidence for run ${runId} contained ${expectation.contains}.` } : {}),
  };
}

async function countValue(path: string, bytes: Buffer): Promise<number> {
  const info = await stat(path);
  if (info.isDirectory()) return (await readdir(path)).length;
  const text = bytes.toString("utf8");
  try {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value)) return value.length;
  } catch {
    // Plain text count is its non-empty line count.
  }
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

async function outputAssertion(root: string, check: ScenarioDecl["expect"]["output"] extends readonly (infer T)[] | undefined ? T : never): Promise<ScenarioAssertion> {
  const label = `${check.kind}:${check.path}`;
  try {
    const path = await safePath(root, check.path);
    if (check.kind === "exists") {
      await stat(path);
      return { kind: "output", label, passed: true };
    }
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    let passed = false;
    if (check.kind === "nonEmpty") passed = bytes.byteLength > 0;
    else if (check.kind === "contains") passed = text.includes(check.value);
    else if (check.kind === "regex") passed = new RegExp(check.pattern, "u").test(text);
    else if (check.kind === "minLength") passed = [...text].length >= check.value;
    else if (check.kind === "count") passed = await countValue(path, bytes) === check.value;
    return { kind: "output", label, passed, ...(!passed ? { message: `Output check failed: ${label}` } : {}) };
  } catch (error) {
    return { kind: "output", label, passed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function escapeUntrusted(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function capUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return { value: result, truncated: true };
}

async function runChecker(
  decl: ScenarioDecl,
  options: ScenarioEvaluationOptions,
): Promise<{ checker?: ScenarioCheckerEvidence; skipped?: string; error?: string }> {
  const checker = decl.expect.checker;
  if (!checker) return {};
  if (options.platform === "win32" || !options.checkerConfinementVerified) {
    return { skipped: "checker-disabled-unverified-platform" };
  }
  if (!options.packRunner || !options.scenarioRoot) return { error: "Checker requires a PackRunner and scenarioRoot." };
  const packRoot = await safePath(options.scenarioRoot, checker.script.packRoot);
  const checkerPath = await safePath(packRoot, checker.script.scriptId);
  let checkerBytes: Buffer;
  try {
    checkerBytes = await readFile(checkerPath);
  } catch {
    return { error: "checker-hash-mismatch" };
  }
  if (sha256(checkerBytes) !== checker.hash) return { error: "checker-hash-mismatch" };

  const stage = await mkdtemp(join(tmpdir(), "bridle-checker-"));
  try {
    for (const sourceName of ["fixtures", decl.outputRoot]) {
      const destinationName = sourceName === decl.outputRoot ? "outputs" : "fixtures";
      const source = await safePath(options.scenarioRoot, sourceName);
      await assertTreeConfined(options.scenarioRoot, source);
      const destination = join(stage, destinationName);
      try {
        await cp(source, destination, { recursive: true, dereference: true });
      } catch {
        await mkdir(destination, { recursive: true });
      }
    }
    const result = await options.packRunner.run({
      packRoot,
      scriptId: checker.script.scriptId,
      args: { outputs: "outputs", fixtures: "fixtures" },
      workspaceDir: stage,
      network: "none",
      touchedPaths: [],
    });
    if (!result.ok) return { error: result.denied?.rule ?? result.error ?? "Checker failed to run." };
    const rawBytes = Buffer.byteLength(result.stdoutPreview, "utf8");
    if (rawBytes > CHECKER_STDOUT_MAX_BYTES) return { error: "Checker stdout exceeded 65536 bytes." };
    let verdict: { passed?: unknown; message?: unknown };
    try {
      verdict = JSON.parse(result.stdoutPreview) as { passed?: unknown; message?: unknown };
    } catch {
      return { error: "Checker did not return a JSON verdict." };
    }
    if (typeof verdict.passed !== "boolean" || typeof verdict.message !== "string") {
      return { error: "Checker verdict must contain boolean passed and string message." };
    }
    const capped = capUtf8(escapeUntrusted(verdict.message), CHECKER_MESSAGE_MAX_BYTES);
    return { checker: { trusted: false, passed: verdict.passed, message: capped.value, truncated: capped.truncated } };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function evaluateScenarioExpectations(
  recorder: SearchRecorder,
  decl: ScenarioDecl,
  runId: string,
  options: ScenarioEvaluationOptions = {},
): Promise<ScenarioEvaluation> {
  if (options.recording === "off") return { state: "not-assessable", reason: "recording-off", assertions: [] };
  const assertions: ScenarioAssertion[] = [];
  try {
    for (const expectation of decl.expect.evidence) assertions.push(await checkEvidence(recorder, expectation, runId));
    if ((decl.expect.golden?.length || decl.expect.output?.length) && !options.scenarioRoot) {
      return { state: "infra-error", reason: "scenarioRoot is required for output expectations", assertions };
    }
    if (options.scenarioRoot) {
      for (const fixture of decl.fixtures) await safePath(options.scenarioRoot, fixture.path);
    }
    for (const golden of decl.expect.golden ?? []) {
      try {
        const actual = sha256(await readFile(await safePath(options.scenarioRoot!, golden.path)));
        assertions.push({
          kind: "golden", label: golden.path, passed: actual === golden.hash,
          ...(actual !== golden.hash ? { message: `Golden hash mismatch: expected ${golden.hash}, got ${actual}` } : {}),
        });
      } catch (error) {
        assertions.push({ kind: "golden", label: golden.path, passed: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const output of decl.expect.output ?? []) assertions.push(await outputAssertion(options.scenarioRoot!, output));
    const checkerResult = await runChecker(decl, options);
    if (checkerResult.skipped) return { state: "skipped", reason: checkerResult.skipped, assertions };
    if (checkerResult.error) return { state: "infra-error", reason: checkerResult.error, assertions };
    const passed = assertions.every((item) => item.passed) && (checkerResult.checker?.passed ?? true);
    return { state: passed ? "passed" : "failed", assertions, ...(checkerResult.checker ? { checker: checkerResult.checker } : {}) };
  } catch (error) {
    return { state: "infra-error", reason: error instanceof Error ? error.message : String(error), assertions };
  }
}
