import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { Type, type TSchema } from "typebox";
import type {
  PackRunner,
  PackRunResult,
  ProbeResult,
  SandboxAttestation,
} from "@bridle/contract";
import {
  MACOS_RUNNER_RUNTIME_READABLE_ROOTS,
  resolveRunnerSandboxPath,
  spawnConfined,
  type RunnerSandboxDenied,
  type RunnerSandboxPolicy,
  type RunnerSandboxResult,
} from "./runner-sandbox.ts";
import type { Capability, CapabilityContext, CapabilityResult } from "./types.ts";

/**
 * Byte budget for the script's structured stdout retained on PackRunResult.
 * This preview IS the model-visible tool result for read capabilities (see
 * bindPack below, where it becomes the tool `text`) and the parseable verdict
 * for scenario checkers, so it must hold a real folder listing / verdict — not
 * a 4 KiB teaser. Matches the checker's CHECKER_STDOUT_MAX_BYTES
 * (contributions/scenario.ts); the script runtime caps total stdout at 1 MiB.
 */
const PACK_STDOUT_PREVIEW_MAX_CHARS = 65_536;

export type CorePackScriptRuntime = "uv" | "bun";
export type CorePackScriptRisk = "read" | "write";
export type CorePackTier = 1 | 2 | 3;
export type CorePackAssetSource = { kind: "hf"; repo: string } | { kind: "url"; url: string };

export interface CorePackScript {
  id: string;
  entry: string;
  runtime: CorePackScriptRuntime;
  /** Script Pack-declared Risk Level; PACK.md defaults missing declarations to write. */
  risk: CorePackScriptRisk;
  argsSchema: TSchema;
  tier: CorePackTier;
  requiredProbes?: string[];
  requiredAssets?: string[];
  requiredPaths?: string[];
}

export interface CorePackProbe {
  id: string;
  kind: string;
  command?: string;
  platform?: string;
  version?: string;
}

export interface CorePackAsset {
  id: string;
  description: string;
  sizeBytes: number;
  source: CorePackAssetSource;
  checksum: {
    algorithm: "sha256";
    value: string;
  };
  consentText: string;
}

export interface CoreScriptPack {
  root: string;
  name: string;
  version: string;
  contentHash: string;
  scripts: CorePackScript[];
  probes: CorePackProbe[];
  assets: CorePackAsset[];
}

export type PackProbeResult =
  | { id: string; ok: true; kind: "binary"; command: string; path: string }
  | { id: string; ok: false; kind: "binary"; command: string; message: string }
  | { id: string; ok: true; kind: "platform"; platform: string }
  | { id: string; ok: false; kind: "platform"; platform: string; message: string }
  | { id: string; ok: false; kind: string; message: string };

export interface PackScriptAvailability {
  scriptId: string;
  available: boolean;
  failedProbes: string[];
}

export interface ManagedAssetCard {
  assetId: string;
  description: string;
  sizeBytes: number;
  source: CorePackAssetSource;
  consentText: string;
}

export type PackTrustTier = "reviewed" | "development" | "unreviewed";

export type PackReadCapabilityUnavailableReason = {
  code: "unreviewed-read-not-allowed" | "verified-confinement-required" | "read-writable-grant-forbidden" | "workspace-root-required" | "runtime-readable-root-overlap" | "readable-policy-forbidden";
  message: string;
};

/** A structured fail-closed binding/creation refusal for a declared READ script. */
export class PackReadCapabilityUnavailableError extends Error {
  readonly reason: PackReadCapabilityUnavailableReason;

  constructor(reason: PackReadCapabilityUnavailableReason) {
    super(reason.message);
    this.name = "PackReadCapabilityUnavailableError";
    this.reason = reason;
  }
}

export type ManagedAssetDownload = (input: {
  pack: CoreScriptPack;
  asset: CorePackAsset;
  destination: string;
  signal?: AbortSignal;
}) => Promise<{ files: string[]; verifiedChecksum?: string }>;

function findScript(pack: CoreScriptPack, scriptId: string): CorePackScript {
  const script = pack.scripts.find((candidate) => candidate.id === scriptId);
  if (!script) throw new Error(`Unknown pack script: ${scriptId}`);
  return script;
}

function findAsset(pack: CoreScriptPack, assetId: string): CorePackAsset {
  const asset = pack.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`Unknown managed asset: ${assetId}`);
  return asset;
}

function declaredScriptRisk(script: CorePackScript): CorePackScriptRisk {
  return script.risk;
}

function isVerifiedConfinementPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

function unavailableReadCapability(reason: PackReadCapabilityUnavailableReason): never {
  throw new PackReadCapabilityUnavailableError(reason);
}

function isPathEqualOrWithin(root: string, candidate: string): boolean {
  return isPathWithin(root, candidate);
}

function assertReadWorkspaceIsNotRuntimeReadableRoot(workspaceRoot: string, platform: NodeJS.Platform): void {
  if (platform !== "darwin") return;
  const resolvedWorkspace = resolveRunnerSandboxPathSync(workspaceRoot);
  const runtimeRoot = MACOS_RUNNER_RUNTIME_READABLE_ROOTS
    .map(resolveRunnerSandboxPathSync)
    .find((root) => isPathEqualOrWithin(root, resolvedWorkspace) || isPathEqualOrWithin(resolvedWorkspace, root));
  if (runtimeRoot) {
    unavailableReadCapability({
      code: "runtime-readable-root-overlap",
      message: `Declared read Script Pack capability unavailable: workspaceRoot overlaps an unconditional Runner Sandbox runtime-readable root (${runtimeRoot}).`,
    });
  }
}

function capabilitySegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  if (!sanitized) return "item";
  return /^[a-z]/.test(sanitized) ? sanitized : `x_${sanitized}`;
}

function assertPackRelativePath(value: string): void {
  if (!value || isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`Pack script entry must be relative to the pack root: ${value}`);
  }
}

function validateArgs(schema: Record<string, unknown>, input: unknown): string[] {
  return validateSchema(schema, input, "input");
}

function validateSchema(schema: Record<string, unknown>, value: unknown, path: string): string[] {
  const type = schema.type;
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path} must be object`];
    const record = value as Record<string, unknown>;
    const issues: string[] = [];
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!(key in record)) issues.push(`${path}.${key} is required`);
    }
    const properties = typeof schema.properties === "object" && schema.properties !== null ? schema.properties as Record<string, unknown> : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in record && typeof propSchema === "object" && propSchema !== null && !Array.isArray(propSchema)) {
        issues.push(...validateSchema(propSchema as Record<string, unknown>, record[key], `${path}.${key}`));
      }
    }
    return issues;
  }
  if (type === "string" && typeof value !== "string") return [`${path} must be string`];
  if (type === "number" && typeof value !== "number") return [`${path} must be number`];
  if (type === "integer" && (!Number.isInteger(value))) return [`${path} must be integer`];
  if (type === "boolean" && typeof value !== "boolean") return [`${path} must be boolean`];
  if (type === "array" && !Array.isArray(value)) return [`${path} must be array`];
  return [];
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

type RuntimeSandboxAdditions = {
  env: Record<string, string>;
  readable: string[];
  writable: string[];
};

type RuntimeCommand = {
  command: string[];
  executable: string;
};

async function resolveRuntimeExecutable(runtime: CorePackScriptRuntime): Promise<string> {
  const configured = process.env[runtime === "uv" ? "BRIDLE_UV_PATH" : "BRIDLE_BUN_PATH"]?.trim();
  const executable = configured || await defaultResolveBinary(runtime);
  if (!executable) throw new Error(`Pack script runtime not found on PATH: ${runtime}`);
  return await resolveRunnerSandboxPath(executable);
}

async function runtimeCommand(pack: CoreScriptPack, script: CorePackScript): Promise<RuntimeCommand> {
  assertPackRelativePath(script.entry);
  const executable = await resolveRuntimeExecutable(script.runtime);
  const entry = join(pack.root, script.entry);
  if (script.runtime === "bun") return { command: [executable, entry], executable };
  const envRoot = join(pack.root, "envs", script.id);
  return { command: [executable, "run", "--project", envRoot, "python", entry], executable };
}

// Only these host vars are forwarded to a spawned pack script by default — the
// minimum uv/python/bun/docling need to run. Everything else in the host's
// process.env (API keys, tokens) stays out.
const BASE_ENV_ALLOWLIST = [
  "PATH", "HF_HOME", "HF_HUB_CACHE", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM",
] as const;

// Build a minimal, allowlisted environment for a spawned pack script. Pack
// scripts are third-party code (ADR-0010); the host's full process.env must
// never flow into them (ADR-0009 closed semantics). Only the BRIDLE_PACK_* vars
// the runner sets, the base allowlist, and caller-named passthrough vars appear.
export function buildScriptEnv(
  pack: CoreScriptPack,
  script: CorePackScript,
  input: unknown,
  scratchHome: string,
  extraAllowlist: readonly string[] = [],
  workspaceRoot?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    BRIDLE_PACK_NAME: pack.name,
    BRIDLE_PACK_VERSION: pack.version,
    BRIDLE_PACK_SCRIPT_ID: script.id,
    BRIDLE_PACK_ARGS_JSON: JSON.stringify(input),
    HOME: scratchHome,
    TMPDIR: scratchHome,
    // The run's workspace root, so a script can resolve relative arg paths (e.g.
    // "invoice.pdf") against THIS run's dynamic workspace. Access is still
    // sandbox-enforced by the granted touchedPaths/readablePaths — this is only
    // the anchor string, it grants nothing.
    ...(workspaceRoot ? { BRIDLE_PACK_WORKSPACE: workspaceRoot } : {}),
  };
  for (const key of [...BASE_ENV_ALLOWLIST, ...extraAllowlist]) {
    if (key === "HOME" || key === "TMPDIR") continue;
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (script.runtime === "uv") {
    env.HF_HUB_OFFLINE = "1";
    env.TRANSFORMERS_OFFLINE = "1";
  }
  Object.assign(env, runtimeSandboxAdditions(script.runtime, scratchHome).env);
  return env;
}

type RunnerScratchSetupError = Error & { denied: RunnerSandboxDenied };

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function scratchSetupError(detail: string): RunnerScratchSetupError {
  const error = new Error(detail) as RunnerScratchSetupError;
  error.denied = {
    kind: "sandbox-denied",
    resource: "setup",
    detail,
    remedy: "Set TMPDIR to a location outside the workspace, pack, readable inputs, runtime caches, and real home before running the Script Runner.",
  };
  return error;
}

async function createVerifiedRunnerScratchDir(protectedPaths: readonly string[], baseName = "bridle-runner"): Promise<string> {
  // The runner owns this dedicated base. TMPDIR may select a volume, but never
  // becomes a child write grant and is rejected if it overlaps a protected root.
  // Callers that create a scratch whose CONTENTS become a protected input of a
  // LATER verified-scratch call (e.g. the pack snapshot, whose pack.root then
  // feeds the run scratch's readable set) MUST use a distinct baseName, or the
  // second call correctly rejects its own base for containing that protected path.
  const requestedBase = join(resolve(process.env.TMPDIR ?? "/tmp"), baseName);
  const resolvedBase = await resolveRunnerSandboxPath(requestedBase);
  const resolvedProtected = await Promise.all(protectedPaths.map(resolveRunnerSandboxPath));
  if (resolvedProtected.some((path) => isPathWithin(path, resolvedBase) || isPathWithin(resolvedBase, path))) {
    throw scratchSetupError(`Runner Sandbox scratch base overlaps a protected path: ${resolvedBase}`);
  }

  await mkdir(resolvedBase, { recursive: true });
  const scratchDir = await mkdtemp(join(resolvedBase, "scratch-"));
  const realScratchDir = await realpath(scratchDir);
  if (resolvedProtected.some((path) => isPathWithin(path, realScratchDir) || isPathWithin(realScratchDir, path))) {
    await rm(realScratchDir, { recursive: true, force: true });
    throw scratchSetupError(`Runner Sandbox scratch path overlaps a protected path: ${realScratchDir}`);
  }
  return realScratchDir;
}

function runtimeSandboxAdditions(runtime: CorePackScriptRuntime, scratchDir: string): RuntimeSandboxAdditions {
  if (runtime === "uv") {
    const uvCache = join(scratchDir, "uv-cache");
    const uvPythonInstall = join(scratchDir, "uv-python-install");
    return {
      env: {
        UV_CACHE_DIR: uvCache,
        UV_PYTHON_INSTALL_DIR: uvPythonInstall,
        // network:none — uv must never try to fetch a managed interpreter; use a
        // system/pre-resolved one. (Verified: only-system + downloads=never runs
        // offline under the Seatbelt sandbox.)
        UV_PYTHON_DOWNLOADS: "never",
        UV_PYTHON_PREFERENCE: "only-system",
      },
      readable: [
        join(homedir(), ".cache", "uv"),
        join(homedir(), ".local", "share", "uv"),
      ],
      writable: [uvCache, uvPythonInstall],
    };
  }

  const bunCache = join(scratchDir, "bun-install-cache");
  return {
    env: {
      BUN_INSTALL_CACHE_DIR: bunCache,
    },
    // Grant bun's whole runtime home, not just its cache: bun reads runtime data
    // across ~/.bun and fails with an opaque "unknown error" if only bin/ or
    // cache/ is granted. (For a bundled bun this is the bundle's install root.)
    readable: [join(homedir(), ".bun")],
    writable: [bunCache],
  };
}

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function resolveRunnerSandboxPathSync(path: string): string {
  const pending: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try {
      const existing = realpathSync(cursor);
      return pending.length > 0 ? join(existing, ...pending.reverse()) : existing;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      pending.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function touchedWritablePaths(paths: readonly string[]): string[] {
  const writable: string[] = [];
  for (const path of paths) {
    writable.push(path, dirname(path));
  }
  return writable;
}

function mergeRunnerSandboxPolicy(
  base: RunnerSandboxPolicy,
  override: Partial<RunnerSandboxPolicy> | undefined,
): RunnerSandboxPolicy {
  if (!override) return base;
  if (override.network && override.network !== "none") throw new Error("Runner Sandbox v1 only supports network:none.");
  // readScope, workspaceReadDenyRoot and _readValidation are INTERNALLY derived
  // from the script's risk + workspace and are the authority the spawn-time READ
  // validation rests on. A caller-supplied sandbox override must never forge or
  // downgrade them (e.g. readScope:"broad" would skip the check, a forged
  // _readValidation would falsify it), so the internal base always wins here —
  // these fields are deliberately NOT honoured from `override`.
  const workspaceReadDenyRoot = base.workspaceReadDenyRoot;
  const readValidation = base._readValidation;
  const writeValidation = base._writeValidation;
  return {
    readScope: base.readScope,
    ...(workspaceReadDenyRoot ? { workspaceReadDenyRoot } : {}),
    ...(readValidation ? { _readValidation: readValidation } : {}),
    ...(writeValidation ? { _writeValidation: writeValidation } : {}),
    filesystem: {
      readable: uniqueResolved([...base.filesystem.readable, ...(override.filesystem?.readable ?? [])]),
      writable: uniqueResolved([...base.filesystem.writable, ...(override.filesystem?.writable ?? [])]),
    },
    network: "none",
    resources: {
      memoryMB: override.resources?.memoryMB ?? base.resources.memoryMB,
      wallclockSec: override.resources?.wallclockSec ?? base.resources.wallclockSec,
      maxProcesses: override.resources?.maxProcesses ?? base.resources.maxProcesses,
    },
  };
}

export function composeRunnerSandboxPolicy(input: {
  pack: CoreScriptPack;
  script: CorePackScript;
  touchedPaths?: readonly string[];
  /** Workspace inputs explicitly declared by a READ-risk capability. */
  readablePaths?: readonly string[];
  workspaceRoot?: string;
  scratchDir: string;
  hfHome?: string;
  sandbox?: Partial<RunnerSandboxPolicy>;
}): RunnerSandboxPolicy {
  const hfHome = input.hfHome ?? defaultHfHome();
  const assetReadable = (input.script.requiredAssets ?? []).map((assetId) =>
    assetDestination(hfHome, input.pack, findAsset(input.pack, assetId)));
  const requiredReadable = (input.script.requiredPaths ?? []).map((path) =>
    isAbsolute(path) ? path : join(input.pack.root, path));
  const declaredWorkspaceReadables = declaredScriptRisk(input.script) === "read"
    ? (input.readablePaths ?? [])
    : [];
  const base: RunnerSandboxPolicy = {
    readScope: declaredScriptRisk(input.script) === "read" ? "least-privilege" : "broad",
    // Seatbelt matches the kernel realpath, so the workspace deny must be
    // realpath-resolved (e.g. /var → /private/var) or it silently fails to match
    // and undeclared workspace reads leak. The declared readables are already
    // realpath-resolved upstream.
    ...(declaredScriptRisk(input.script) === "read" && input.workspaceRoot
      ? {
        workspaceReadDenyRoot: resolveRunnerSandboxPathSync(input.workspaceRoot),
        _readValidation: {
          workspaceRoot: resolveRunnerSandboxPathSync(input.workspaceRoot),
          declaredReadables: uniqueResolved(input.readablePaths ?? []),
          scratchDir: input.scratchDir,
        },
      }
      // WRITE policies carry a workspace+scratch anchor so the final spawn-resolved
      // writable set is re-checked to stay inside workspace∪scratch (TOCTOU blocker 2).
      : declaredScriptRisk(input.script) !== "read" && input.workspaceRoot
        ? {
          _writeValidation: {
            workspaceRoot: resolveRunnerSandboxPathSync(input.workspaceRoot),
            scratchDir: input.scratchDir,
          },
        }
        : {}),
    filesystem: {
      readable: uniqueResolved([
        input.pack.root,
        join(input.pack.root, "envs", input.script.id),
        ...assetReadable,
        ...requiredReadable,
        ...declaredWorkspaceReadables,
      ]),
      writable: uniqueResolved([
        ...(input.touchedPaths ?? []),
        ...touchedWritablePaths(input.touchedPaths ?? []),
        input.scratchDir,
      ]),
    },
    network: "none",
    resources: {
      memoryMB: 4096,
      wallclockSec: 900,
      maxProcesses: 64,
    },
  };
  return mergeRunnerSandboxPolicy(base, input.sandbox);
}

export function auditPackScriptSandboxAlpha(
  ctx: Pick<CapabilityContext, "audit">,
  pack: CoreScriptPack,
  script: CorePackScript,
  result: RunnerSandboxResult,
): void {
  if (result.alpha !== true) return;
  ctx.audit({
    type: "pack.script.sandbox_alpha",
    capability: `pack.${pack.name}.${script.id}`,
    risk: declaredScriptRisk(script),
    message: "Windows Runner Sandbox is alpha and unverified; confinement is not yet validated on this platform.",
  });
}

export function createPackScriptCapability(options: {
  pack: CoreScriptPack;
  scriptId: string;
  touchedPaths?: (input: unknown) => string[];
  /** Subset of touched paths attested as outputs after the run (default: all touched). A move declares only the destination; a delete declares none. */
  outputPaths?: (input: unknown) => string[];
  /** READ-risk workspace inputs, resolved per invocation. */
  readablePaths?: (input: unknown) => string[];
  /** Root against which READ-risk workspace inputs are realpath-checked. */
  workspaceRoot?: string;
  trust?: PackTrustTier;
  allowUnreviewedReads?: boolean;
  /** Extra host env vars to forward to the spawned script, beyond the base allowlist. */
  envAllowlist?: string[];
  sandbox?: Partial<RunnerSandboxPolicy>;
  /** @internal Test seam: observes the exact production spawn call. */
  _spawn?: typeof spawnConfined;
}): Capability {
  const script = findScript(options.pack, options.scriptId);
  if (script.tier !== 1) throw new Error(`Pack script ${script.id} is tier ${script.tier}; only tier 1 scripts can use the bundled runner.`);
  const risk = declaredScriptRisk(script);
  const platform = process.platform;
  const trust = options.trust ?? "unreviewed";
  if (risk === "read") {
    if (!isVerifiedConfinementPlatform(platform)) {
      unavailableReadCapability({
        code: "verified-confinement-required",
        message: "Declared read Script Pack capability unavailable: verified confinement required.",
      });
    }
    if (trust === "unreviewed" && options.allowUnreviewedReads !== true) {
      unavailableReadCapability({
        code: "unreviewed-read-not-allowed",
        message: "Declared read Script Pack capability unavailable: unreviewed reads require explicit opt-in.",
      });
    }
    if (!options.workspaceRoot) {
      unavailableReadCapability({
        code: "workspace-root-required",
        message: "Declared read Script Pack capability unavailable: workspaceRoot is required.",
      });
    }
    assertReadWorkspaceIsNotRuntimeReadableRoot(options.workspaceRoot, platform);
    if ((options.sandbox?.filesystem?.writable.length ?? 0) > 0) {
      unavailableReadCapability({
        code: "read-writable-grant-forbidden",
        message: "Declared read Script Pack capability unavailable: writable grants are forbidden.",
      });
    }
  }

  return {
    name: `pack.${capabilitySegment(options.pack.name)}.${capabilitySegment(script.id)}`,
    description: `Run Script Pack ${options.pack.name}/${script.id}.`,
    risk,
    parameters: script.argsSchema as TSchema,
    touchedPaths: options.touchedPaths,
    preview: () => `Run ${options.pack.name}/${script.id}`,
    execute: async (input: unknown, ctx: CapabilityContext): Promise<CapabilityResult<
      ({ exitCode: number | null; stdout: string; stderr: string; confined: boolean; alpha?: boolean; stdoutTruncated?: boolean; stderrTruncated?: boolean })
      | (RunnerSandboxDenied & { confined: boolean; alpha?: boolean })
    >> => {
      const issues = validateArgs(script.argsSchema as Record<string, unknown>, input);
      if (issues.length > 0) throw new Error(`PACK args invalid: ${issues.join("; ")}`);

      const touchedPaths = options.touchedPaths?.(input) ?? [];
      const readablePaths = options.readablePaths?.(input) ?? [];
      let resolvedReadablePaths = readablePaths;
      const resolvedWorkspaceRoot = risk === "read"
        ? await resolveRunnerSandboxPath(options.workspaceRoot!)
        : options.workspaceRoot;
      if (risk === "read") {
        if (touchedPaths.length > 0) {
          unavailableReadCapability({
            code: "read-writable-grant-forbidden",
            message: "Declared read Script Pack capability unavailable: writable grants are forbidden.",
          });
        }
        if (readablePaths.length > 0) {
          resolvedReadablePaths = await resolveWorkspacePaths(resolvedWorkspaceRoot!, readablePaths, "readable");
        }
        await assertReadWorkspaceReadablePolicy({
          workspaceRoot: resolvedWorkspaceRoot,
          declaredReadables: resolvedReadablePaths,
          requiredPaths: (script.requiredPaths ?? []).map((path) => isAbsolute(path) ? path : join(options.pack.root, path)),
          absoluteRequiredPaths: (script.requiredPaths ?? []).filter(isAbsolute),
          sandboxReadable: options.sandbox?.filesystem?.readable ?? [],
        });
      }
      const preScratchPolicy = composeRunnerSandboxPolicy({
        pack: options.pack,
        script,
        touchedPaths,
        readablePaths: resolvedReadablePaths,
        workspaceRoot: options.workspaceRoot,
        scratchDir: "/__bridle-runner-scratch-placeholder__",
        sandbox: options.sandbox,
      });
      let scratchDir: string | undefined;
      try {
        scratchDir = await createVerifiedRunnerScratchDir([
          ...preScratchPolicy.filesystem.readable,
          ...preScratchPolicy.filesystem.writable,
          homedir(),
          ...(risk === "read" ? [resolvedWorkspaceRoot!] : []),
        ]);
        const runtime = await runtimeCommand(options.pack, script);
        const runtimeAdditions = runtimeSandboxAdditions(script.runtime, scratchDir);
        // On Windows the scratch must reach the helper exactly as mkdtemp left
        // it: the helper labels only the scratch directory itself and pushes
        // nothing down to existing children, so the runtime creates its own
        // cache directories inside scratch and they inherit the grant.
        if (process.platform !== "win32") {
          await Promise.all(runtimeAdditions.writable.map((path) => mkdir(path, { recursive: true })));
        }
        const policy = mergeRunnerSandboxPolicy(composeRunnerSandboxPolicy({
          pack: options.pack,
          script,
          touchedPaths,
          readablePaths: resolvedReadablePaths,
          workspaceRoot: options.workspaceRoot,
          scratchDir,
          sandbox: options.sandbox,
        }), {
          filesystem: {
            readable: [dirname(runtime.executable), ...runtimeAdditions.readable],
            writable: runtimeAdditions.writable,
          },
        });
        if (risk === "read") {
          await assertReadFinalReadablePolicy(policy, resolvedWorkspaceRoot!, resolvedReadablePaths);
          await assertReadPolicyWritableOnlyScratch(policy, scratchDir);
          if (trust === "unreviewed" && options.allowUnreviewedReads === true) {
            ctx.audit({
              type: "pack.script.unreviewed_read_opt_in",
              capability: `pack.${options.pack.name}.${script.id}`,
              risk: "read",
              message: "Unreviewed READ Script Pack capability explicitly enabled.",
              metadata: { trust: "unreviewed" },
            });
          }
        }
        const runnerResult = await (options._spawn ?? spawnConfined)(runtime.command, {
          cwd: options.pack.root,
          env: buildScriptEnv(options.pack, script, input, scratchDir, options.envAllowlist, options.workspaceRoot),
          signal: ctx.signal,
        }, policy);
        auditPackScriptSandboxAlpha(ctx, options.pack, script, runnerResult);
        const { stdout, stderr, exitCode, denied, timedOut } = runnerResult;
        if (stdout.trim()) ctx.audit({ type: "pack.script.stdout", capability: `pack.${options.pack.name}.${script.id}`, risk, message: stdout });
        if (stderr.trim()) ctx.audit({ type: "pack.script.stderr", capability: `pack.${options.pack.name}.${script.id}`, risk, message: stderr });
        if (denied) {
          ctx.audit({
            type: "pack.script.sandbox_denied",
            capability: `pack.${options.pack.name}.${script.id}`,
            risk,
            message: denied.detail,
            metadata: { resource: denied.resource, remedy: denied.remedy },
          });
          return {
            text: `Runner Sandbox denied ${denied.resource} access. ${denied.remedy}`,
            details: { ...denied, confined: runnerResult.confined, ...(runnerResult.alpha ? { alpha: true } : {}) },
            isError: true,
          };
        }
        const details = {
          exitCode,
          stdout,
          stderr,
          confined: runnerResult.confined,
          alpha: runnerResult.alpha,
          ...(runnerResult.stdoutTruncated ? { stdoutTruncated: true } : {}),
          ...(runnerResult.stderrTruncated ? { stderrTruncated: true } : {}),
        };
        if (timedOut) return { text: `Pack script ${script.id} exceeded Runner Sandbox wall-clock limit`, details, isError: true };
        if (ctx.signal?.aborted) return { text: `Pack script ${script.id} aborted`, details, isError: true };
        if (exitCode !== 0) {
          return { text: `Pack script ${script.id} exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`, details, isError: true };
        }
        return { text: `Pack script ${script.id} completed.`, details };
      } catch (error) {
        if (typeof error === "object" && error !== null && "denied" in error) {
          const denied = (error as RunnerScratchSetupError).denied;
          return {
            text: `Runner Sandbox denied ${denied.resource} access. ${denied.remedy}`,
            details: { ...denied, confined: false },
            isError: true,
          };
        }
        throw error;
      } finally {
        if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
      }
    },
  };
}

async function defaultResolveBinary(command: string): Promise<string | null> {
  const proc = spawn("which", [command], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = childExitCode(proc);
  const [stdout, exitCode] = await Promise.all([readStream(proc.stdout), exited]);
  if (exitCode !== 0) return null;
  return stdout.trim() || null;
}

export async function runPackProbes(
  pack: CoreScriptPack,
  options: { resolveBinary?: (command: string) => Promise<string | null> } = {},
): Promise<PackProbeResult[]> {
  const resolveBinary = options.resolveBinary ?? defaultResolveBinary;
  const results: PackProbeResult[] = [];
  for (const probe of pack.probes) {
    if (probe.kind === "binary") {
      const command = probe.command ?? probe.id;
      const path = await resolveBinary(command);
      results.push(path
        ? { id: probe.id, ok: true, kind: "binary", command, path }
        : { id: probe.id, ok: false, kind: "binary", command, message: `Binary not found: ${command}` });
    } else if (probe.kind === "platform") {
      const platform = probe.platform ?? "";
      results.push(platform === process.platform
        ? { id: probe.id, ok: true, kind: "platform", platform }
        : { id: probe.id, ok: false, kind: "platform", platform, message: `Expected platform ${platform}, got ${process.platform}` });
    } else {
      results.push({ id: probe.id, ok: false, kind: probe.kind, message: `Unknown probe kind: ${probe.kind}` });
    }
  }
  return results;
}

export function getPackScriptAvailability(pack: CoreScriptPack, probeResults: readonly PackProbeResult[]): PackScriptAvailability[] {
  const failed = new Set(probeResults.filter((result) => !result.ok).map((result) => result.id));
  return pack.scripts.map((script) => {
    const failedProbes = (script.requiredProbes ?? []).filter((id) => failed.has(id));
    return { scriptId: script.id, available: failedProbes.length === 0, failedProbes };
  });
}

function probeDetail(result: PackProbeResult): string | undefined {
  if (!result.ok) return result.message;
  if (result.kind === "binary") return result.path;
  if (result.kind === "platform") return result.platform;
  return undefined;
}

function toContractProbe(result: PackProbeResult): ProbeResult {
  const detail = probeDetail(result);
  return { id: result.id, ok: result.ok, ...(detail ? { detail } : {}) };
}

function isRunnerSandboxDenied(value: unknown): value is RunnerSandboxDenied {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && value.kind === "sandbox-denied"
    && "resource" in value
    && typeof value.resource === "string";
}

function isPackExecutionDetails(value: unknown): value is { exitCode: number | null; stdout: string; stderr: string; confined: boolean; alpha?: boolean } {
  return typeof value === "object"
    && value !== null
    && "exitCode" in value
    && "stdout" in value
    && "stderr" in value
    && "confined" in value
    && (typeof value.exitCode === "number" || value.exitCode === null)
    && typeof value.stdout === "string"
    && typeof value.stderr === "string"
    && typeof value.confined === "boolean";
}

async function assertReadFinalReadablePolicy(
  policy: RunnerSandboxPolicy,
  workspaceRoot: string,
  declaredReadables: readonly string[],
): Promise<void> {
  const [resolvedWorkspace, resolvedReadables, resolvedDeclared] = await Promise.all([
    resolveRunnerSandboxPath(workspaceRoot),
    Promise.all(policy.filesystem.readable.map(resolveRunnerSandboxPath)),
    Promise.all(declaredReadables.map(resolveRunnerSandboxPath)),
  ]);
  const exceedsDeclaredInputs = resolvedReadables.find((path) =>
    (isPathEqualOrWithin(resolvedWorkspace, path) || isPathEqualOrWithin(path, resolvedWorkspace))
    && !resolvedDeclared.some((declared) => isPathEqualOrWithin(declared, path)));
  if (exceedsDeclaredInputs) {
    unavailableReadCapability({
      code: "readable-policy-forbidden",
      message: `Declared read Script Pack capability unavailable: final readable policy exceeds declared workspace inputs (${exceedsDeclaredInputs}).`,
    });
  }
}

async function assertReadPolicyWritableOnlyScratch(policy: RunnerSandboxPolicy, scratchDir: string): Promise<void> {
  const scratchRoot = await resolveRunnerSandboxPath(scratchDir);
  const writable = await Promise.all(policy.filesystem.writable.map(resolveRunnerSandboxPath));
  const escapingWritable = writable.find((path) => !isPathWithin(scratchRoot, path));
  if (escapingWritable) {
    unavailableReadCapability({
      code: "read-writable-grant-forbidden",
      message: `Declared read Script Pack capability unavailable: writable grants are forbidden outside verified scratch (${escapingWritable}).`,
    });
  }
}

async function assertReadWorkspaceReadablePolicy(input: {
  workspaceRoot?: string;
  declaredReadables: readonly string[];
  requiredPaths: readonly string[];
  absoluteRequiredPaths: readonly string[];
  sandboxReadable: readonly string[];
}): Promise<void> {
  if (!input.workspaceRoot) return;
  const workspaceRoot = await resolveRunnerSandboxPath(input.workspaceRoot);
  const [declaredReadables, requiredPaths, absoluteRequiredPaths, sandboxReadable] = await Promise.all([
    Promise.all(input.declaredReadables.map(resolveRunnerSandboxPath)),
    Promise.all(input.requiredPaths.map(resolveRunnerSandboxPath)),
    Promise.all(input.absoluteRequiredPaths.map(resolveRunnerSandboxPath)),
    Promise.all(input.sandboxReadable.map(resolveRunnerSandboxPath)),
  ]);
  const overlapsWorkspace = (path: string) =>
    isPathEqualOrWithin(workspaceRoot, path) || isPathEqualOrWithin(path, workspaceRoot);

  const override = sandboxReadable.find(overlapsWorkspace);
  if (override) {
    throw new Error(`Declared read Script Pack capability has a workspace readable override: ${override}`);
  }
  const selfGrantedAbsolutePath = absoluteRequiredPaths.find((path) =>
    ![...declaredReadables, ...sandboxReadable].some((granted) => isPathEqualOrWithin(granted, path)));
  if (selfGrantedAbsolutePath) {
    unavailableReadCapability({
      code: "readable-policy-forbidden",
      message: `Declared read Script Pack capability unavailable: absolute required path is not host-granted readable (${selfGrantedAbsolutePath}).`,
    });
  }
  const requiredPath = requiredPaths.find((path) =>
    overlapsWorkspace(path) && !declaredReadables.some((declared) => isPathEqualOrWithin(declared, path)));
  if (requiredPath) {
    throw new Error(`Declared read Script Pack capability workspace required path is not declared readable: ${requiredPath}`);
  }
}

async function resolveWorkspacePaths(
  workspaceDir: string,
  paths: readonly string[],
  pathKind: "output" | "readable" = "output",
): Promise<string[]> {
  const root = await resolveRunnerSandboxPath(workspaceDir);
  const resolved: string[] = [];
  for (const path of paths) {
    const resolvedPath = await resolveRunnerSandboxPath(path);
    const rel = relative(root, resolvedPath);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      resolved.push(resolvedPath);
      continue;
    }
    throw new Error(`Pack ${pathKind} path escapes workspace: ${path}`);
  }
  return resolved;
}

async function assertWorkspacePaths(
  workspaceDir: string,
  paths: readonly string[],
  pathKind: "output" | "readable" = "output",
): Promise<void> {
  await resolveWorkspacePaths(workspaceDir, paths, pathKind);
}

function assertWorkspacePathsSync(
  workspaceDir: string,
  paths: readonly string[],
  pathKind: "output" | "readable" = "output",
): void {
  const root = resolveRunnerSandboxPathSync(workspaceDir);
  for (const path of paths) {
    const rel = relative(root, resolveRunnerSandboxPathSync(path));
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) continue;
    throw new Error(`Pack ${pathKind} path escapes workspace: ${path}`);
  }
}

function samePackIdentity(left: CoreScriptPack, right: CoreScriptPack): boolean {
  return left.name === right.name && left.version === right.version && left.contentHash === right.contentHash;
}

function matchesExpectedIdentity(pack: CoreScriptPack, expect: NonNullable<Parameters<PackRunner["run"]>[0]["expect"]>): boolean {
  return pack.name === expect.name && pack.version === expect.version && pack.contentHash === expect.contentHash;
}

function emitPackRunEvent(opts: Parameters<PackRunner["run"]>[0], event: Parameters<NonNullable<typeof opts.onEvent>>[0]): void {
  try {
    opts.onEvent?.(event);
  } catch {
    // Host listeners are observational. They cannot change execution semantics.
  }
}

async function contractOutputs(paths: readonly string[]): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const outputs: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Pack script did not produce declared output file: ${path}`);
    const bytes = await readFile(path);
    outputs.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: info.size });
  }
  return outputs;
}

export async function packRunResultFromCapability(
  result: CapabilityResult<unknown>,
  outputPaths: readonly string[],
  alpha: boolean,
): Promise<PackRunResult> {
  const details = isPackExecutionDetails(result.details) ? result.details : undefined;
  const resultRecord = typeof result.details === "object" && result.details !== null
    ? result.details as Record<string, unknown>
    : undefined;
  const attestation: SandboxAttestation = {
    platform: process.platform,
    confined: details?.confined ?? resultRecord?.confined === true,
    ...((details?.alpha === true || resultRecord?.alpha === true || alpha) ? { alpha: true } : {}),
  };
  if (result.isError) {
    if (isRunnerSandboxDenied(result.details)) {
      return {
        ok: false,
        denied: { kind: "sandbox-denied", rule: result.details.resource, detail: result.details.detail },
        attestation,
      };
    }
    return { ok: false, error: result.text, attestation };
  }
  if (!isPackExecutionDetails(result.details)) {
    return { ok: false, error: "Pack script did not return execution details.", attestation };
  }
  let outputs: Array<{ path: string; sha256: string; bytes: number }>;
  try {
    outputs = await contractOutputs(outputPaths);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), attestation };
  }
  return {
    ok: true,
    outputs,
    stdoutPreview: result.details.stdout.slice(0, PACK_STDOUT_PREVIEW_MAX_CHARS),
    attestation,
  };
}

const CORE_PACK_RUNNER_GRANTS = Symbol("core-pack-runner-grants");

type InternalBoundPackScriptGrants = Omit<Parameters<typeof createPackScriptCapability>[0], "pack" | "scriptId">;

type CorePackRunnerGrantMethods = {
  probe(packRoot: string, grants?: BoundPackProbeGrants): Promise<ProbeResult[]>;
  run(opts: Parameters<PackRunner["run"]>[0], grants?: InternalBoundPackScriptGrants): Promise<PackRunResult>;
};

type CorePackRunner = PackRunner & { [CORE_PACK_RUNNER_GRANTS]: CorePackRunnerGrantMethods };

function corePackRunnerMethods(runner: PackRunner): CorePackRunnerGrantMethods | undefined {
  return CORE_PACK_RUNNER_GRANTS in runner
    ? (runner as CorePackRunner)[CORE_PACK_RUNNER_GRANTS]
    : undefined;
}

export function createPackRunner(options: {
  loadPack: (packRoot: string) => Promise<CoreScriptPack>;
  /** @internal Test seam: observes the exact production spawn call. */
  _spawn?: typeof spawnConfined;
}): PackRunner {
  const probe = async (packRoot: string, grants: BoundPackProbeGrants = {}): Promise<ProbeResult[]> =>
    (await runPackProbes(await options.loadPack(packRoot), grants)).map(toContractProbe);
  const run = async (
    opts: Parameters<PackRunner["run"]>[0],
    grants: InternalBoundPackScriptGrants = {},
  ): Promise<PackRunResult> => {
    let snapshotParent: string | undefined;
    try {
      const originalPack = await options.loadPack(opts.packRoot);
      if (await resolveRunnerSandboxPath(originalPack.root) !== await resolveRunnerSandboxPath(opts.packRoot)) {
        return { ok: false, error: "pack-root-mismatch" };
      }
      if (opts.expect && !matchesExpectedIdentity(originalPack, opts.expect)) return { ok: false, error: "pack-identity-mismatch" };

      // Determine READ authority before copying anything. The private pack
      // snapshot is itself a filesystem write, so it must use verified runner
      // scratch rather than attacker-controlled TMPDIR.
      const originalScript = findScript(originalPack, opts.scriptId);
      const touchedPaths = opts.touchedPaths ?? [];
      const readablePaths = grants.readablePaths?.(opts.args) ?? [];
      if (declaredScriptRisk(originalScript) === "read") {
        if (touchedPaths.length > 0) {
          unavailableReadCapability({
            code: "read-writable-grant-forbidden",
            message: "Declared read Script Pack capability unavailable: writable grants are forbidden.",
          });
        }
        await assertWorkspacePaths(opts.workspaceDir, readablePaths, "readable");
      }
      snapshotParent = declaredScriptRisk(originalScript) === "read"
        // Distinct base from the run scratch ("bridle-runner"): the snapshot's
        // pack.root becomes a protected readable of the later run-scratch call,
        // so a shared base would make that call reject its own base.
        ? await createVerifiedRunnerScratchDir([
          opts.workspaceDir,
          originalPack.root,
          homedir(),
          ...readablePaths,
          ...(grants.sandbox?.filesystem?.readable ?? []),
          ...(grants.sandbox?.filesystem?.writable ?? []),
        ], "bridle-pack-snapshot")
        : await mkdtemp(join(resolve(process.env.TMPDIR ?? "/tmp"), "bridle-pack-snapshot-"));
      const snapshotRoot = join(snapshotParent, "pack");
      const originalRoot = await resolveRunnerSandboxPath(opts.packRoot);
      await cp(originalRoot, snapshotRoot, { recursive: true, dereference: false, verbatimSymlinks: true });
      const pack = await options.loadPack(snapshotRoot);
      if (await resolveRunnerSandboxPath(pack.root) !== await resolveRunnerSandboxPath(snapshotRoot)) {
        return { ok: false, error: "pack-root-mismatch" };
      }
      if (!samePackIdentity(originalPack, pack) || (opts.expect && !matchesExpectedIdentity(pack, opts.expect))) {
        return { ok: false, error: "pack-identity-mismatch" };
      }
      await assertWorkspacePaths(opts.workspaceDir, touchedPaths);
      // Attested outputs default to the full touched set (create/overwrite packs);
      // a mutation (move/delete) declares the narrower set that actually remains.
      // Never wider than the write-grant, and still workspace-confined.
      const outputPaths = opts.outputPaths ?? touchedPaths;
      await assertWorkspacePaths(opts.workspaceDir, outputPaths);
      const script = findScript(pack, opts.scriptId);
      if (declaredScriptRisk(script) === "read") {
        if (touchedPaths.length > 0) {
          unavailableReadCapability({
            code: "read-writable-grant-forbidden",
            message: "Declared read Script Pack capability unavailable: writable grants are forbidden.",
          });
        }
        await assertWorkspacePaths(opts.workspaceDir, readablePaths, "readable");
      }
      let alpha = false;
      const sandbox = grants.sandbox;
      const capability = createPackScriptCapability({
        pack,
        scriptId: opts.scriptId,
        touchedPaths: declaredScriptRisk(script) === "read" ? undefined : () => touchedPaths,
        readablePaths: grants.readablePaths ? () => readablePaths : undefined,
        workspaceRoot: opts.workspaceDir,
        trust: grants.trust,
        allowUnreviewedReads: grants.allowUnreviewedReads,
        envAllowlist: grants.envAllowlist,
        sandbox: {
          ...sandbox,
          filesystem: {
            readable: [
              ...(declaredScriptRisk(script) === "read" ? [] : [opts.workspaceDir]),
              ...(sandbox?.filesystem?.readable ?? []),
            ],
            writable: [...(sandbox?.filesystem?.writable ?? [])],
          },
        },
        _spawn: options._spawn,
      });
      const result = await capability.execute(opts.args, {
        trigger: { id: "pack-runner", source: "app", trust: "trusted_app" },
        sessionId: "pack-runner",
        signal: opts.signal,
        audit: (event) => {
          if (event.type === "pack.script.sandbox_alpha") alpha = true;
          emitPackRunEvent(opts, { type: "audit", event: { type: event.type, ...(event.message ? { message: event.message } : {}) } });
          if (event.type === "pack.script.stdout" && event.message) emitPackRunEvent(opts, { type: "stdout", chunk: event.message });
          if (event.type === "pack.script.stderr" && event.message) emitPackRunEvent(opts, { type: "stderr", chunk: event.message });
        },
      });
      const contractResult = await packRunResultFromCapability(result, outputPaths, alpha);
      if (!contractResult.ok && contractResult.denied) emitPackRunEvent(opts, { type: "denied", denial: contractResult.denied });
      return contractResult;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (snapshotParent) await rm(snapshotParent, { recursive: true, force: true });
    }
  };
  const runner: CorePackRunner = {
    probe: (packRoot) => probe(packRoot),
    async availability(packRoot, scriptId) {
      const pack = await options.loadPack(packRoot);
      const probeResults = await runPackProbes(pack);
      const script = findScript(pack, scriptId);
      const resultsById = new Map(probeResults.map((result) => [result.id, result]));
      const blockers = (script.requiredProbes ?? []).flatMap((probeId) => {
        const result = resultsById.get(probeId);
        if (result?.ok) return [];
        return [{ code: `probe:${probeId}`, message: result && !result.ok ? result.message : `Required probe failed: ${probeId}` }];
      });
      return { ready: blockers.length === 0, blockers };
    },
    run: (opts) => run(opts),
    [CORE_PACK_RUNNER_GRANTS]: {
      probe,
      run,
    },
  };
  return runner;
}

export function getManagedAssetCard(pack: CoreScriptPack, assetId: string): ManagedAssetCard {
  const asset = findAsset(pack, assetId);
  return {
    assetId: asset.id,
    description: asset.description,
    sizeBytes: asset.sizeBytes,
    source: asset.source,
    consentText: asset.consentText,
  };
}

function defaultHfHome(): string {
  return process.env.HF_HOME?.trim() || join(homedir(), ".cache", "huggingface");
}

function assetDestination(hfHome: string, pack: CoreScriptPack, asset: CorePackAsset): string {
  if (asset.source.kind === "hf") {
    return join(hfHome, "hub", `models--${asset.source.repo.replace("/", "--")}`, "bridle-managed", asset.id);
  }
  return join(hfHome, "bridle-managed", capabilitySegment(pack.name), asset.id);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyDownloadedAsset(asset: CorePackAsset, files: readonly string[]): Promise<void> {
  if (asset.checksum.algorithm !== "sha256") throw new Error(`Unsupported checksum algorithm: ${asset.checksum.algorithm}`);
  const actual = files.length === 1 ? await fileSha256(files[0]!) : await downloadedAssetTreeSha256(files);
  if (actual !== asset.checksum.value) throw new Error(`Managed asset checksum mismatch: expected ${asset.checksum.value}, got ${actual}`);
}

async function verifyManagedAssetResult(asset: CorePackAsset, result: { files: readonly string[]; verifiedChecksum?: string }): Promise<void> {
  if (asset.checksum.algorithm !== "sha256") throw new Error(`Unsupported checksum algorithm: ${asset.checksum.algorithm}`);
  if (result.verifiedChecksum !== undefined) {
    if (result.verifiedChecksum !== asset.checksum.value) {
      throw new Error(`Managed asset checksum mismatch: expected ${asset.checksum.value}, got ${result.verifiedChecksum}`);
    }
    return;
  }
  await verifyDownloadedAsset(asset, result.files);
}

async function downloadedAssetTreeSha256(files: readonly string[]): Promise<string> {
  const commonRoot = commonParent(files);
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const rel = relative(commonRoot, file).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function commonParent(files: readonly string[]): string {
  const [first, ...rest] = files.map((file) => file.split(sep).slice(0, -1));
  if (!first) return "";
  let end = first.length;
  for (const parts of rest) {
    let index = 0;
    while (index < end && index < parts.length && first[index] === parts[index]) index += 1;
    end = index;
  }
  return first.slice(0, end).join(sep) || sep;
}

async function defaultDownload({ asset, destination }: Parameters<ManagedAssetDownload>[0]): Promise<{ files: string[] }> {
  await mkdir(destination, { recursive: true });
  if (asset.source.kind !== "url") throw new Error(`No default downloader for HF asset ${asset.source.repo}; provide a download implementation.`);
  const response = await fetch(asset.source.url);
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${asset.source.url}`);
  const file = join(destination, asset.source.url.split("/").filter(Boolean).at(-1) ?? asset.id);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return { files: [file] };
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type HfSibling = {
  rfilename: string;
  size?: number;
  blobId?: string;
  lfs?: {
    sha256?: string;
    size?: number;
  };
};

function hfManifestChecksum(siblings: readonly HfSibling[]): string {
  const hash = createHash("sha256");
  for (const file of [...siblings].sort((a, b) => a.rfilename.localeCompare(b.rfilename))) {
    hash.update(file.rfilename);
    hash.update("\0");
    hash.update(String(file.size ?? file.lfs?.size ?? 0));
    hash.update("\0");
    hash.update(file.lfs?.sha256 ?? file.blobId ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function downloadHuggingFaceAsset(
  input: Parameters<ManagedAssetDownload>[0],
  options: { fetchImpl: FetchLike; maxBytes?: number },
): Promise<{ files: string[]; verifiedChecksum: string }> {
  if (input.asset.source.kind !== "hf") throw new Error("downloadHuggingFaceAsset requires an HF asset source.");
  const repo = input.asset.source.repo;
  const metadataResponse = await options.fetchImpl(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: input.signal });
  if (!metadataResponse.ok) throw new Error(`Hugging Face metadata request failed ${metadataResponse.status}: ${repo}`);
  const metadata = await metadataResponse.json() as { siblings?: HfSibling[] };
  const siblings = (metadata.siblings ?? []).filter((file) => file.rfilename && !file.rfilename.endsWith("/"));
  const totalBytes = siblings.reduce((sum, file) => sum + (file.size ?? file.lfs?.size ?? 0), 0);
  if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
    throw new Error(`Managed asset ${repo} exceeds byte limit: ${totalBytes} > ${options.maxBytes}`);
  }
  const verifiedChecksum = hfManifestChecksum(siblings);
  if (verifiedChecksum !== input.asset.checksum.value) {
    throw new Error(`Managed asset checksum mismatch: expected ${input.asset.checksum.value}, got ${verifiedChecksum}`);
  }

  const files: string[] = [];
  for (const sibling of siblings) {
    const target = join(input.destination, sibling.rfilename);
    await mkdir(join(target, ".."), { recursive: true });
    const fileResponse = await options.fetchImpl(`https://huggingface.co/${repo}/resolve/main/${sibling.rfilename}`, { signal: input.signal });
    if (!fileResponse.ok) throw new Error(`Hugging Face file download failed ${fileResponse.status}: ${sibling.rfilename}`);
    await writeFile(target, Buffer.from(await fileResponse.arrayBuffer()));
    if (sibling.lfs?.sha256) {
      const actual = await fileSha256(target);
      if (actual !== sibling.lfs.sha256) throw new Error(`Hugging Face LFS checksum mismatch for ${sibling.rfilename}: expected ${sibling.lfs.sha256}, got ${actual}`);
    }
    files.push(target);
  }
  return { files, verifiedChecksum };
}

export function createManagedAssetDownloadCapability(options: {
  pack: CoreScriptPack;
  assetId: string;
  hfHome?: string;
  download?: ManagedAssetDownload;
  fetch?: FetchLike;
  maxBytes?: number;
}): Capability {
  const asset = findAsset(options.pack, options.assetId);
  const fetchImpl = options.fetch ?? fetch;
  const download = options.download ?? ((input) => input.asset.source.kind === "hf"
    ? downloadHuggingFaceAsset(input, { fetchImpl, maxBytes: options.maxBytes })
    : defaultDownload(input));
  const capabilityName = `pack.${capabilitySegment(options.pack.name)}.download_${capabilitySegment(asset.id)}`;

  return {
    name: capabilityName,
    description: `Download managed asset ${options.pack.name}/${asset.id}.`,
    risk: "sync",
    parameters: Type.Object({ consent: Type.Boolean() }),
    preview: () => asset.consentText,
    execute: async (input, ctx) => {
      if (!input.consent) return { text: `Download for ${asset.id} requires explicit consent.`, isError: true };
      const hfHome = options.hfHome ?? defaultHfHome();
      const destination = assetDestination(hfHome, options.pack, asset);
      await mkdir(destination, { recursive: true });
      const result = await download({ pack: options.pack, asset, destination, signal: ctx.signal });
      for (const file of result.files) {
        const info = await stat(file);
        if (!info.isFile()) throw new Error(`Managed asset downloader returned a non-file path: ${file}`);
      }
      await verifyManagedAssetResult(asset, result);
      ctx.audit({
        type: "pack.asset.downloaded",
        capability: capabilityName,
        risk: "sync",
        metadata: { pack: options.pack.name, asset: asset.id, destination, files: result.files },
      });
      return { text: `Downloaded managed asset ${asset.id}.`, details: { destination, files: result.files } };
    },
  };
}

export type BoundPackScriptGrants = Omit<Parameters<typeof createPackScriptCapability>[0], "pack" | "scriptId" | "trust">;
export type BoundPackProbeGrants = Parameters<typeof runPackProbes>[1];
export type BoundPackManagedAssetGrants = Omit<Parameters<typeof createManagedAssetDownloadCapability>[0], "pack" | "assetId">;

export interface BindPackGrants {
  workspaceRoot: string;
  trust?: PackTrustTier;
  allowUnreviewedReads?: boolean;
  scripts?: Record<string, BoundPackScriptGrants>;
  probes?: BoundPackProbeGrants;
  managedAssets?: Record<string, BoundPackManagedAssetGrants>;
}

/**
 * Bind a loaded pack into Host App-ready surfaces. `grants.scripts[scriptId]`
 * maps directly to createPackScriptCapability minus `pack`/`scriptId`;
 * `grants.probes` maps directly to runPackProbes options; and
 * `grants.managedAssets[assetId]` maps directly to
 * createManagedAssetDownloadCapability minus `pack`/`assetId`.
 */
export async function bindPack(
  pack: CoreScriptPack,
  runner: PackRunner,
  grants: BindPackGrants,
): Promise<{ capabilities: Capability[]; probes: ProbeResult[]; managedAssets: ManagedAssetCard[] }> {
  const coreMethods = corePackRunnerMethods(runner);
  const scriptCapabilities = Object.entries(grants.scripts ?? {}).map(([scriptId, scriptGrants]) => {
    const effectiveGrants: InternalBoundPackScriptGrants = {
      ...scriptGrants,
      workspaceRoot: grants.workspaceRoot,
      trust: grants.trust,
      allowUnreviewedReads: scriptGrants.allowUnreviewedReads ?? grants.allowUnreviewedReads,
    };
    const template = createPackScriptCapability({ pack, scriptId, ...effectiveGrants });
    const executorTouchedPaths = (input: unknown): string[] | Promise<string[]> => {
      const discovered = template.touchedPaths?.(input) ?? [];
      if (!Array.isArray(discovered)) {
        // Unreachable for pack templates: createPackScriptCapability deliberately
        // keeps its builder contract synchronous. This branch only satisfies the
        // widened general Capability type without widening pack/perception APIs.
        return discovered.then((paths) => {
          assertWorkspacePathsSync(grants.workspaceRoot, paths);
          return paths;
        });
      }
      const paths = discovered;
      assertWorkspacePathsSync(grants.workspaceRoot, paths);
      return paths;
    };
    if (!coreMethods && (scriptGrants.sandbox !== undefined || (scriptGrants.envAllowlist?.length ?? 0) > 0)) {
      throw new Error(`PackRunner for ${scriptId} cannot apply Core-specific sandbox or env allowlist grants.`);
    }
    if (!coreMethods && template.risk === "read") {
      unavailableReadCapability({
        code: "verified-confinement-required",
        message: "Declared read Script Pack capability unavailable: verified confinement required.",
      });
    }
    return {
      ...template,
      touchedPaths: executorTouchedPaths,
      execute: async (input: unknown, ctx: CapabilityContext): Promise<CapabilityResult<PackRunResult>> => {
        const discovered = template.touchedPaths?.(input) ?? [];
        // Pack templates are sync by contract; the async arm is unreachable here
        // and exists only because Capability.touchedPaths is wider in Core 0.13.0.
        const touchedPaths = Array.isArray(discovered) ? discovered : await discovered;
        const outputPaths = effectiveGrants.outputPaths?.(input) ?? touchedPaths;
        const readablePaths = effectiveGrants.readablePaths?.(input) ?? [];
        try {
          await assertWorkspacePaths(grants.workspaceRoot, touchedPaths);
          await assertWorkspacePaths(grants.workspaceRoot, outputPaths);
          await assertWorkspacePaths(grants.workspaceRoot, readablePaths, "readable");
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
            details: { ok: false, error: "workspace-path-outside" },
            isError: true,
          };
        }
        const runOptions = {
          packRoot: pack.root,
          scriptId,
          args: input,
          workspaceDir: grants.workspaceRoot,
          touchedPaths,
          outputPaths,
          expect: { name: pack.name, version: pack.version, contentHash: pack.contentHash },
          signal: ctx.signal,
        };
        const result = coreMethods
          ? await coreMethods.run(runOptions, effectiveGrants)
          : await runner.run(runOptions);
        if (result.ok) {
          // The script's structured stdout IS the tool result the model must
          // read: a read capability's entire value is its returned data (a
          // folder listing, a file's contents). Surfacing it here is what makes
          // list_folder etc. visible to the model — the generic completion line
          // silently dropped every read tool's payload. Fall back to that line
          // only for scripts that emit nothing (pure side-effect writes). The
          // full PackRunResult stays on `details` for the recorder and host UI.
          const output = result.stdoutPreview.trim();
          return {
            text: output.length > 0 ? output : `Pack script ${scriptId} completed.`,
            details: result,
          };
        }
        if (result.denied) {
          return {
            text: `Runner Sandbox denied rule ${result.denied.rule}${result.denied.detail ? `: ${result.denied.detail}` : ""}`,
            details: result,
            isError: true,
          };
        }
        return { text: result.error ?? `Pack script ${scriptId} failed.`, details: result, isError: true };
      },
    } satisfies Capability;
  });
  const grantedAssets = Object.entries(grants.managedAssets ?? {});
  const assetCapabilities = grantedAssets.map(([assetId, assetGrants]) =>
    createManagedAssetDownloadCapability({ pack, assetId, ...assetGrants }));
  if (!coreMethods && grants.probes !== undefined) {
    throw new Error("This PackRunner cannot apply Core-specific probe resolver grants.");
  }
  const probes = coreMethods
    ? await coreMethods.probe(pack.root, grants.probes)
    : await runner.probe(pack.root);

  return {
    capabilities: [...scriptCapabilities, ...assetCapabilities],
    probes,
    managedAssets: grantedAssets.map(([assetId]) => getManagedAssetCard(pack, assetId)),
  };
}
