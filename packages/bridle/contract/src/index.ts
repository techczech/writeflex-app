import { Type, type Static, type TSchema } from "typebox";

/**
 * Descriptor contract v2 adds the public ContributionDescriptor catalogue and
 * binding schemas. V1 remains the PackRunner/SecretStore-only contract shipped
 * by @bridle/contract 0.1.x; it did not define contribution descriptors.
 */
export const CONTRACT_VERSION = 2;

export type SecretScope = { appId: string; name: string };

export type SecretNeed = {
  name: string;
  scope?: "app" | "shared";
  guidance: {
    what: string;
    whereToGet: string;
    leakConsequence: string;
  };
  ttlSeconds?: number;
};

export type SecretStatus =
  | { state: "absent" }
  | { state: "present"; setAt: string; expiresAt?: string; expired: boolean };

export interface SecretStore {
  set(scope: SecretScope, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  get(scope: SecretScope): Promise<string | null>;
  delete(scope: SecretScope): Promise<void>;
  status(scope: SecretScope): Promise<SecretStatus>;
}

export type ProbeResult = { id: string; ok: boolean; detail?: string };

export type SandboxAttestation = {
  platform: string;
  confined: boolean;
  alpha?: boolean;
};

export type PackRunDenied = {
  kind: "sandbox-denied";
  rule: string;
  detail?: string;
};

export type PackRunEvent =
  | { type: "stdout" | "stderr"; chunk: string }
  | { type: "denied"; denial: PackRunDenied }
  | { type: "audit"; event: { type: string; message?: string } };

export type PackRunResult =
  | {
      ok: true;
      outputs: { path: string; sha256: string; bytes: number }[];
      stdoutPreview: string;
      attestation: SandboxAttestation;
    }
  | {
      ok: false;
      denied?: PackRunDenied;
      error?: string;
      attestation?: SandboxAttestation;
    };

export interface PackRunner {
  probe(packRoot: string): Promise<ProbeResult[]>;
  availability(
    packRoot: string,
    scriptId: string,
  ): Promise<{ ready: boolean; blockers: { code: string; message: string }[] }>;
  run(opts: {
    packRoot: string;
    scriptId: string;
    args: unknown;
    workspaceDir: string;
    /** Checkers must explicitly request the structural no-egress policy. */
    network?: "none";
    /** Paths the script needs WRITE access to (the sandbox grant); may not all exist after the run (e.g. a moved source, a deleted target). */
    touchedPaths?: string[];
    /** Subset of touched paths that must EXIST as regular files after the run and are hashed as attested outputs. Defaults to touchedPaths (create/overwrite packs). A move declares only the destination; a delete declares none. */
    outputPaths?: string[];
    expect?: { name: string; version: string; contentHash: string };
    signal?: AbortSignal;
    onEvent?: (e: PackRunEvent) => void;
  }): Promise<PackRunResult>;
}

export function secretKey(scope: SecretScope): string {
  return `${scope.appId}/${scope.name}`;
}

export const SecretNeedSchema = Type.Object({
  name: Type.String(),
  scope: Type.Optional(Type.Union([Type.Literal("app"), Type.Literal("shared")])),
  guidance: Type.Object({
    what: Type.String(),
    whereToGet: Type.String(),
    leakConsequence: Type.String(),
  }),
  ttlSeconds: Type.Optional(Type.Number()),
});

export const SecretStatusSchema = Type.Union([
  Type.Object({ state: Type.Literal("absent") }),
  Type.Object({
    state: Type.Literal("present"),
    setAt: Type.String(),
    expiresAt: Type.Optional(Type.String()),
    expired: Type.Boolean(),
  }),
]);

export const ProbeResultSchema = Type.Object({
  id: Type.String(),
  ok: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});

export const SandboxAttestationSchema = Type.Object({
  platform: Type.String(),
  confined: Type.Boolean(),
  alpha: Type.Optional(Type.Boolean()),
});

const PackRunDeniedSchema = Type.Object({
  kind: Type.Literal("sandbox-denied"),
  rule: Type.String(),
  detail: Type.Optional(Type.String()),
});

export const PackRunResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    outputs: Type.Array(Type.Object({
      path: Type.String(),
      sha256: Type.String(),
      bytes: Type.Number(),
    })),
    stdoutPreview: Type.String(),
    attestation: SandboxAttestationSchema,
  }),
  Type.Object({
    ok: Type.Literal(false),
    denied: Type.Optional(PackRunDeniedSchema),
    error: Type.Optional(Type.String()),
    attestation: Type.Optional(SandboxAttestationSchema),
  }),
]);

const Sha256Schema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const ContributionKindSchema = Type.Union([
  Type.Literal("capability"),
  Type.Literal("task"),
  Type.Literal("pack-script"),
  Type.Literal("scenario"),
]);
const RiskSchema = Type.Union([
  Type.Literal("read"), Type.Literal("write"), Type.Literal("sync"), Type.Literal("destructive"),
]);
const EgressClassSchema = Type.Union([Type.Literal("none"), Type.Literal("loopback"), Type.Literal("remote")]);
const PlatformSchema = Type.Union([Type.Literal("darwin"), Type.Literal("win32"), Type.Literal("linux")]);

export const ProbeRefSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  packRoot: Type.String({ minLength: 1 }),
  scriptId: Type.String({ minLength: 1 }),
});

export const ManagedAssetRefSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
export const AuthNeedSchema = Type.Object({ providerId: Type.String({ minLength: 1 }) });
export const LoopbackProbeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
});

export const RequirementsSchema = Type.Object({
  probes: Type.Optional(Type.Array(ProbeRefSchema)),
  assets: Type.Optional(Type.Array(ManagedAssetRefSchema)),
  auth: Type.Optional(Type.Array(AuthNeedSchema)),
  secrets: Type.Optional(Type.Array(SecretNeedSchema)),
  server: Type.Optional(Type.Array(LoopbackProbeSchema)),
  platforms: Type.Optional(Type.Array(PlatformSchema)),
  modelInputs: Type.Optional(Type.Array(Type.Union([Type.Literal("image"), Type.Literal("audio")]))),
});

export const OutputDeclSchema = Type.Object({
  viewer: Type.Union([
    Type.Literal("text"), Type.Literal("table"), Type.Literal("file-list"),
    Type.Literal("media"), Type.Literal("structured"),
  ]),
  deterministic: Type.Optional(Type.Boolean()),
});

export const RecorderExpectationSchema = Type.Object({
  store: Type.Union([Type.Literal("audit"), Type.Literal("ledger"), Type.Literal("session")]),
  contains: Type.String(),
});

const PathHashSchema = Type.Object({ path: Type.String({ minLength: 1 }), hash: Sha256Schema });
const FixtureSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  hash: Sha256Schema,
  input: Type.Optional(Type.String({ minLength: 1 })),
});
const OutputPathSchema = Type.Object({ kind: Type.Literal("exists"), path: Type.String({ minLength: 1 }) });
const OutputNonEmptySchema = Type.Object({ kind: Type.Literal("nonEmpty"), path: Type.String({ minLength: 1 }) });
const OutputContainsSchema = Type.Object({ kind: Type.Literal("contains"), path: Type.String({ minLength: 1 }), value: Type.String() });
const OutputRegexSchema = Type.Object({ kind: Type.Literal("regex"), path: Type.String({ minLength: 1 }), pattern: Type.String() });
const OutputMinLengthSchema = Type.Object({ kind: Type.Literal("minLength"), path: Type.String({ minLength: 1 }), value: Type.Integer({ minimum: 0 }) });
const OutputCountSchema = Type.Object({ kind: Type.Literal("count"), path: Type.String({ minLength: 1 }), value: Type.Integer({ minimum: 0 }) });
export const OutputCheckSchema = Type.Union([
  OutputPathSchema, OutputNonEmptySchema, OutputContainsSchema, OutputRegexSchema, OutputMinLengthSchema, OutputCountSchema,
]);
export const PackScriptRefSchema = Type.Object({ packRoot: Type.String({ minLength: 1 }), scriptId: Type.String({ minLength: 1 }) });

export const ScriptedRoundSchema = Type.Union([
  Type.Object({ kind: Type.Literal("message"), text: Type.String({ minLength: 1 }) }),
  Type.Object({
    kind: Type.Literal("tool-calls"),
    calls: Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), arguments: Type.Any() }), { minItems: 1 }),
  }),
]);

export const TurnScriptSchema = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  rounds: Type.Array(ScriptedRoundSchema, { minItems: 1 }),
});

export const ScenarioDeclSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  fixtures: Type.Array(FixtureSchema),
  outputRoot: Type.String({ minLength: 1 }),
  settings: Type.Optional(Type.Any()),
  expect: Type.Object({
    golden: Type.Optional(Type.Array(PathHashSchema)),
    output: Type.Optional(Type.Array(OutputCheckSchema)),
    evidence: Type.Array(RecorderExpectationSchema),
    checker: Type.Optional(Type.Object({ script: PackScriptRefSchema, hash: Sha256Schema })),
  }),
  live: Type.Optional(Type.Boolean()),
  script: Type.Optional(Type.Array(TurnScriptSchema)),
});

const ProviderSchema = Type.Object({
  package: Type.Optional(Type.String({ minLength: 1 })),
  packName: Type.Optional(Type.String({ minLength: 1 })),
});
const CommonDescriptorSchema = Type.Object({
  contractVersion: Type.Literal(2),
  name: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  contentHash: Sha256Schema,
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  provider: ProviderSchema,
  requirements: Type.Optional(RequirementsSchema),
  settings: Type.Optional(Type.Any()),
  io: Type.Optional(Type.Object({ input: Type.Any(), output: OutputDeclSchema })),
  view: Type.Optional(Type.Any()),
  scenarios: Type.Optional(Type.Array(ScenarioDeclSchema)),
  recorder: Type.Optional(Type.Array(RecorderExpectationSchema)),
});

export const CapabilityBindingSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  risk: RiskSchema,
  egress: Type.Optional(Type.Object({
    class: EgressClassSchema,
    destinations: Type.Optional(Type.Array(Type.String())),
  })),
});
export const TaskBindingSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
export const PackScriptBindingSchema = Type.Object({ scriptId: Type.String({ minLength: 1 }) });
export const ImmutableContributionRefSchema = Type.Object({
  kind: Type.Union([Type.Literal("capability"), Type.Literal("task"), Type.Literal("pack-script")]),
  name: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  contentHash: Sha256Schema,
});
export const ScenarioBindingSchema = Type.Object({
  target: Type.Union([Type.Literal("inline"), ImmutableContributionRefSchema]),
});

export const CapabilityContributionDescriptorSchema = Type.Intersect([
  CommonDescriptorSchema,
  Type.Object({ kind: Type.Literal("capability"), binding: Type.Object({ capability: CapabilityBindingSchema }) }),
]);
export const TaskContributionDescriptorSchema = Type.Intersect([
  CommonDescriptorSchema,
  Type.Object({ kind: Type.Literal("task"), binding: Type.Object({ task: TaskBindingSchema }) }),
]);
export const PackScriptContributionDescriptorSchema = Type.Intersect([
  CommonDescriptorSchema,
  Type.Object({ kind: Type.Literal("pack-script"), binding: Type.Object({ packScript: PackScriptBindingSchema }) }),
]);
export const ScenarioContributionDescriptorSchema = Type.Intersect([
  CommonDescriptorSchema,
  Type.Object({ kind: Type.Literal("scenario"), binding: Type.Object({ scenario: ScenarioBindingSchema }) }),
]);
export const ContributionDescriptorSchema = Type.Union([
  CapabilityContributionDescriptorSchema,
  TaskContributionDescriptorSchema,
  PackScriptContributionDescriptorSchema,
  ScenarioContributionDescriptorSchema,
]);

export const RemediationRefSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("install"), Type.Literal("asset"), Type.Literal("auth"),
    Type.Literal("secret"), Type.Literal("server"),
  ]),
  id: Type.String({ minLength: 1 }),
});
const TerminalTrustBlockerSchema = Type.Object({
  dimension: Type.Literal("trust"),
  code: Type.Union([Type.Literal("hash-mismatch"), Type.Literal("unreviewed-source"), Type.Literal("blocked"), Type.Literal("undiscovered-contribution")]),
  message: Type.String(),
}, { additionalProperties: false });
const RemediableBlockerSchema = Type.Object({
  dimension: Type.Union([Type.Literal("policy"), Type.Literal("requirements"), Type.Literal("runtime")]),
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  remediation: Type.Optional(RemediationRefSchema),
}, { additionalProperties: false });
export const BlockerSchema = Type.Union([TerminalTrustBlockerSchema, RemediableBlockerSchema]);
export const AvailabilityStateSchema = Type.Union([
  Type.Literal("ready"), Type.Literal("needs-dependency"), Type.Literal("needs-asset"),
  Type.Literal("needs-auth"), Type.Literal("needs-secret"), Type.Literal("needs-server"), Type.Literal("unsupported"),
]);
export const AvailabilitySchema = Type.Object({ state: AvailabilityStateSchema, blockers: Type.Array(BlockerSchema) });

export const ScenarioResultSchema = Type.Union([
  Type.Object({ state: Type.Literal("queued") }),
  Type.Object({ state: Type.Literal("running") }),
  Type.Object({ state: Type.Literal("passed") }),
  Type.Object({ state: Type.Literal("failed"), reason: Type.String() }),
  Type.Object({ state: Type.Literal("skipped"), reason: Type.String() }),
  Type.Object({ state: Type.Literal("cancelled") }),
  Type.Object({ state: Type.Literal("infra-error"), reason: Type.String() }),
  Type.Object({ state: Type.Literal("not-assessable"), reason: Type.Literal("recording-off") }),
]);

export type ContributionKind = Static<typeof ContributionKindSchema>;
export type ContributionDescriptor = Static<typeof ContributionDescriptorSchema>;
export type CapabilityContributionDescriptor = Static<typeof CapabilityContributionDescriptorSchema>;
export type TaskContributionDescriptor = Static<typeof TaskContributionDescriptorSchema>;
export type PackScriptContributionDescriptor = Static<typeof PackScriptContributionDescriptorSchema>;
export type ScenarioContributionDescriptor = Static<typeof ScenarioContributionDescriptorSchema>;
export type ScenarioDecl = Static<typeof ScenarioDeclSchema>;
export type ScriptedRound = Static<typeof ScriptedRoundSchema>;
export type TurnScript = Static<typeof TurnScriptSchema>;
export type RecorderExpectation = Static<typeof RecorderExpectationSchema>;
export type OutputCheck = Static<typeof OutputCheckSchema>;
export type Blocker = Static<typeof BlockerSchema>;
export type AvailabilityState = Static<typeof AvailabilityStateSchema>;
export type Availability = Static<typeof AvailabilitySchema>;
export type ScenarioResult = Static<typeof ScenarioResultSchema>;

export function checkTurnScript(script: TurnScript): { ok: boolean; reason?: string } {
  // A message round ends the turn, so exactly the final round may be a message; an
  // earlier message round would silently orphan every round after it.
  const earlyMessage = script.rounds.slice(0, -1).findIndex((round) => round.kind === "message");
  if (earlyMessage !== -1) {
    return { ok: false, reason: `TurnScript round ${earlyMessage} is a message round but is not last; a message round ends the turn.` };
  }
  if (script.rounds.at(-1)?.kind !== "message") {
    return { ok: false, reason: "TurnScript last round must be a message round." };
  }
  return { ok: true };
}

export function resolveScenarioMode(
  scenario: ScenarioDecl,
): { ok: true; mode: "scripted" | "live" } | { ok: false; reason: string } {
  // Presence is defined by real scripted turns, not by the property merely existing —
  // a live scenario carrying `script: undefined`/`[]` is live, not "both modes".
  const hasScriptedTurns = Array.isArray(scenario.script) && scenario.script.length > 0;
  if (scenario.live === true && hasScriptedTurns) {
    return { ok: false, reason: "Scenario cannot declare both live and scripted modes." };
  }
  if (hasScriptedTurns) return { ok: true, mode: "scripted" };
  if (scenario.live === true) return { ok: true, mode: "live" };
  return { ok: false, reason: "Scenario must declare either a non-empty script or live: true." };
}

export function isRenderable(schema: TSchema): { renderable: boolean; reason?: string } {
  const value = schema as Record<string, unknown>;
  if ("$ref" in value) return { renderable: false, reason: "schema references are not renderable" };
  if (Array.isArray(value.anyOf)) {
    const literals = value.anyOf as Array<Record<string, unknown>>;
    return literals.every((item) => Object.hasOwn(item, "const"))
      ? { renderable: true }
      : { renderable: false, reason: "only literal unions are renderable" };
  }
  if (value.type === "string" || value.type === "number" || value.type === "integer" || value.type === "boolean") {
    return { renderable: true };
  }
  if (value.type === "array") {
    const item = value.items as Record<string, unknown> | undefined;
    return item && ["string", "number", "integer", "boolean"].includes(String(item.type))
      ? { renderable: true }
      : { renderable: false, reason: "only arrays of primitives are renderable" };
  }
  if (value.type === "object") {
    const properties = (value.properties ?? {}) as Record<string, TSchema>;
    for (const property of Object.values(properties)) {
      if ((property as Record<string, unknown>).type === "object") {
        return { renderable: false, reason: "nested objects are not renderable" };
      }
      const result = isRenderable(property);
      if (!result.renderable) return result;
    }
    return { renderable: true };
  }
  return { renderable: false, reason: "schema construct is not renderable" };
}
