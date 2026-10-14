import { resolveScenarioMode, type ScenarioDecl } from "@bridle/contract";
import type { TurnResult } from "./events.ts";
import { createBridle } from "./harness.ts";
import { openRecorder } from "./recorder/query.ts";
import { evaluateScenarioExpectations, type ScenarioEvaluation } from "./contributions/scenario.ts";
import { scriptedSessionFactory } from "./scripted.ts";
import type { ImageNormalizer } from "./context.ts";
import type { ApprovalPolicy, ManifestDefinition } from "./types.ts";

export type RunScenarioDeps = {
  manifest: ManifestDefinition;
  appDataDir: string;
  approvalPolicy?: ApprovalPolicy;
  imageNormalizer?: ImageNormalizer;
};

export type ScenarioRun = {
  runId: string;
  evaluation: ScenarioEvaluation;
  turnResults: TurnResult[];
};

/** Runs a deterministic scenario through the same Pi session, executor, and Flight Recorder path as a live turn. */
export async function runScriptedScenario(scenario: ScenarioDecl, deps: RunScenarioDeps): Promise<ScenarioRun> {
  const mode = resolveScenarioMode(scenario);
  if (!mode.ok || mode.mode !== "scripted" || !scenario.script?.length) {
    throw new Error(`not a scripted scenario${!mode.ok ? `: ${mode.reason}` : ""}`);
  }

  const bridle = await createBridle({
    manifest: deps.manifest,
    appDataDir: deps.appDataDir,
    recording: "full",
    session: scriptedSessionFactory(scenario.script),
    approvalPolicy: deps.approvalPolicy,
    imageNormalizer: deps.imageNormalizer,
  });
  try {
    const turnResults: TurnResult[] = [];
    for (const turn of scenario.script) turnResults.push(await bridle.prompt(turn.prompt));
    const runId = bridle.sessionId;
    const recorder = await openRecorder(deps.appDataDir);
    const evaluation = await evaluateScenarioExpectations(recorder, scenario, runId, {
      scenarioRoot: deps.manifest.workspaceRoot ?? deps.appDataDir,
      platform: process.platform,
      recording: "full",
    });
    return { runId, evaluation, turnResults };
  } finally {
    await bridle.dispose();
  }
}
