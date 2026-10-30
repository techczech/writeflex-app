import { createContentTools } from "./content-tools.ts";
import { createToolDiscovery } from "./tool-discovery.ts";
import { isAbsolute } from "node:path";
import type { Capability, Manifest, ManifestDefinition, ToolRisk } from "./types.ts";
import type { Skill } from "./skills/types.ts";

const NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** Internal runtime counterpart of ToolRisk, shared with registry generation. */
export function isToolRisk(value: unknown): value is ToolRisk {
  return typeof value === "string" && ["read", "write", "sync", "destructive"].includes(value);
}

export class BridleManifestError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Manifest validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "BridleManifestError";
    this.issues = issues;
  }
}

/**
 * ADR-0003: deny-by-default. Validation runs once at registration; a manifest
 * that fails any invariant is a startup error, not a runtime decision.
 */
export function createManifest(def: ManifestDefinition): Manifest {
  const issues: string[] = [];
  if (!def.appId?.trim()) issues.push("appId is required.");
  if (def.workspaceRoot !== undefined && !isAbsolute(def.workspaceRoot)) {
    issues.push(`workspaceRoot must be an absolute path: ${def.workspaceRoot}`);
  }
  if (def.contentTools) {
    if (!def.workspaceRoot) throw new BridleManifestError(["Content tools require workspaceRoot."]);
    def = { ...def, capabilities: [...def.capabilities, ...createContentTools({ ...def.contentTools, workspaceRoot: def.workspaceRoot })] };
  }
  const seen = new Set<string>();
  for (const cap of def.capabilities) {
    if (!NAME_PATTERN.test(cap.name)) issues.push(`Capability name invalid: "${cap.name}" (lower-case dotted identifiers only).`);
    if (seen.has(cap.name)) issues.push(`Duplicate capability name: "${cap.name}".`);
    seen.add(cap.name);
    if (!isToolRisk(cap.risk)) issues.push(`Capability "${cap.name}" has invalid risk; expected read, write, sync or destructive.`);
    if ((cap.risk === "write" || cap.risk === "destructive") && typeof cap.touchedPaths !== "function") {
      issues.push(`Capability "${cap.name}" is ${cap.risk} but declares no touchedPaths — snapshots (ADR-0003/0008) require it.`);
    }
    if (cap.proposalKind === "change" && typeof cap.touchedPaths !== "function") {
      issues.push(`Capability "${cap.name}" declares Change Proposals but no touchedPaths — Change Proposals require touchedPaths for the baseline guard.`);
    }
    if (!cap.description?.trim()) issues.push(`Capability "${cap.name}" needs a description.`);
  }
  if (issues.length > 0) throw new BridleManifestError(issues);
  return Object.freeze({ ...def, capabilities: [...def.capabilities], validated: true as const });
}

/**
 * ADR-0003: the system prompt is generated from the manifest so the model's
 * world genuinely ends at the boundary. Describe what exists; never mention
 * what doesn't.
 */
/**
 * Provider tool-name pattern (OpenAI Responses API and Anthropic both require
 * `[a-zA-Z0-9_-]+`): canonical dotted capability names are invalid on the wire.
 * Gate-4 find 2026-07-03: every Codex request died with `[tools[0].name]
 * [invalid_string]` before the model ever ran. Tools register — and the system
 * prompt advertises — the wire name; execution closures keep the canonical
 * capability, so policy, traces and audit stay dotted.
 */
export function wireName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Throws when two canonical names collapse to one wire name (e.g. `a.b_c` and `a.b.c`). */
export function assertWireNamesUnique(names: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const wire = wireName(name);
    const clash = seen.get(wire);
    if (clash && clash !== name) {
      throw new BridleManifestError([`Capability names "${clash}" and "${name}" collide on the wire as "${wire}".`]);
    }
    seen.set(wire, name);
  }
}

/**
 * ADR-0025: a minimal plan-first / ask-when-unsure / tool-thrift layer. Kept to
 * three directives on purpose — the anti-goal is an over-cautious agent that asks
 * permission for everything. Included by default; omit via manifest.omitWorkingGuidance.
 */
export const WORKING_GUIDANCE: readonly string[] = [
  "How to work:",
  "- Understand the request before you act. If it's ambiguous, bigger than what was asked, or you're unsure what the user wants, ask one brief question first instead of guessing.",
  "- Use the fewest tools that do the job — read before you change, and don't create, move, or reorganise anything the user didn't ask for.",
  "- Plan a large set of changes before you make them: say what you intend, then stage it.",
];

/**
 * PRD 2026-07-18 S2: the per-turn composition stack — base identity + workspace +
 * working-guidance (always) → machine custom-instructions (if imported) → tool
 * catalogue → the ACTIVE skill's body. Progressive disclosure: until a skill is
 * active only its description is visible; when one IS active the catalogue narrows
 * to its tool scope and the discovery list disappears (a focused agent).
 */
export type PromptComposition = {
  /** Machine-wide custom instructions (the user's "how I like things" layer, S5). */
  customInstructions?: string;
  /** Loaded app skills, surfaced as name + description only until activated. */
  skills?: readonly Skill[];
  /** The active skill: its instructions join the prompt; its scope becomes the whole tool world. */
  activeSkill?: Skill;
};

/** Resolve a skill's tool scope against the manifest; an unbound name is a loud error, never a silent no-op. */
export function scopedCapabilities(manifest: Manifest, skill: Skill): Capability[] {
  const byName = new Map(manifest.capabilities.map((cap) => [cap.name, cap]));
  const missing = skill.tools.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new BridleManifestError(
      missing.map((name) => `Skill "${skill.name}" scopes capability "${name}", which the app does not bind.`),
    );
  }
  // Dedupe: a repeated scope entry must not register the same wire tool twice.
  return [...new Set(skill.tools)].map((name) => byName.get(name)!);
}

/** Internal shared catalogue seam: skill scope is applied before discovery. */
export function discoverManifestTools(manifest: Manifest, composition: PromptComposition = {}) {
  const scoped = composition.activeSkill ? scopedCapabilities(manifest, composition.activeSkill) : manifest.capabilities;
  return createToolDiscovery(scoped, composition.activeSkill
    ? { ...manifest.toolSearch, startingTools: manifest.toolSearch?.startingTools?.filter((name) => scoped.some((cap) => cap.name === name)) }
    : manifest.toolSearch);
}

export function buildSystemPrompt(manifest: Manifest, composition: PromptComposition = {}): string {
  const { customInstructions, skills, activeSkill } = composition;
  const capabilities = discoverManifestTools(manifest, composition).visible();

  const lines: string[] = [];
  if (manifest.systemPromptPreamble) lines.push(manifest.systemPromptPreamble.trim(), "");
  lines.push(
    capabilities.length > 0
      ? "You are an embedded assistant. You act only through the tools listed below; they are your complete set of abilities."
      : "You are an embedded assistant. You have no tools for this task; reply in text only.",
  );
  if (manifest.workspaceRoot) {
    lines.push(`Your entire working world is the folder ${manifest.workspaceRoot}. All paths are relative to it.`);
  }
  if (!manifest.omitWorkingGuidance) lines.push("", ...WORKING_GUIDANCE);
  if (customInstructions?.trim()) lines.push("", "Your user's standing instructions:", customInstructions.trim());
  if (capabilities.length > 0) {
    lines.push("", "Available tools:");
    for (const cap of capabilities) {
      // The model must call the wire name — the dotted canonical name does not exist on the wire.
      lines.push(`- ${wireName(cap.name)}: ${cap.description}`);
    }
  }
  if (activeSkill) {
    lines.push("", `Active skill: ${activeSkill.name}`, activeSkill.instructions);
  } else if (skills && skills.length > 0) {
    // Progressive disclosure: descriptions only; bodies load on activation.
    lines.push("", "Available skills:");
    for (const skill of skills) lines.push(`- ${skill.name}: ${skill.description}`);
  }
  lines.push(
    "",
    "Some tool calls may pause for the user's approval or be staged as reviewable Proposals; when a call reports it was denied or staged, accept that outcome and continue helpfully.",
    "Keep final replies brief and say what changed.",
  );
  return lines.join("\n");
}
