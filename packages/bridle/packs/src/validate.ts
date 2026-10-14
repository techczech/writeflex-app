import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseDoc } from "@bridle/knowledge";
import type {
  PackAsset,
  PackAssetSource,
  PackDependency,
  PackProbe,
  PackScript,
  PackScriptRuntime,
  PackSource,
  PackTier,
  PackValidationResult,
} from "./types.ts";
import { isPackHashExcludedPath } from "./filesystem-policy.ts";

const PACK_TYPE = "bridle.script-pack";
const SCRIPT_RUNTIMES = new Set(["uv", "bun"]);
const ESCAPE_HATCH_REASONS = new Set(["licence", "size", "platform", "established-system-dependency"]);
const COPYLEFT_LICENCE_CLASSES = new Set(["copyleft", "gpl", "agpl"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : undefined;
}

function booleanAt(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function stringArrayAt(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isId(value: string): boolean {
  return /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(value);
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function findForbiddenSymlinks(root: string, dir = root): Promise<string[]> {
  const links: string[] = [];
  if (dir === root && (await lstat(root)).isSymbolicLink()) return ["."];
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      links.push(relative(root, path).split(sep).join("/"));
    } else if (info.isDirectory()) {
      links.push(...await findForbiddenSymlinks(root, path));
    }
  }
  return links;
}

function requireRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  issues.push(`${path} must be an object`);
  return null;
}

function requireString(record: Record<string, unknown>, key: string, path: string, issues: string[]): string {
  const value = stringAt(record, key);
  if (value?.trim()) return value;
  issues.push(`${path}.${key} is required`);
  return "";
}

function parseSource(raw: unknown, issues: string[]): PackSource {
  const source = requireRecord(raw, "PACK.md.source", issues);
  if (!source) return { skillPath: "", commit: "" };
  return {
    skillPath: requireString(source, "skill_path", "PACK.md.source", issues),
    commit: requireString(source, "commit", "PACK.md.source", issues),
  };
}

async function parseScripts(raw: unknown[], root: string, probes: Set<string>, assets: Set<string>, issues: string[]): Promise<PackScript[]> {
  const scripts: PackScript[] = [];
  for (const [index, item] of raw.entries()) {
    const path = `PACK.md.scripts[${index}]`;
    const record = requireRecord(item, path, issues);
    if (!record) continue;

    const id = requireString(record, "id", path, issues);
    if (id && !isId(id)) issues.push(`${path}.id is invalid`);

    const entry = requireString(record, "entry", path, issues);
    if (entry && !isSafeRelativePath(entry)) {
      issues.push(`${path}.entry must be a relative path inside the pack`);
    } else if (entry && isPackHashExcludedPath(entry)) {
      issues.push(`${path}.entry uses hash-excluded path: ${entry}`);
    } else if (entry && !(await fileExists(join(root, entry)))) {
      issues.push(`${path}.entry does not exist: ${entry}`);
    }

    const runtime = requireString(record, "runtime", path, issues);
    if (!SCRIPT_RUNTIMES.has(runtime)) issues.push(`${path}.runtime must be one of: uv, bun`);

    const declaredRisk = record.risk;
    if (declaredRisk !== undefined && declaredRisk !== "read" && declaredRisk !== "write") {
      issues.push(`${path}.risk must be one of: read, write`);
    }
    const risk = declaredRisk === "read" ? "read" : "write";

    const argsSchema = requireRecord(record.args_schema, `${path}.args_schema`, issues) ?? {};
    const tier = numberAt(record, "tier");
    if (tier !== 1 && tier !== 2 && tier !== 3) issues.push(`${path}.tier must be one of: 1, 2, 3`);

    const escapeHatchReason = stringAt(record, "escape_hatch_reason");
    if (tier === 3 && !escapeHatchReason) {
      issues.push(`${path}.escape_hatch_reason is required for tier 3 scripts`);
    } else if (escapeHatchReason && !ESCAPE_HATCH_REASONS.has(escapeHatchReason)) {
      issues.push(`${path}.escape_hatch_reason must be one of: ${[...ESCAPE_HATCH_REASONS].join(", ")}`);
    }

    const requiredProbes = stringArrayAt(record, "required_probes");
    for (const probeId of requiredProbes) {
      if (!probes.has(probeId)) issues.push(`${path}.required_probes references unknown probe: ${probeId}`);
    }

    const requiredAssets = stringArrayAt(record, "required_assets");
    for (const assetId of requiredAssets) {
      if (!assets.has(assetId)) issues.push(`${path}.required_assets references unknown asset: ${assetId}`);
    }

    const requiredPaths = stringArrayAt(record, "required_paths");

    scripts.push({
      id,
      entry,
      runtime: runtime as PackScriptRuntime,
      risk,
      argsSchema,
      tier: tier as PackTier,
      ...(escapeHatchReason ? { escapeHatchReason } : {}),
      requiredProbes,
      requiredAssets,
      requiredPaths,
    });
  }
  return scripts;
}

function parseProbes(raw: unknown[], issues: string[]): PackProbe[] {
  const probes: PackProbe[] = [];
  for (const [index, item] of raw.entries()) {
    const path = `PACK.md.probes[${index}]`;
    const record = requireRecord(item, path, issues);
    if (!record) continue;
    const id = requireString(record, "id", path, issues);
    if (id && !isId(id)) issues.push(`${path}.id is invalid`);
    const kind = requireString(record, "kind", path, issues);
    probes.push({
      id,
      kind,
      ...(stringAt(record, "command") ? { command: stringAt(record, "command") } : {}),
      ...(stringAt(record, "version") ? { version: stringAt(record, "version") } : {}),
      ...(stringAt(record, "platform") ? { platform: stringAt(record, "platform") } : {}),
    });
  }
  return probes;
}

function parseDependencies(raw: unknown[], issues: string[]): PackDependency[] {
  const dependencies: PackDependency[] = [];
  for (const [index, item] of raw.entries()) {
    const path = `PACK.md.dependencies[${index}]`;
    const record = requireRecord(item, path, issues);
    if (!record) continue;
    const id = requireString(record, "id", path, issues);
    const licence = requireString(record, "licence", path, issues);
    const licenceClass = requireString(record, "licence_class", path, issues);
    const bundled = booleanAt(record, "bundled") ?? false;
    if (bundled && COPYLEFT_LICENCE_CLASSES.has(licenceClass.toLowerCase())) {
      issues.push(`${path} has ${licenceClass} licence class and cannot be bundled`);
    }
    dependencies.push({ id, licence, licenceClass, bundled });
  }
  return dependencies;
}

function parseAssets(raw: unknown[], issues: string[]): PackAsset[] {
  const assets: PackAsset[] = [];
  for (const [index, item] of raw.entries()) {
    const path = `PACK.md.assets[${index}]`;
    const record = requireRecord(item, path, issues);
    if (!record) continue;
    const id = requireString(record, "id", path, issues);
    if (id && !isId(id)) issues.push(`${path}.id is invalid`);
    const description = requireString(record, "description", path, issues);
    const sizeBytes = numberAt(record, "size_bytes") ?? 0;
    if (sizeBytes <= 0) issues.push(`${path}.size_bytes must be a positive number`);

    const sourceRecord = requireRecord(record.source, `${path}.source`, issues);
    const source = parseAssetSource(sourceRecord, `${path}.source`, issues);

    const checksumRecord = isRecord(record.checksum) ? record.checksum : null;
    if (!checksumRecord) issues.push(`${path}.checksum is required`);
    const algorithm = checksumRecord ? stringAt(checksumRecord, "algorithm") : undefined;
    const value = checksumRecord ? stringAt(checksumRecord, "value") : undefined;
    if (checksumRecord && algorithm !== "sha256") issues.push(`${path}.checksum.algorithm must be sha256`);
    if (checksumRecord && (!value || !/^[a-f0-9]{64}$/.test(value))) issues.push(`${path}.checksum.value must be a sha256 hex digest`);

    const consentText = requireString(record, "consent_text", path, issues);
    assets.push({
      id,
      description,
      sizeBytes,
      source,
      checksum: { algorithm: "sha256", value: value ?? "" },
      consentText,
    });
  }
  return assets;
}

function parseAssetSource(record: Record<string, unknown> | null, path: string, issues: string[]): PackAssetSource {
  if (!record) return { kind: "url", url: "" };
  const kind = stringAt(record, "kind");
  if (kind === "hf") {
    return { kind, repo: requireString(record, "repo", path, issues) };
  }
  if (kind === "url") {
    return { kind, url: requireString(record, "url", path, issues) };
  }
  issues.push(`${path}.kind must be one of: hf, url`);
  return { kind: "url", url: "" };
}

function findDuplicateIds(items: readonly { id: string }[], path: string, issues: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) issues.push(`${path} contains duplicate id: ${item.id}`);
    seen.add(item.id);
  }
}

export async function validatePackFolder(root: string): Promise<PackValidationResult> {
  const issues: string[] = [];
  try {
    const symlinks = await findForbiddenSymlinks(root);
    issues.push(...symlinks.map((path) => `Pack contains forbidden symbolic link: ${path}`));
  } catch (error) {
    issues.push(`Pack filesystem inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await readFile(join(root, "PACK.md"), "utf8").catch(() => "");
  if (!raw) return { ok: false, issues: ["PACK.md is required"] };

  const doc = parseDoc(raw, "/PACK.md");
  if (!doc.frontmatter) return { ok: false, issues: ["PACK.md.frontmatter.type is required"] };
  if (!doc.frontmatter.type) {
    issues.push("PACK.md.frontmatter.type is required");
  } else if (doc.frontmatter.type !== PACK_TYPE) {
    issues.push(`PACK.md.frontmatter.type must be "${PACK_TYPE}"`);
  }

  const frontmatter = doc.frontmatter.extra;
  const name = requireString(frontmatter, "name", "PACK.md", issues);
  if (name && !isId(name)) issues.push("PACK.md.name is invalid");
  const version = requireString(frontmatter, "version", "PACK.md", issues);
  if (version && !isSemver(version)) issues.push("PACK.md.version must be semver");
  const source = parseSource(frontmatter.source, issues);

  const probes = parseProbes(arrayAt(frontmatter, "probes"), issues);
  const dependencies = parseDependencies(arrayAt(frontmatter, "dependencies"), issues);
  const assets = parseAssets(arrayAt(frontmatter, "assets"), issues);
  findDuplicateIds(probes, "PACK.md.probes", issues);
  findDuplicateIds(dependencies, "PACK.md.dependencies", issues);
  findDuplicateIds(assets, "PACK.md.assets", issues);

  const scripts = await parseScripts(
    arrayAt(frontmatter, "scripts"),
    root,
    new Set(probes.map((probe) => probe.id)),
    new Set(assets.map((asset) => asset.id)),
    issues,
  );
  findDuplicateIds(scripts, "PACK.md.scripts", issues);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    pack: { root, name, version, source, scripts, probes, dependencies, assets, body: doc.body.trim() },
  };
}
