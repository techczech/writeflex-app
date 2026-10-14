import { expect, test } from 'bun:test'
import { commandRegistry } from '../../src/renderer/src/commands/registry'

test('every registry command declares its operation class', () => {
  const missing = commandRegistry.filter((command) =>
    !['content', 'view', 'settings', 'chrome'].includes((command as { class?: string }).class ?? ''))
  expect(missing.map((command) => command.id)).toEqual([])
})

import { commandAnnotations } from '../../src/renderer/src/commands/registry-annotations'
import { buildVerbTable } from '../../src/main/verbs'
import { buildWriteFlexManifest, writeflexApprovalPolicy } from '../../src/main/capabilities'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'

const workspace = new Workspace('/tmp/writeflex-parity')
const services = { scraps: new ScrapStore(workspace) }
const verbs = buildVerbTable(workspace, services)
const reasons = ['chrome-only', 'ui-micro', 'human-gate', 'not-yet-projected']

test('annotations cover exactly the live registry, including imported and sheet commands', () => {
  expect(Object.keys(commandAnnotations).sort()).toEqual(commandRegistry.map((c) => c.id).sort())
  expect(new Set(commandRegistry.map((c) => c.id)).size).toBe(commandRegistry.length)
  for (const command of commandRegistry) {
    expect(command.class).toBe(commandAnnotations[command.id].class)
    if (command.sheetSource?.kind === 'command') {
      expect(commandAnnotations[command.id]).toEqual(commandAnnotations[command.sheetSource.commandId])
    }
  }
})

test('content commands project an existing verb or declare a valid exclusion', () => {
  const ids = new Set(verbs.map((verb) => verb.id))
  const errors: string[] = []
  for (const command of commandRegistry) {
    if (command.exclude && !reasons.includes(command.exclude)) errors.push(`${command.id}: invalid exclusion`)
    if (command.class !== 'content') continue
    if (command.exclude === 'not-yet-projected') {
      if (!command.verb || !command.todo?.startsWith('TODO audit ')) errors.push(`${command.id}: missing debt verb/audit row`)
      if (ids.has(command.verb!)) errors.push(`${command.id}: stale temporary exclusion`)
    } else if (!command.exclude && (!command.verb || !ids.has(command.verb))) {
      errors.push(`${command.id}: missing projected verb or reason class`)
    }
  }
  expect(errors).toEqual([])
  const pending = commandRegistry.filter((c) => c.exclude === 'not-yet-projected')
  console.log(`not-yet-projected: ${pending.length}\n${pending.map((c) => `${c.id} -> ${c.verb}`).join('\n')}`)
})

test('each verb is registry-reachable or explicitly agent-only, and projection preserves its metadata', () => {
  const projected = new Set(commandRegistry.filter((c) => !c.exclude).map((c) => c.verb))
  expect(new Set(verbs.map((v) => v.id)).size).toBe(verbs.length)
  expect(verbs.filter((v) => !v.agentOnly && !projected.has(v.id)).map((v) => v.id)).toEqual([])
  const manifest = buildWriteFlexManifest(workspace, undefined, services)
  expect(manifest.capabilities.map((c) => c.name).sort()).toEqual(verbs.map((v) => v.id).sort())
  for (const verb of verbs) {
    expect(['content', 'view', 'settings']).toContain(verb.class)
    expect(['direct', 'proposal', 'approval']).toContain(verb.posture)
    const capability = manifest.capabilities.find((c) => c.name === verb.id)!
    expect(capability.description).toBe(verb.describe)
    expect(capability.parameters).toEqual(verb.parameters)
    expect(typeof capability.preview).toBe(typeof verb.preview)
    // Functions are rebound per table; compare declarations by presence, not closure identity.
  }
})

test('the existing approval policy never lowers a declared posture floor', async () => {
  const policy = writeflexApprovalPolicy()
  for (const verb of verbs) {
    for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
      const decision = await policy({ capability: { name: verb.id, risk: verb.risk }, input: {},
        trigger: { id: 'parity', source: 'user', trust } })
      if (verb.posture === 'proposal') expect(['stage', 'ask', 'deny']).toContain(decision)
      if (verb.posture === 'approval') expect(['ask', 'deny']).toContain(decision)
    }
  }
})

test('the report-plan reads are registered as agent-only read verbs with a direct posture floor', async () => {
  const policy = writeflexApprovalPolicy()
  const manifest = buildWriteFlexManifest(workspace, undefined, services)
  for (const id of ['plan.read', 'plan.compare_parts']) {
    const verb = verbs.find((entry) => entry.id === id)
    expect(verb, `missing verb ${id}`).toBeDefined()
    expect(verb).toMatchObject({ class: 'content', posture: 'direct', agentOnly: true, risk: 'read' })
    expect(manifest.capabilities.find((capability) => capability.name === id)?.risk).toBe('read')
    for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
      expect(await policy({ capability: { name: id, risk: 'read' }, input: {}, trigger: { id: 'parity', source: 'user', trust } })).toBe('allow')
    }
  }
})

test('plan.propose is an agent-only write verb whose floor is a proposal at every trust level', async () => {
  const policy = writeflexApprovalPolicy()
  const verb = verbs.find((entry) => entry.id === 'plan.propose')
  expect(verb).toMatchObject({ class: 'content', posture: 'proposal', agentOnly: true, risk: 'write' })
  for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
    expect(await policy({ capability: { name: 'plan.propose', risk: 'write' }, input: {}, trigger: { id: 'parity', source: 'user', trust } })).toBe('stage')
  }
})
