/**
 * `plan.propose` in main (ticket 09): turn the agent's input into a checked proposal against the
 * report as it stands, fingerprint the files it depends on, and — on Accept — run the existing Plan
 * operations of src/main/plan.ts in order. This module writes nothing of its own: every write is a
 * Plan operation or the one sanctioned Index-Note creation (`createIndexNote`).
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { MANIFEST_NAME, indexNotePath, readManifest } from './folio'
import { adoptPart, insertPart, materialisePart, movePart, readPlan, removePart, setPartRole, type Plan } from './plan'
import { readPlanForAgent } from './plan-agent-reads'
import { createIndexNote } from './collection'
import { withPlanLock } from './plan-lock'
import { collectionCandidates } from './wikilinks'
import { slugifyFileName, type Workspace } from './workspace'
import {
  ABSENT,
  entriesFromEdits,
  planOperations,
  resolveProposal,
  type FileNow,
  type Fingerprint,
  type PlanAcceptEdits,
  type PlanOp,
  type PlanProposalChange,
  type PlanProposalInput,
  type ProposalBasis,
  type ProposedPlan,
} from '../shared/plan-proposal'

const OPS = new Set(['insert', 'move', 'remove', 'adopt', 'materialise', 'setRole'])

function inDir(dir: string, ...parts: string[]): string {
  const joined = parts.filter((part) => part !== '' && part !== '.').join('/')
  return dir === '' ? joined : joined === '' ? dir : posix.join(dir, joined)
}

const same = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()

/** Check the raw tool input's shape; every refusal is a sentence the agent can act on. */
export function parseProposalInput(raw: unknown): PlanProposalInput {
  if (!raw || typeof raw !== 'object') throw new Error('plan.propose needs { dir, changes }.')
  const input = raw as Record<string, unknown>
  if (typeof input.dir !== 'string') throw new Error('dir must be a Workspace-relative folder ("" for the Workspace root).')
  if (!Array.isArray(input.changes) || input.changes.length === 0) throw new Error('changes must list at least one change.')
  const changes = input.changes.map((value, index): PlanProposalChange => {
    const change = value as Record<string, unknown>
    const where = `changes[${index}]`
    if (!change || typeof change !== 'object' || typeof change.op !== 'string' || !OPS.has(change.op)) {
      throw new Error(`${where}.op must be one of insert, move, remove, adopt, materialise, setRole.`)
    }
    const text = (key: string, required: boolean): string | undefined => {
      const item = change[key]
      if (item === undefined && !required) return undefined
      if (typeof item !== 'string' || !item.trim()) throw new Error(`${where}.${key} must be non-empty text.`)
      return item
    }
    const place = (key: string, required: boolean): number | undefined => {
      const item = change[key]
      if (item === undefined && !required) return undefined
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) throw new Error(`${where}.${key} must be a place in the order counted from 0.`)
      return item
    }
    switch (change.op) {
      case 'insert': {
        const gloss = change.gloss === undefined ? undefined : text('gloss', true)
        const role = text('role', false)
        const at = place('at', false)
        return { op: 'insert', title: text('title', true)!, ...(at !== undefined ? { at } : {}), ...(gloss ? { gloss } : {}), ...(role ? { role } : {}) }
      }
      case 'move': return { op: 'move', title: text('title', true)!, to: place('to', true)! }
      case 'remove': return { op: 'remove', title: text('title', true)! }
      case 'adopt': {
        const at = place('at', false)
        const role = text('role', false)
        return { op: 'adopt', path: text('path', true)!, ...(at !== undefined ? { at } : {}), ...(role ? { role } : {}) }
      }
      case 'materialise': return { op: 'materialise', title: text('title', true)! }
      default: return { op: 'setRole', title: text('title', true)!, role: text('role', true)! }
    }
  })
  const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim() : undefined
  return { dir: input.dir, changes, ...(summary ? { summary } : {}) }
}

/** The report's plan now: the parts, the strays (with the role an adoption would carry), the Index Note. */
export async function proposalBasis(ws: Workspace, dirInput: unknown): Promise<ProposalBasis> {
  const readout = await readPlanForAgent(ws, dirInput)
  const plan = readout.hasIndexNote ? await readPlan(ws, readout.dir) : null
  return {
    dir: readout.dir,
    hasIndexNote: readout.hasIndexNote,
    indexPath: readout.indexPath ?? indexNotePath(ws, readout.dir),
    parts: readout.parts.map((part) => ({ title: part.title, gloss: part.gloss, role: part.role, path: part.path, words: part.words })),
    strays: readout.strays.map((stray) => {
      const role = plan?.unlisted.find((part) => part.path === stray.path)?.role
      return { path: stray.path, title: stray.title, words: stray.words, ...(role && role !== 'section' ? { role } : {}) }
    }),
  }
}

export type PreparedProposal = {
  input: PlanProposalInput
  basis: ProposalBasis
  proposed: ProposedPlan
  ops: PlanOp[]
  /** Workspace-relative files Accept may write: the Index Note, the manifest, each written-out part. */
  writes: string[]
  /** Workspace-relative part files the proposal depends on: a rename of one makes it stale. */
  referenced: string[]
}

/** The file a `materialisePart` at `index` creates (the Plan operation's own naming rule). */
function materialiseTarget(dir: string, contentRoot: string, title: string, index: number): string {
  return inDir(dir, contentRoot, `${String(index + 1).padStart(2, '0')}-${slugifyFileName(title)}`)
}

/** Build the proposal against `basis`, or refuse with the reasons. Reads only. */
export async function prepareFromBasis(ws: Workspace, input: PlanProposalInput, basis: ProposalBasis, edits?: PlanAcceptEdits): Promise<PreparedProposal> {
  const proposed = resolveProposal(basis, entriesFromEdits(input.changes, edits))
  if (proposed.errors.length) throw new Error(`The proposal was not staged: ${proposed.errors.join('; ')}.`)
  if (proposed.count === 0) throw new Error('The proposal changes nothing in the running order.')
  const ops = planOperations(basis, proposed)
  const contentRoot = (await readManifest(ws, basis.dir))?.contentRoot ?? ''
  const targets = ops.flatMap((op) => (op.op === 'materialisePart' ? [materialiseTarget(basis.dir, contentRoot, op.title, op.index)] : []))
  const taken = new Set((await ws.listFiles()).map((file) => file.path))
  const clash = targets.find((path) => taken.has(path))
  if (clash) throw new Error(`The proposal was not staged: writing a part out would create ${clash}, which already exists.`)
  const referenced = [...new Set([
    ...basis.parts.flatMap((part) => (part.path ? [part.path] : [])),
    ...proposed.rows.flatMap((row) => (row.path ? [row.path] : [])),
  ])]
  return {
    input,
    basis,
    proposed,
    ops,
    writes: [basis.indexPath, inDir(basis.dir, MANIFEST_NAME), ...targets],
    referenced,
  }
}

export async function prepareProposal(ws: Workspace, raw: unknown, edits?: PlanAcceptEdits): Promise<PreparedProposal> {
  const input = parseProposalInput(raw)
  return prepareFromBasis(ws, input, await proposalBasis(ws, input.dir), edits)
}

async function hashOf(ws: Workspace, path: string): Promise<string> {
  const absolute = ws.absolute(path)
  if (!existsSync(absolute)) return ABSENT
  try {
    return createHash('sha256').update(await readFile(absolute)).digest('hex')
  } catch {
    return ABSENT
  }
}

/** Fingerprints: written files by content, referenced parts by content and title. */
export async function fingerprintsFor(ws: Workspace, writes: string[], referenced: string[]): Promise<Fingerprint[]> {
  const titles = new Map((await collectionCandidates(ws, '')).map((candidate) => [candidate.path, candidate.title]))
  const prints: Fingerprint[] = []
  for (const path of writes) prints.push({ path, hash: await hashOf(ws, path) })
  for (const path of referenced) {
    if (writes.includes(path)) continue
    prints.push({ path, hash: await hashOf(ws, path), title: titles.get(path) ?? null })
  }
  return prints
}

/** Every Markdown file in `dir` as it is now, plus the named extra files (the manifest is JSON). */
export async function filesNow(ws: Workspace, dir: string, extra: string[]): Promise<FileNow[]> {
  const candidates = await collectionCandidates(ws, dir)
  const files: FileNow[] = []
  for (const candidate of candidates) files.push({ path: candidate.path, hash: await hashOf(ws, candidate.path), title: candidate.title })
  for (const path of extra) {
    if (files.some((file) => file.path === path)) continue
    files.push({ path, hash: await hashOf(ws, path) })
  }
  return files
}

function partIndex(plan: Plan | null, title: string): number {
  const index = plan?.parts.findIndex((part) => same(part.title, title)) ?? -1
  if (index < 0) throw new Error(`The running order no longer has a part titled ${title}.`)
  return index
}

/**
 * Run the proposal's Plan operations in order, each against a fresh read of the plan. Returns the
 * files the operations created (written-out parts, a new Index Note).
 */
export function runPlanOperations(ws: Workspace, dir: string, ops: PlanOp[]): Promise<{ plan: Plan | null; created: string[] }> {
  // One hold of the Folio's lock for the whole run: each operation's read and write, and the reads between them.
  return withPlanLock(ws, dir, () => runPlanOperationsHeld(ws, dir, ops))
}

async function runPlanOperationsHeld(ws: Workspace, dir: string, ops: PlanOp[]): Promise<{ plan: Plan | null; created: string[] }> {
  const created: string[] = []
  for (const op of ops) {
    if (op.op === 'createIndexNote') {
      created.push(await createIndexNote(ws, dir))
      continue
    }
    const plan = await readPlan(ws, dir)
    switch (op.op) {
      case 'removePart':
        await removePart(ws, dir, partIndex(plan, op.title))
        break
      case 'adoptPart': {
        const unlisted = plan?.unlisted.findIndex((part) => part.path === op.path) ?? -1
        if (unlisted >= 0) await adoptPart(ws, dir, unlisted)
        else await insertPart(ws, dir, plan?.parts.length ?? 0, { title: op.title })
        break
      }
      case 'insertPart':
        await insertPart(ws, dir, plan?.parts.length ?? 0, {
          title: op.title,
          ...(op.gloss ? { gloss: op.gloss } : {}),
          ...(op.role ? { role: op.role } : {}),
        })
        break
      case 'movePart':
        await movePart(ws, dir, partIndex(plan, op.title), op.to)
        break
      case 'setPartRole':
        await setPartRole(ws, dir, partIndex(plan, op.title), op.role)
        break
      case 'materialisePart': {
        const index = partIndex(plan, op.title)
        if (index !== op.index) throw new Error(`The part ${op.title} is at place ${index + 1}, not ${op.index + 1}; nothing more was written.`)
        created.push((await materialisePart(ws, dir, index)).path)
        break
      }
    }
  }
  return { plan: await readPlan(ws, dir), created }
}
