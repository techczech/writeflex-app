import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Blocker, ContributionDescriptor } from "@bridle/contract";
import { ContributionDescriptorSchema } from "@bridle/contract";
import Schema from "typebox/schema";

const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const descriptorCheck = Schema.Compile(ContributionDescriptorSchema);

export type TrustedRoot = {
  path: string;
  trust: "reviewed" | "development" | "unreviewed";
  channel: "folder" | "package";
};

export type ContributionProvenance = {
  channel: "folder" | "package";
  root: string;
  descriptorPath: string;
  packageName?: string;
};

/**
 * Content hashes protect descriptor integrity only: they detect accidental or
 * partial alteration. They do not authenticate an author or a distribution;
 * signing and store curation belong to the deferred store ADR.
 */
export type ContributionIntegrity = {
  contentHash: "verified";
  purpose: "accidental-alteration-detection";
  authentication: "not-provided";
};

export type ContributionSource = {
  provenance: "reviewed-root" | "development-root" | "unreviewed-root";
  blockers: Blocker[];
};

declare const discoveredContributionBrand: unique symbol;
const discoveredContributions = new WeakSet<object>();

export type DiscoveredContribution = {
  descriptor: ContributionDescriptor;
  provenance: ContributionProvenance;
  integrity: ContributionIntegrity;
  source: ContributionSource;
  /** Opaque, discovery-issued marker; hosts cannot construct this contract. */
  readonly [discoveredContributionBrand]: true;
};

export type ContributionReject = {
  descriptorPath: string;
  code: "invalid-json" | "invalid-descriptor" | "hash-mismatch" | "blocked" | "read-error";
  message: string;
  blocker?: Blocker;
};

export type DiscoveryDeps = {
  isBlocked?: (descriptorPath: string) => boolean | Promise<boolean>;
};

type ReferencedFile = { path: string; bytes: Uint8Array };

class ContributionPathEscapeError extends Error {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function issueDiscoveredContribution(value: Omit<DiscoveredContribution, typeof discoveredContributionBrand>): DiscoveredContribution {
  const issued = deepFreeze(value);
  discoveredContributions.add(issued);
  return issued as DiscoveredContribution;
}

/** Runtime companion to the opaque type: only this module can issue a value. */
export function isDiscoveredContribution(value: unknown): value is DiscoveredContribution {
  return value !== null && typeof value === "object" && discoveredContributions.has(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Contribution descriptors must contain JSON values only.");
  return encoded;
}

function uint64be(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function normaliseRelativePath(path: string): string {
  const normalised = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalised.startsWith("/") || normalised === ".." || normalised.startsWith("../") || normalised.includes("/../")) {
    throw new Error(`Referenced contribution path escapes its root: ${path}`);
  }
  return normalised;
}

function entry(path: string, bytes: Uint8Array): Buffer {
  const pathBytes = Buffer.from(path, "utf8");
  const contentBytes = Buffer.from(bytes);
  return Buffer.concat([uint64be(pathBytes.byteLength), pathBytes, uint64be(contentBytes.byteLength), contentBytes]);
}

/**
 * Addendum 2, cross-language preimage algorithm. The stored hash is replaced
 * before canonicalisation, then each logical path and byte payload receives an
 * unsigned 64-bit big-endian length prefix. Descriptor first; referenced files
 * follow in normalised path order. Array order and raw referenced bytes survive.
 */
export function canonicalContributionPreimage(
  descriptor: Record<string, unknown>,
  referencedFiles: readonly ReferencedFile[],
): Buffer {
  const zeroed = { ...descriptor, contentHash: ZERO_HASH };
  const descriptorBytes = Buffer.from(canonicalJson(zeroed), "utf8");
  const files = referencedFiles
    .map((file) => ({ path: normaliseRelativePath(file.path), bytes: file.bytes }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path === files[index]!.path) {
      throw new Error(`Duplicate referenced contribution path: ${files[index]!.path}`);
    }
  }
  return Buffer.concat([
    entry("CONTRIBUTION.json", descriptorBytes),
    ...files.map((file) => entry(file.path, file.bytes)),
  ]);
}

export async function computeContributionContentHash(
  descriptor: Record<string, unknown>,
  referencedFiles: readonly ReferencedFile[],
): Promise<string> {
  return `sha256:${createHash("sha256").update(canonicalContributionPreimage(descriptor, referencedFiles)).digest("hex")}`;
}

function referencedPaths(descriptor: ContributionDescriptor): string[] {
  const paths = new Set<string>();
  for (const scenario of descriptor.scenarios ?? []) {
    for (const fixture of scenario.fixtures) paths.add(normaliseRelativePath(fixture.path));
    const checker = scenario.expect.checker?.script;
    if (checker) {
      const checkerPath = normaliseRelativePath(join(checker.packRoot, checker.scriptId));
      paths.add(checkerPath);
    }
  }
  return [...paths].sort();
}

async function loadReferencedFiles(descriptorPath: string, descriptor: ContributionDescriptor): Promise<ReferencedFile[]> {
  const base = dirname(descriptorPath);
  const resolvedBase = await realpath(base);
  const files: ReferencedFile[] = [];
  for (const path of referencedPaths(descriptor)) {
    const absolute = resolve(base, path);
    if (relative(base, absolute).split(sep).includes("..")) throw new Error(`Referenced contribution path escapes its root: ${path}`);
    const resolved = await realpath(absolute);
    const relation = relative(resolvedBase, resolved);
    if (relation === ".." || relation.startsWith(`..${sep}`)) {
      throw new ContributionPathEscapeError(`Referenced contribution path resolves outside its root: ${path}`);
    }
    files.push({ path, bytes: await readFile(resolved) });
  }
  return files;
}

async function findFolderDescriptors(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of entries) {
      if (item.isSymbolicLink()) continue;
      const child = join(path, item.name);
      if (item.isDirectory()) await walk(child);
      else if (item.isFile() && item.name === "CONTRIBUTION.json") found.push(child);
    }
  }
  await walk(root);
  return found.sort();
}

function packageDirectory(root: string, name: string): string {
  return join(root, "node_modules", ...name.split("/"));
}

async function packageDescriptorPaths(root: string): Promise<Array<{ path: string; packageName: string; blockedMessage?: string }>> {
  const found: Array<{ path: string; packageName: string; blockedMessage?: string }> = [];
  const seen = new Set<string>();
  async function visit(packageRoot: string): Promise<void> {
    const packageJsonPath = join(packageRoot, "package.json");
    if (seen.has(packageJsonPath) || !existsSync(packageJsonPath)) return;
    seen.add(packageJsonPath);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const packageName = typeof manifest.name === "string" ? manifest.name : packageRoot;
    if (typeof manifest.bridle === "string") {
      const descriptorPath = resolve(packageRoot, manifest.bridle);
      const rel = relative(packageRoot, descriptorPath);
      let blockedMessage = rel === ".." || rel.startsWith(`..${sep}`)
        ? `Package bridle path escapes package root: ${manifest.bridle}`
        : undefined;
      if (!blockedMessage) {
        try {
          const [resolvedPackageRoot, resolvedDescriptorPath] = await Promise.all([
            realpath(packageRoot),
            realpath(descriptorPath),
          ]);
          const resolvedRel = relative(resolvedPackageRoot, resolvedDescriptorPath);
          if (resolvedRel === ".." || resolvedRel.startsWith(`..${sep}`)) {
            blockedMessage = `Package bridle path resolves outside package root: ${manifest.bridle}`;
          }
        } catch {
          // Preserve discovery's existing read-error result for missing or unreadable descriptors.
        }
      }
      found.push({
        path: descriptorPath,
        packageName,
        ...(blockedMessage ? { blockedMessage } : {}),
      });
    }
    const dependencyNames = Object.keys({
      ...asRecord(manifest.dependencies),
      ...asRecord(manifest.optionalDependencies),
      ...asRecord(manifest.peerDependencies),
    }).sort();
    for (const dependency of dependencyNames) await visit(packageDirectory(packageRoot, dependency));
  }
  await visit(root);
  return found;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function discoverOne(
  descriptorPath: string,
  provenance: ContributionProvenance,
  root: TrustedRoot,
  deps: DiscoveryDeps,
): Promise<{ contribution?: DiscoveredContribution; reject?: ContributionReject }> {
  if (await deps.isBlocked?.(descriptorPath)) {
    const blocker: Blocker = { dimension: "trust", code: "blocked", message: `Contribution is blocked: ${descriptorPath}` };
    return { reject: { descriptorPath, code: "blocked", message: blocker.message, blocker } };
  }
  let bytes: string;
  try {
    bytes = await readFile(descriptorPath, "utf8");
  } catch (error) {
    return { reject: { descriptorPath, code: "read-error", message: error instanceof Error ? error.message : String(error) } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    return { reject: { descriptorPath, code: "invalid-json", message: error instanceof Error ? error.message : String(error) } };
  }
  if (!descriptorCheck.Check(parsed)) {
    return { reject: { descriptorPath, code: "invalid-descriptor", message: "Descriptor does not conform to ContributionDescriptorSchema." } };
  }
  const descriptor = parsed as ContributionDescriptor;
  let actualHash: string;
  try {
    const files = provenance.channel === "folder" ? await loadReferencedFiles(descriptorPath, descriptor) : [];
    actualHash = await computeContributionContentHash(descriptor as Record<string, unknown>, files);
  } catch (error) {
    if (error instanceof ContributionPathEscapeError) {
      const blocker: Blocker = { dimension: "trust", code: "blocked", message: error.message };
      return { reject: { descriptorPath, code: "blocked", message: blocker.message, blocker } };
    }
    return { reject: { descriptorPath, code: "read-error", message: error instanceof Error ? error.message : String(error) } };
  }
  if (descriptor.contentHash !== actualHash) {
    const blocker: Blocker = { dimension: "trust", code: "hash-mismatch", message: `Contribution hash mismatch: expected ${descriptor.contentHash}, computed ${actualHash}` };
    return { reject: { descriptorPath, code: "hash-mismatch", message: blocker.message, blocker } };
  }
  const blockers: Blocker[] = root.trust === "unreviewed"
    ? [{ dimension: "trust", code: "unreviewed-source", message: `Contribution came from unreviewed root: ${root.path}` }]
    : [];
  return {
    contribution: issueDiscoveredContribution({
      descriptor,
      provenance,
      integrity: {
        contentHash: "verified",
        purpose: "accidental-alteration-detection",
        authentication: "not-provided",
      },
      source: {
        provenance: root.trust === "reviewed" ? "reviewed-root" : root.trust === "development" ? "development-root" : "unreviewed-root",
        blockers,
      },
    }),
  };
}

export async function discoverContributions(roots: readonly TrustedRoot[], deps: DiscoveryDeps = {}): Promise<{
  contributions: DiscoveredContribution[];
  rejects: ContributionReject[];
}> {
  const contributions: DiscoveredContribution[] = [];
  const rejects: ContributionReject[] = [];
  for (const root of roots) {
    const candidates: Array<{ path: string; packageName?: string; blockedMessage?: string }> = root.channel === "folder"
      ? (await findFolderDescriptors(root.path)).map((path) => ({ path }))
      : await packageDescriptorPaths(root.path);
    for (const candidate of candidates) {
      if (candidate.blockedMessage) {
        const blocker: Blocker = { dimension: "trust", code: "blocked", message: candidate.blockedMessage };
        rejects.push({ descriptorPath: candidate.path, code: "blocked", message: candidate.blockedMessage, blocker });
        continue;
      }
      const outcome = await discoverOne(candidate.path, {
        channel: root.channel,
        root: root.path,
        descriptorPath: candidate.path,
        ...(candidate.packageName ? { packageName: candidate.packageName } : {}),
      }, root, deps);
      if (outcome.contribution) contributions.push(outcome.contribution);
      if (outcome.reject) rejects.push(outcome.reject);
    }
  }
  return { contributions, rejects };
}
