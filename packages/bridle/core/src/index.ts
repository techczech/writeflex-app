export { BRIDLE_VERSION } from "./version.ts";
export {
  BridleDisposedError,
  createBridle,
  retractCapability,
  withBuiltinCapabilities,
  type Bridle,
  type BridleAuditEvent,
  type BridleExecutions,
  type BridleModel,
  type BridleSessionFactory,
  type BridleThinkingLevel,
  type BridleTranscriptMessage,
  type BridleVersioning,
  type BridleVersioningCheckpointOptions,
  type BridleVersioningRestoreResult,
} from "./harness.ts";
export { scriptedSessionFactory } from "./scripted.ts";
export { runScriptedScenario, type RunScenarioDeps, type ScenarioRun } from "./scripted-scenario.ts";
export { createManifest, buildSystemPrompt, scopedCapabilities, BridleManifestError } from "./manifest.ts";
export type { PromptComposition } from "./manifest.ts";
export { loadSkills, parseSkill } from "./skills/loader.ts";
export type { Skill, SkillInput, SkillLoadError, SkillLoadResult, SkillTrigger } from "./skills/types.ts";
export {
  defaultMachineInstructionsPath,
  loadMachineInstructions,
  saveMachineInstructions,
} from "./skills/machine-instructions.ts";
export { projectAgentsMd, type ProjectAgentsMdOptions } from "./skills/agents-md.ts";
export { defaultApprovalPolicy } from "./policy.ts";
export { ApprovalBroker } from "./approval.ts";
export { executeCapability } from "./executor.ts";
export type { ExecutorCallContext, ExecutorDeps } from "./executor.ts";
export type { UnknownExecution } from "./execution-journal/index.ts";
export type {
  ActionOutcome,
  AdoptGroupResult,
  CoreProposalSettlementReason,
  HostProposalSettlement,
  HostProposalSettlementReason,
  Proposal,
  ProposalBaseline,
  ProposalFilter,
  ProposalKind,
  ProposalPreview,
  ProposalSettler,
  ProposalSettlementReason,
  ProposalSettlementResult,
  ProposalStatus,
  ProposalStore,
} from "./proposals/types.ts";
export {
  SnapshotStore,
  ABSENT_HASH,
  RestorePointNotEmptyError,
  RestoreRefusedError,
  RestoreIncompleteError,
  RestoreNotRecordedError,
  SnapshotObjectError,
  SnapshotStoreError,
  UNATTRIBUTED_SESSION,
  restoreOperations,
  type JournalEntry,
  type RestoreOperationReport,
  type SnapshotRestoreEvent,
} from "./snapshots.ts";
export { sweepSnapshots, type SnapshotSweepResult } from "./snapshot-retention.ts";
export { openRecorder } from "./recorder/query.ts";
export { createRecorderCapabilities, RECORDER_TOOL_DESCRIPTIONS } from "./recorder/interview.ts";
export type {
  RecorderPage,
  RecorderQueries,
  RecorderRange,
  RecorderSearchResult,
  RecorderTreeItem,
  TurnSummary,
} from "./recorder/query.ts";
export { RecorderIntegrityError } from "./recorder/store.ts";
export { BridleAuth, DEFAULT_OAUTH_REFRESH_TIMEOUT_MS, migrateAuthFile } from "./auth.ts";
export type { BridleAuthFileOptions } from "./auth.ts";
export {
  bindPack,
  createManagedAssetDownloadCapability,
  createPackRunner,
  createPackScriptCapability,
  composeRunnerSandboxPolicy,
  getManagedAssetCard,
  getPackScriptAvailability,
  PackReadCapabilityUnavailableError,
  runPackProbes,
} from "./packs.ts";
export {
  canonicalContributionPreimage,
  computeContributionContentHash,
  discoverContributions,
  type ContributionIntegrity,
  type ContributionProvenance,
  type ContributionReject,
  type ContributionSource,
  type DiscoveredContribution,
  type DiscoveryDeps,
  type TrustedRoot,
} from "./contributions/discovery.ts";
export { computeAvailability, type AvailabilityContext } from "./contributions/availability.ts";
export {
  evaluateScenarioExpectations,
  type ScenarioAssertion,
  type ScenarioCheckerEvidence,
  type ScenarioEvaluation,
  type ScenarioEvaluationOptions,
} from "./contributions/scenario.ts";
export type {
  BindPackGrants,
  BoundPackManagedAssetGrants,
  BoundPackProbeGrants,
  BoundPackScriptGrants,
  CorePackAsset,
  CorePackAssetSource,
  CorePackProbe,
  CorePackScript,
  CorePackScriptRisk,
  CoreScriptPack,
  ManagedAssetCard,
  ManagedAssetDownload,
  PackProbeResult,
  PackReadCapabilityUnavailableReason,
  PackScriptAvailability,
  PackTrustTier,
} from "./packs.ts";
export type { RunnerSandboxDenied, RunnerSandboxPolicy, RunnerSandboxResult } from "./runner-sandbox.ts";
export * from "./types.ts";
export type {
  BridleEvent,
  BridleEventPayload,
  ContextItem,
  EgressSummary,
  TurnId,
  TurnOutcome,
  TurnReceipt,
  TurnResult,
  TurnUsage,
} from "./events.ts";
export type { ContextReadResult, ImageNormalizer, NormalizedImage } from "./context.ts";
// Generic provider/model/auth catalog — apps enumerate providers here instead of
// hardcoding them (ADR-0018). The catalog is derived from Pi INSIDE core; apps
// still never import Pi directly.
export {
  getOAuthProviders,
  listProviders,
  type AuthLane,
  type OAuthProviderInfo,
  type ProviderInfo,
  type ProviderModel,
} from "./providers.ts";
// ADR-0001 firewall: the ONLY Pi surface apps may touch — getOAuthProviders,
// OAuthLoginCallbacks, AgentSession (opaque type on Bridle.unsafeSession), and the
// derived provider catalog above (listProviders). No importing Pi directly. See docs/adr/0001, 0018.
export type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
export type { AgentSession } from "@earendil-works/pi-coding-agent";
export { readLatestSessionTranscript, type PersistedSessionMessage, type PersistedSessionTranscript } from "./session-transcript.ts";
export {
  BridleModelNotListedError,
  BridleModelService,
  createModelService,
  listRegistryModels,
  type BridleModelServiceOptions,
  type BridleDiscoveryResult,
  type BridleModelRefreshOutcome,
  type BridleDiscoveryReason,
  type BridleModelRefreshReport,
  type BridleProviderModelChange,
  type BridleRefreshModelsOptions,
  DEFAULT_MODEL_REFRESH_MAX_AGE_MS,
  DEFAULT_FORCED_REFRESH_FLOOR_MS,
  type RegistryModel,
  type RegistryModels,
} from "./model-listing.ts";
export {
  VersionStore,
  VersioningCheckpointParentError,
} from "./versioning/store.ts";
export { takeCheckpoint, type CheckpointOptions } from "./versioning/checkpoint.ts";
export { restoreTo, VersioningRestoreError, type RestoreOptions } from "./versioning/restore.ts";
export {
  resolveWorkspaceIdentity,
  WORKSPACE_MARKER,
  type WorkspaceIdentity,
} from "./versioning/identity.ts";
export {
  collectGarbage,
  checkpointsToKeepFull,
  referencedHashes,
  type RetentionPolicy,
} from "./versioning/retention.ts";
export {
  VersioningLockError,
  type VersioningLockErrorReason,
} from "./versioning/lock.ts";
export {
  VersioningWorkspaceMissingError,
  VersioningWorkspaceUnreadableError,
  type WalkEntryKind,
} from "./versioning/walk.ts";
export type {
  Checkpoint,
  CheckpointEntry,
  CheckpointResult,
  CreatedCheckpointResult,
  NotRolledBackPath,
  NotRolledBackReason,
  NoopCheckpointResult,
  RestoreReport,
  RestoreResult,
  StatIndex,
  StatIndexEntry,
  UncapturedPath,
  UncapturedReason,
  VersioningReport,
} from "./versioning/types.ts";
