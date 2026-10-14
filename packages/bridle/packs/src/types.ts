export type PackScriptRuntime = "uv" | "bun";
export type PackScriptRisk = "read" | "write";
export type PackTier = 1 | 2 | 3;
export type PackAssetSource = { kind: "hf"; repo: string } | { kind: "url"; url: string };

export interface PackSource {
  skillPath: string;
  commit: string;
}

export interface PackScript {
  id: string;
  entry: string;
  runtime: PackScriptRuntime;
  risk: PackScriptRisk;
  argsSchema: Record<string, unknown>;
  tier: PackTier;
  escapeHatchReason?: string;
  requiredProbes: string[];
  requiredAssets: string[];
  requiredPaths: string[];
}

export interface PackProbe {
  id: string;
  kind: string;
  command?: string;
  version?: string;
  platform?: string;
}

export interface PackDependency {
  id: string;
  licence: string;
  licenceClass: string;
  bundled: boolean;
}

export interface PackAsset {
  id: string;
  description: string;
  sizeBytes: number;
  source: PackAssetSource;
  checksum: {
    algorithm: "sha256";
    value: string;
  };
  consentText: string;
}

export interface ScriptPack {
  root: string;
  name: string;
  version: string;
  source: PackSource;
  scripts: PackScript[];
  probes: PackProbe[];
  dependencies: PackDependency[];
  assets: PackAsset[];
  body: string;
}

export interface LoadedScriptPack extends ScriptPack {
  contentHash: string;
  scriptsById: Map<string, PackScript>;
  probesById: Map<string, PackProbe>;
  assetsById: Map<string, PackAsset>;
}

export type PackValidationResult = { ok: true; pack: ScriptPack } | { ok: false; issues: string[] };

export interface PackPin {
  name: string;
  version: string;
  hash: string;
}

export class PackValidationError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`Script Pack validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "PackValidationError";
    this.issues = issues;
  }
}

export class PackHashMismatchError extends Error {
  expected: string;
  actual: string;

  constructor(expected: string, actual: string) {
    super(`Script Pack content hash mismatch: expected ${expected}, got ${actual}.`);
    this.name = "PackHashMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class PackIdentityMismatchError extends Error {
  expected: string;
  actual: string;

  constructor(expected: string, actual: string) {
    super(`Pack pin expected ${expected}, got ${actual}.`);
    this.name = "PackIdentityMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}
