import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export interface RunnerSandboxPolicy {
  /** Broad runtime reads are the established WRITE-pack policy; READ packs opt into a narrower profile. */
  readScope?: "broad" | "least-privilege";
  /**
   * READ-only: the workspace root whose reads are denied except for the declared
   * readable inputs already present in `filesystem.readable`. The runtime still
   * reads broadly (system libs, caches) so it can start; only undeclared
   * WORKSPACE files are withheld. Ignored unless readScope === "least-privilege".
   */
  workspaceReadDenyRoot?: string;
  /** @internal READ policy provenance retained until the final spawn-time realpath pass. */
  _readValidation?: {
    workspaceRoot: string;
    declaredReadables: string[];
    scratchDir: string;
  };
  /** @internal WRITE policy provenance: the final spawn-resolved writable set must stay inside workspace∪scratch. */
  _writeValidation?: {
    workspaceRoot: string;
    scratchDir: string;
  };
  filesystem: {
    readable: string[];
    writable: string[];
  };
  network: "none";
  resources: {
    memoryMB: number;
    wallclockSec: number;
    maxProcesses: number;
  };
}

export type RunnerSandboxDenied = {
  kind: "sandbox-denied";
  resource: "filesystem" | "network" | "setup";
  detail: string;
  remedy: string;
};

export type RunnerSandboxResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  denied?: RunnerSandboxDenied;
  timedOut?: boolean;
  /** The run was stopped because the caller's signal aborted (stdin-cancel children only). */
  aborted?: boolean;
  alpha?: boolean;
  confined: boolean;
};

export type SpawnConfinedOptions = {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  /** @internal Test seam for a filesystem identity change immediately before spawn resolution. */
  _beforeResolvePolicy?: () => void | Promise<void>;
};

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export async function resolveRunnerSandboxPath(path: string): Promise<string> {
  const pending: string[] = [];
  let cursor = resolve(path);

  while (true) {
    try {
      const existing = await realpath(cursor);
      return pending.length > 0 ? join(existing, ...pending.reverse()) : existing;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      pending.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function resolveRunnerSandboxPolicy(policy: RunnerSandboxPolicy): Promise<RunnerSandboxPolicy> {
  const [readable, writable, readValidation, writeValidation] = await Promise.all([
    Promise.all(policy.filesystem.readable.map(resolveRunnerSandboxPath)),
    Promise.all(policy.filesystem.writable.map(resolveRunnerSandboxPath)),
    policy._readValidation
      ? Promise.all([
        resolveRunnerSandboxPath(policy._readValidation.workspaceRoot),
        Promise.all(policy._readValidation.declaredReadables.map(resolveRunnerSandboxPath)),
        resolveRunnerSandboxPath(policy._readValidation.scratchDir),
      ]).then(([workspaceRoot, declaredReadables, scratchDir]) => ({ workspaceRoot, declaredReadables, scratchDir }))
      : undefined,
    policy._writeValidation
      ? Promise.all([
        resolveRunnerSandboxPath(policy._writeValidation.workspaceRoot),
        resolveRunnerSandboxPath(policy._writeValidation.scratchDir),
      ]).then(([workspaceRoot, scratchDir]) => ({ workspaceRoot, scratchDir }))
      : undefined,
  ]);
  return {
    ...policy,
    ...(readValidation ? { _readValidation: readValidation } : {}),
    ...(writeValidation ? { _writeValidation: writeValidation } : {}),
    filesystem: {
      readable: uniqueResolved(readable),
      writable: uniqueResolved(writable),
    },
  };
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function assertPolicyAfterResolution(policy: RunnerSandboxPolicy): void {
  if (policy.readScope === "least-privilege") {
    const validation = policy._readValidation;
    if (!validation) throw new Error("Runner Sandbox final READ runner policy is missing validated input provenance.");

    const escapingWritable = policy.filesystem.writable.find((path) => !isPathWithin(validation.scratchDir, path));
    if (escapingWritable) {
      throw new Error(`Runner Sandbox final READ runner policy grants writes outside verified scratch: ${escapingWritable}`);
    }
    // A declared readable that resolved OUTSIDE the workspace at final resolution
    // (e.g. an internal path component flipped to an external symlink after the
    // host check) is rejected — the earlier overlap-only check missed this because
    // an escaped path no longer overlaps the workspace. This narrows the READ
    // symlink race to the irreducible post-spawn kernel-op window (see the tracked
    // handle-based-confinement parcel).
    const escapedDeclared = validation.declaredReadables.find((declared) => !isPathWithin(validation.workspaceRoot, declared));
    if (escapedDeclared) {
      throw new Error(`Runner Sandbox final READ runner policy declares a readable outside the workspace: ${escapedDeclared}`);
    }
    const excessReadable = policy.filesystem.readable.find((path) =>
      (isPathWithin(validation.workspaceRoot, path) || isPathWithin(path, validation.workspaceRoot))
      && !validation.declaredReadables.some((declared) => isPathWithin(declared, path)));
    if (excessReadable) {
      throw new Error(`Runner Sandbox final READ runner policy exceeds declared workspace inputs: ${excessReadable}`);
    }
    return;
  }
  // WRITE (and any non-least-privilege) policy with a workspace anchor: every
  // spawn-resolved writable path must stay inside the workspace or the verified
  // scratch. Catches a touched path whose ancestor flipped to an external symlink
  // between the host workspace assertion and final policy resolution (blocker 2).
  const writeValidation = policy._writeValidation;
  if (!writeValidation) return;
  const escapingWrite = policy.filesystem.writable.find((path) =>
    !isPathWithin(writeValidation.workspaceRoot, path) && !isPathWithin(writeValidation.scratchDir, path));
  if (escapingWrite) {
    throw new Error(`Runner Sandbox final runner policy grants writes outside the workspace and scratch: ${escapingWrite}`);
  }
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}

async function readStream(stream: Readable | null): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function childExitCode(proc: ChildProcess): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", resolve);
  });
}

export const RUNNER_SANDBOX_OUTPUT_CAP_BYTES = 1024 * 1024;

// Keep this deliberately narrow and explicit: macOS needs these signed system
// roots to start a selected runtime under Seatbelt, but READ workspaces may
// never live beneath them because that would bypass per-input grants.
export const MACOS_RUNNER_RUNTIME_READABLE_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library/Apple",
  "/private/var/db/timezone",
] as const;

type CapturedStream = { text: string; truncated: boolean };

async function readCapturedStream(stream: Readable | null): Promise<CapturedStream> {
  if (!stream) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const remaining = RUNNER_SANDBOX_OUTPUT_CAP_BYTES - bytes;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      bytes += remaining;
      truncated = true;
      continue;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }

  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(output), truncated };
}

function sandboxDeniedDetail(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "The Runner Sandbox denied the script operation.";
  return trimmed.split("\n").slice(-4).join("\n");
}

function sandboxDeniedRemedy(resource: RunnerSandboxDenied["resource"]): string {
  if (resource === "network") {
    return "Move this operation into a Harness Capability with an explicit Egress grant; Script Runner code runs with network:none.";
  }
  if (resource === "setup") {
    return "Treat this as a Runner Sandbox setup failure; the command was not run unconfined.";
  }
  return "Grant the Script Runner a narrower required path, or move the input into the Host App workspace.";
}

/** Helper status lines that report on a run; they never describe a denial. */
const HELPER_STATUS_LINE = /^BRIDLE_SANDBOX_WARN\b/;

export function classifySandboxDenial(rawOutput: string): RunnerSandboxDenied | undefined {
  const output = rawOutput
    .split("\n")
    .filter((line) => !HELPER_STATUS_LINE.test(line.trim()))
    .join("\n");
  const detail = sandboxDeniedDetail(output);
  const structured = output.match(/BRIDLE_SANDBOX_DENIED\s+(filesystem|network|setup):/i);
  if (structured) {
    const resource = structured[1]!.toLowerCase() as RunnerSandboxDenied["resource"];
    return {
      kind: "sandbox-denied",
      resource,
      detail,
      remedy: sandboxDeniedRemedy(resource),
    };
  }

  const lower = output.toLowerCase();
  if (
    lower.includes("network")
    || lower.includes("socket")
    || lower.includes("connect")
    || lower.includes("nodename nor servname")
  ) {
    return {
      kind: "sandbox-denied",
      resource: "network",
      detail,
      remedy: sandboxDeniedRemedy("network"),
    };
  }
  if (
    lower.includes("operation not permitted")
    || lower.includes("permission denied")
    || lower.includes("sandbox")
    || lower.includes("deny")
    || lower.includes("access is denied")
    || lower.includes("error_access_denied")
    || lower.includes("the system cannot find the path")
  ) {
    return {
      kind: "sandbox-denied",
      resource: "filesystem",
      detail,
      remedy: sandboxDeniedRemedy("filesystem"),
    };
  }
  return undefined;
}

export function generateMacSeatbeltProfile(policy: RunnerSandboxPolicy, realHome: string): string {
  const readable = uniqueResolved(policy.filesystem.readable);
  const writable = uniqueResolved(policy.filesystem.writable);
  // A pack runtime (bun/uv) needs broad reads just to start — system dylibs, its
  // own install tree and caches — so both profiles begin from the established
  // broad-read grant with the real home denied. WRITE packs stop there. READ
  // packs additionally DENY the whole workspace root and then re-allow only the
  // declared readable inputs (Seatbelt is last-match-wins, and those declared
  // paths are already in `readable`): undeclared workspace files are withheld
  // while the runtime still boots. Tightening the broad non-workspace read grant
  // is a separate future parcel that needs per-runtime live testing.
  const readRules = [
    "(allow file-read* file-read-metadata)",
    `(deny file-read* (subpath ${schemeString(realHome)}))`,
    ...(policy.readScope === "least-privilege" && policy.workspaceReadDenyRoot
      ? [`(deny file-read* (subpath ${schemeString(uniqueResolved([policy.workspaceReadDenyRoot])[0]!)}))`]
      : []),
    `(allow file-read* ${readable.map((path) => `(subpath ${schemeString(path)})`).join(" ")})`,
  ];
  const writableForms = [
    ...writable.map((path) => `(subpath ${schemeString(path)})`),
    `(literal "/dev/null")`,
  ].join(" ");

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    ...readRules,
    `(allow file-write* ${writableForms})`,
    "(deny network*)",
    "",
  ].join("\n");
}

/** How long a "stdin"-cancel child gets to stop its own work before it is killed. */
export const RUNNER_SANDBOX_CANCEL_GRACE_MS = 10_000;

export type HelperCancellation = "timeout" | "cancel";

/**
 * The reason a stdin-cancel helper recorded in its result file for stopping a
 * run: the whole file is exactly `timeout` or `cancel`.
 */
export function parseHelperCancellation(record: string): HelperCancellation | undefined {
  return record === "timeout" || record === "cancel" ? record : undefined;
}

async function readHelperCancellation(resultPath: string | undefined): Promise<HelperCancellation | undefined> {
  if (!resultPath) return undefined;
  return parseHelperCancellation(await readFile(resultPath, "utf8").catch(() => ""));
}

/**
 * `cancel: "signal"` kills the child on timeout or abort. `cancel: "stdin"` is
 * for a child that enforces its own cleanup (the Windows helper): a timeout
 * writes `timeout`, an abort writes `cancel`, and stdin is closed; only a
 * child still running after the grace period is killed. Such a child stops
 * with exit 124 and records why in `resultPath`, a file the caller reserves
 * empty and exclusively before launch and only the child replaces (never the
 * proxied output, which a confined script controls and the cap can cut). A
 * 124 without that record is an ordinary exit status.
 */
export async function spawnCaptured(
  command: string[],
  options: SpawnConfinedOptions,
  timeoutMs: number,
  cancel: "signal" | "stdin" = "signal",
  resultPath?: string,
): Promise<RunnerSandboxResult> {
  // Declare exactly the three standard descriptors. stdin is closed (or, for
  // stdin cancellation, a pipe that carries only the cancel line) and Node
  // receives no caller-supplied extra descriptors to inherit.
  const stdio: StdioOptions = cancel === "stdin" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
  const proc: ChildProcess = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio,
    // A "stdin" child is never killed by the abort signal directly; see requestCancel.
    ...(cancel === "signal" ? { signal: options.signal } : {}),
  });
  const exited = childExitCode(proc);

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let requested: HelperCancellation | undefined;
  let killedAfterGrace = false;
  const requestCancel = (reason: HelperCancellation) => {
    if (requested) return;
    requested = reason;
    // The child may already have exited and closed the pipe.
    proc.stdin?.on("error", () => {});
    proc.stdin?.write(`${reason}\n`);
    proc.stdin?.end();
    graceTimer = setTimeout(() => {
      killedAfterGrace = true;
      proc.kill();
    }, RUNNER_SANDBOX_CANCEL_GRACE_MS);
    graceTimer.unref?.();
  };
  const onAbort = () => requestCancel("cancel");
  if (cancel === "stdin") {
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    if (cancel === "stdin") {
      requestCancel("timeout");
      return;
    }
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 500).unref?.();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapturedStream(proc.stdout),
      readCapturedStream(proc.stderr),
      exited.catch(() => null),
    ]);
    // stdin mode: the helper's own record decides. If it had to be killed
    // after the grace period, fall back to what this wrapper asked for.
    const stopped: HelperCancellation | undefined = cancel === "stdin"
      ? (exitCode === 124 ? await readHelperCancellation(resultPath) : undefined)
        ?? (killedAfterGrace ? requested : undefined)
      : undefined;
    const denied = !stopped && exitCode && exitCode !== 0
      ? classifySandboxDenial(`${stderr.text}\n${stdout.text}`)
      : undefined;
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      ...(stdout.truncated ? { stdoutTruncated: true } : {}),
      ...(stderr.truncated ? { stderrTruncated: true } : {}),
      denied,
      timedOut: cancel === "stdin" ? stopped === "timeout" : timedOut,
      ...(stopped === "cancel" ? { aborted: true } : {}),
      confined: true,
    };
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function spawnMacSeatbelt(command: string[], options: SpawnConfinedOptions, policy: RunnerSandboxPolicy): Promise<RunnerSandboxResult> {
  if (policy.network !== "none") throw new Error("Runner Sandbox v1 only supports network:none.");
  const sandboxExec = spawn("/usr/bin/which", ["sandbox-exec"], { stdio: ["ignore", "pipe", "ignore"] });
  const sandboxExecExited = childExitCode(sandboxExec);
  const [sandboxExecPath, sandboxExecExit] = await Promise.all([readStream(sandboxExec.stdout), sandboxExecExited]);
  if (sandboxExecExit !== 0 || !sandboxExecPath.trim()) {
    throw new Error("Runner Sandbox cannot start: sandbox-exec is unavailable on this macOS host.");
  }

  const [realHome, resolvedCwd] = await Promise.all([
    resolveRunnerSandboxPath(homedir()),
    resolveRunnerSandboxPath(options.cwd),
  ]);

  const tempDir = await mkdtemp(join(tmpdir(), "bridle-seatbelt-"));
  const profilePath = join(tempDir, "runner.sb");
  await writeFile(profilePath, generateMacSeatbeltProfile(policy, realHome), "utf8");

  const cpuSeconds = Math.max(1, Math.floor(policy.resources.wallclockSec));
  // macOS ulimit is a poor fit for the memory/process caps and must not be used
  // for them here: RLIMIT_AS (ulimit -v) counts virtual address space and breaks
  // large ML workloads such as docling loading models; RLIMIT_NPROC (ulimit -u) is
  // per-UID total, so lowering it to a small number makes every fork fail with
  // EAGAIN on a busy user session (uv forks to inspect interpreters and dies). v1
  // bounds runaway work with the wall-clock timeout below plus a CPU-time cap;
  // memory/process ceilings are enforced by the OS backend where it is sound to do
  // so (the Windows Job Object). See docs/specs/2026-07-05-runner-sandbox-design.md.
  const rlimitWrapper = [
    `ulimit -t ${cpuSeconds} 2>/dev/null || true`,
    'exec "$@"',
  ].join("; ");

  try {
    return await spawnCaptured([
      sandboxExecPath.trim(),
      "-f",
      profilePath,
      "/bin/sh",
      "-c",
      rlimitWrapper,
      "bridle-runner",
      ...command,
    ], { ...options, cwd: resolvedCwd }, policy.resources.wallclockSec * 1000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function buildWindowsSandboxRequest(
  command: string[],
  options: SpawnConfinedOptions,
  policy: RunnerSandboxPolicy,
): object {
  return {
    command,
    cwd: options.cwd,
    env: options.env,
    policy,
    appContainer: {
      namePrefix: "Bridle.ScriptRunner",
      capabilities: [],
      network: "none",
      integrity: "low",
      restrictedToken: "write-restricted",
      grants: {
        readable: policy.filesystem.readable,
        writable: policy.filesystem.writable,
      },
      // The host-created per-run scratch: the only tree the helper labels Low
      // and grants writes on. Writable grants outside it are refused.
      scratchRoot: policy._writeValidation?.scratchDir ?? policy._readValidation?.scratchDir ?? null,
      job: {
        memoryMB: policy.resources.memoryMB,
        wallclockSec: policy.resources.wallclockSec,
        maxProcesses: policy.resources.maxProcesses,
      },
    },
  };
}

async function spawnWindowsAppContainer(command: string[], options: SpawnConfinedOptions, policy: RunnerSandboxPolicy): Promise<RunnerSandboxResult> {
  if (policy.network !== "none") throw new Error("Runner Sandbox v1 only supports network:none.");
  // Windows confinement is implemented by the bundled native helper because
  // Bun/Node cannot create AppContainer tokens, privilege-stripped low-MIC
  // process tokens, or Job Objects directly. Keep this wrapper fail-closed:
  // if the helper is not bundled for the Host App sidecar, the pack does not run.
  const helper = process.env.BRIDLE_WINDOWS_SANDBOX_HELPER
    ?? join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "bridle-runner-sandbox.exe");
  const helperExists = await access(helper).then(() => true, () => false);
  if (!helperExists) {
    throw new Error("Runner Sandbox cannot start: Windows AppContainer launcher helper is unavailable.");
  }
  const requestDir = await mkdtemp(join(tmpdir(), "bridle-appcontainer-"));
  const requestPath = join(requestDir, "request.json");
  // Reserved empty and exclusively by the host; replaced by the helper only
  // when it stops a run.
  const resultPath = join(requestDir, "result");

  try {
    // Inside the try so a failed reservation (a pre-existing file fails the
    // launch) still has the finally remove requestDir.
    await writeFile(resultPath, "", { flag: "wx" });
    await writeFile(requestPath, JSON.stringify(buildWindowsSandboxRequest(command, options, policy)), "utf8");
    // The helper enforces the wall clock itself and must revoke its ACL grants
    // before exiting, so timeout and abort ask it to stop over stdin instead of
    // killing it.
    const result = await spawnCaptured(
      [helper, "--request", requestPath, "--result", resultPath],
      options,
      policy.resources.wallclockSec * 1000,
      "stdin",
      resultPath,
    );
    return { ...result, alpha: true };
  } finally {
    await rm(requestDir, { recursive: true, force: true });
  }
}

export async function spawnConfined(
  command: string[],
  options: SpawnConfinedOptions,
  policy: RunnerSandboxPolicy,
): Promise<RunnerSandboxResult> {
  await options._beforeResolvePolicy?.();
  const resolvedPolicy = await resolveRunnerSandboxPolicy(policy);
  assertPolicyAfterResolution(resolvedPolicy);
  if (process.platform === "darwin") return spawnMacSeatbelt(command, options, resolvedPolicy);
  if (process.platform === "win32") return spawnWindowsAppContainer(command, options, resolvedPolicy);
  throw new Error(`Runner Sandbox cannot start: unsupported platform ${process.platform}.`);
}
