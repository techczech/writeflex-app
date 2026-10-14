import type { Capability, ManifestDefinition } from '@bridle/core'
import { Workspace } from './workspace'
import { commandAnnotations } from '../renderer/src/commands/registry-annotations'
import { buildVerbTable } from './verbs'
import { PREAMBLE, type CapabilityServices } from './verbs/verb-support'

// Preserve the existing imports used by main-process callers and capability tests.
export {
  capabilityEnabled, CAPABILITY_PERMISSION_KEYS, writeflexApprovalPolicy,
  mergeFrontmatterKeys, setFrontmatterKeys, removeFrontmatterKeys,
  resolveProseInsertAt, resolveProseInsert, resolveProseMove,
  type CapabilityServices, type ProseEditCategory, type ProseEditInput,
  type ProseMoveInput, type ProseInsertInput, type ObjectInsertInput,
  type FrontmatterSetInput, type ResolvedProseMove,
} from './verbs/verb-support'

export function buildWriteFlexManifest(
  workspace: Workspace,
  isEnabled?: (name: string) => boolean,
  services?: CapabilityServices,
): ManifestDefinition {
  const projected = new Set(Object.values(commandAnnotations)
    .filter((command) => command.verb && !command.exclude)
    .map((command) => command.verb))
  const capabilities: Capability[] = buildVerbTable(workspace, services, isEnabled)
    .filter((verb) => (verb.agentOnly || projected.has(verb.id)) && (!isEnabled || isEnabled(verb.id)))
    .map(({ id, describe, run, class: _class, posture: _posture, agentOnly: _agentOnly, ...capability }) => ({
      ...capability,
      name: id,
      description: describe,
      // The permission is read where the verb RUNS, not only where it is proposed: a switch turned off after a
      // proposal was staged stops the accept here, whatever route reached execute (same key as the policy's).
      execute: async (input, ctx) => isEnabled && !isEnabled(id)
        ? { text: `${id} is switched off in Settings, so nothing was done.`, isError: true }
        : run(ctx, input),
    }))
  return { appId: 'writeflex', workspaceRoot: workspace.root, systemPromptPreamble: PREAMBLE, capabilities }
}
