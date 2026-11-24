/**
 * Git vault sync soak: two clones of one synthetic vault ("Mac A", "Mac B") and a bare remote take many interleaved,
 * seeded rounds of edits, new files, deletes, renames and folder renames on both sides, with sends and receives in
 * between. After every step the invariants of ADR-0055 are checked; after every round both Macs settle (A sends,
 * B receives, B sends, A receives) and must hold byte-identical vault documents.
 *
 * Real `git`, real bare remote, real engine (`createGitVaultSync` through the shared fixture), real files. Synthetic
 * vaults in a temporary folder only; the folder is removed after the run, on failure too.
 *
 * Extended run (`bun run test:extended`): seed 20261121, an overlap step and 3 rounds, about 45 s on the Mac Studio; the
 * per-session time limit is generous because a loaded laptop runs Git several times slower.
 *   WF_SOAK_SEED=<n>     seed for the operation generator (a failure prints the seed, round and operation log;
 *                        rerunning with that seed and at least that many rounds replays it exactly)
 *   WF_SOAK_ROUNDS=<n>   rounds per session
 *   WF_SOAK_SESSIONS=<n> consecutive seeds from WF_SOAK_SEED (each a fresh pair of Macs)
 * The fixture's engines report a Git that merges without rename detection (`renameProbe`), so on Git 2.39.5 (the Mac
 * Studio) the soak still qualifies the merge itself, including the delete/edit defence; the guard has its own test.
 *   WF_SOAK_GITLEAKS=1   use the real gitleaks scanner (default: a stand-in that finds nothing; the soak qualifies
 *                        merging and convergence, and the generator writes no secrets, so the scanner never matters
 *                        except as a dependency that the Mac Studio's test runs do not have)
 * Long mode, for an overnight run through the shared machine slot:
 *   WRITEFLEX_EXTENDED_TESTS=1 WF_SOAK_ROUNDS=200 WF_SOAK_SESSIONS=20 agent-run --timeout 28800 -- bun test tests/main/git-vault-sync-soak.test.ts --timeout 0
 */
import { expect, test } from 'bun:test'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fixture } from './git-vault-sync-fixture'
import { missingGitleaks, testRequiring } from '../helpers/built-output'
import type { GitVaultSyncResult } from '../../src/main/git-vault-sync-types'

const extended = process.env.WRITEFLEX_EXTENDED_TESTS === '1'
const SEED = Number(process.env.WF_SOAK_SEED ?? 20261121)
const ROUNDS = Number(process.env.WF_SOAK_ROUNDS ?? 3)
const SESSIONS = Number(process.env.WF_SOAK_SESSIONS ?? 1)
const REAL_SCANNER = process.env.WF_SOAK_GITLEAKS === '1'
const cleanScanner = async (): Promise<{ findings: [] }> => ({ findings: [] })
const STEPS_PER_ROUND = 6
/** A fixed clock: clash-copy names and pair times depend on the date, so a replay must not depend on the day it runs. */
function soakClock(): () => number {
  let at = Date.UTC(2026, 0, 15, 9, 0, 0)
  return () => (at += 1000)
}
/** ADR-0055 machine-local kinds: never staged, so never in the remote tree. */
const MACHINE_LOCAL = /(?:^|\/)\.writeflex\/widget-step-[^/]*\.json$|\.json\.taken$|\.tmp$|\.lock$|(?:^|\/)\.bridle\/objects\/tmp-/

type Fixture = Awaited<ReturnType<typeof fixture>>
type Mac = 'A' | 'B'

/** mulberry32: small, seedable, the same sequence on every machine. */
function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class SoakFailure extends Error {}

/** Vault documents: every file outside Git and the app's internal folders, path to text. */
async function documents(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  async function walk(folder: string, prefix: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      if (!prefix && ['.git', '.writeflex', '.bridle', '.gitignore'].includes(name)) continue
      const path = join(folder, name)
      if ((await stat(path)).isDirectory()) await walk(path, `${prefix}${name}/`)
      else out.set(`${prefix}${name}`, await readFile(path, 'utf8'))
    }
  }
  await walk(root, '')
  return out
}
function folders(docs: Map<string, string>): string[] {
  return [...new Set([...docs.keys()].filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/'))))].sort()
}

async function session(seed: number, rounds: number): Promise<void> {
  const rand = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
  const chance = (p: number): boolean => rand() < p
  const f: Fixture = await fixture()
  const log: string[] = []
  let round = 0
  let counter = 0
  const root = (mac: Mac): string => (mac === 'A' ? f.av : f.bv)
  const now = soakClock()
  const engines = REAL_SCANNER ? { A: f.engineA({ now }), B: f.engineB({ now }) } : { A: f.engineA({ scanner: cleanScanner, now }), B: f.engineB({ scanner: cleanScanner, now }) }
  const engine = (mac: Mac) => engines[mac]
  /** Writing that must still exist somewhere. Each save is unique text. An edit or delete at a path retires the text it
   *  replaced only when no copy of it is left at another path on either Mac: a renamed copy or a kept-both copy is a
   *  separate document its writer never superseded. A rename registers the moved text again for the same reason. */
  const live = new Set<string>(['The initial draft.\n', 'The second document.\n'])
  let remoteTip = f.git(f.remote, 'rev-parse', 'main')

  const fail = (what: string): never => {
    throw new SoakFailure(`Git sync soak failed: ${what}\n  seed ${seed}, round ${round}\n  replay: ${REAL_SCANNER ? 'WF_SOAK_GITLEAKS=1 ' : ''}WRITEFLEX_EXTENDED_TESTS=1 WF_SOAK_SEED=${seed} WF_SOAK_ROUNDS=${round} bun test tests/main/git-vault-sync-soak.test.ts\n  operations:\n    ${log.join('\n    ')}`)
  }
  const fresh = (mac: Mac, path: string): string => `Mac ${mac} wrote save ${++counter} at ${path} (seed ${seed}).\n`
  const put = async (mac: Mac, path: string, text: string): Promise<void> => {
    await mkdir(dirname(join(root(mac), path)), { recursive: true })
    await writeFile(join(root(mac), path), text)
  }

  // ── operations on one Mac's vault ──────────────────────────────────────────
  async function retire(text: string, path: string): Promise<void> {
    const copies = [...(await documents(f.av)), ...(await documents(f.bv))]
    if (!copies.some(([other, t]) => t === text && other !== path)) live.delete(text)
  }
  async function edit(mac: Mac, path: string): Promise<void> {
    const before = (await documents(root(mac))).get(path)
    if (before !== undefined) await retire(before, path)
    const text = fresh(mac, path)
    await put(mac, path, text); live.add(text); log.push(`${mac} edit ${path}`)
  }
  async function create(mac: Mac, path: string): Promise<void> {
    const text = fresh(mac, path)
    await put(mac, path, text); live.add(text); log.push(`${mac} create ${path}`)
  }
  async function remove(mac: Mac, path: string): Promise<void> {
    const before = (await documents(root(mac))).get(path)
    if (before === undefined) return
    await retire(before, path)
    await rm(join(root(mac), path)); log.push(`${mac} delete ${path}`)
  }
  async function move(mac: Mac, from: string, to: string): Promise<void> {
    const docs = await documents(root(mac))
    if (!docs.has(from) || docs.has(to)) return
    live.add(docs.get(from)!)
    await mkdir(dirname(join(root(mac), to)), { recursive: true })
    await rename(join(root(mac), from), join(root(mac), to)); log.push(`${mac} rename ${from} -> ${to}`)
  }
  async function moveFolder(mac: Mac, from: string, to: string): Promise<void> {
    const docs = await documents(root(mac))
    if (!folders(docs).includes(from) || [...docs.keys()].some((p) => p.startsWith(`${to}/`))) return
    for (const [path, text] of docs) if (path.startsWith(`${from}/`)) live.add(text)
    await mkdir(dirname(join(root(mac), to)), { recursive: true })
    await rename(join(root(mac), from), join(root(mac), to)); log.push(`${mac} rename folder ${from} -> ${to}`)
  }
  async function machineLocal(mac: Mac): Promise<void> {
    const n = ++counter
    const path = pick([`.writeflex/widget-step-${n}.json`, `.writeflex/inbox/${n}.json.taken`, `.writeflex/cache-${n}.tmp`, `.writeflex/write-${n}.lock`, `.bridle/objects/tmp-${n}`])
    await put(mac, path, `{"machine":"${mac}","n":${n}}\n`); log.push(`${mac} machine-local ${path}`)
  }
  const newName = (): string => {
    const n = ++counter
    return pick([`doc-${n}.md`, `Chapter ${n}.md`, `notes (${n}).md`])
  }
  const newFolder = (): string => pick(['chapters', 'notes', `part-${++counter}`, `drafts/${`round-${round}`}`])

  async function soloOperation(mac: Mac): Promise<void> {
    const docs = [...(await documents(root(mac))).keys()]
    const kind = docs.length ? pick(['edit', 'edit', 'create', 'delete', 'rename', 'folder-rename', 'machine-local'] as const) : 'create'
    if (kind === 'edit') return edit(mac, pick(docs))
    if (kind === 'create') return create(mac, chance(0.5) ? newName() : `${newFolder()}/${newName()}`)
    if (kind === 'delete') return remove(mac, pick(docs))
    if (kind === 'rename') return move(mac, pick(docs), chance(0.5) ? newName() : `${newFolder()}/${newName()}`)
    if (kind === 'folder-rename') {
      const dirs = folders(await documents(root(mac)))
      return dirs.length ? moveFolder(mac, pick(dirs), `part-${++counter}`) : create(mac, `${newFolder()}/${newName()}`)
    }
    return machineLocal(mac)
  }
  /** One clash between the Macs on a document both hold (or a path neither does yet). */
  async function pairedOperation(): Promise<void> {
    const a = await documents(f.av), b = await documents(f.bv)
    const shared = [...a.keys()].filter((p) => b.has(p))
    const [one, other]: [Mac, Mac] = chance(0.5) ? ['A', 'B'] : ['B', 'A']
    const kind = shared.length ? pick(['edit-both', 'edit-different', 'delete-edit', 'rename-edit', 'folder-rename-edit', 'create-both'] as const) : 'create-both'
    if (kind === 'create-both') { const path = newName(); await create(one, path); await create(other, path); return }
    const path = pick(shared)
    if (kind === 'edit-both') { await edit(one, path); await edit(other, path); return }
    if (kind === 'edit-different') {
      const others = shared.filter((p) => p !== path)
      await edit(one, path)
      if (others.length) await edit(other, pick(others))
      else await create(other, newName()) // only one shared document: the other Mac writes a new one instead
      return
    }
    if (kind === 'delete-edit') { await remove(one, path); await edit(other, path); return }
    if (kind === 'rename-edit') { await move(one, path, newName()); await edit(other, path); return }
    const inFolder = shared.filter((p) => p.includes('/'))
    if (!inFolder.length) { await move(one, path, newName()); await edit(other, path); return }
    const doc = pick(inFolder)
    await moveFolder(one, doc.slice(0, doc.lastIndexOf('/')), `part-${++counter}`)
    await edit(other, doc)
  }

  // ── sync calls and the invariants ──────────────────────────────────────────
  async function check(after: string, deliberate?: GitVaultSyncResult): Promise<void> {
    // 5. never stopped (the soak causes no stop on purpose).
    if (deliberate?.state === 'stopped') fail(`${after} stopped: ${deliberate.reason?.code} — ${deliberate.reason?.message}${deliberate.reason?.document ? ` (${deliberate.reason.document})` : ''}`)
    // 1. no writing lost.
    const everywhere = new Set([...(await documents(f.av)).values(), ...(await documents(f.bv)).values()])
    const lost = [...live].filter((text) => !everywhere.has(text))
    if (lost.length) fail(`${after}: writing lost — ${lost.map((t) => JSON.stringify(t.trim())).join(', ')}`)
    // 3. machine-local files never reach the remote.
    const leaked = f.git(f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter((p) => MACHINE_LOCAL.test(p))
    if (leaked.length) fail(`${after}: machine-local files reached the remote — ${leaked.join(', ')}`)
    // 4. the remote never rewinds.
    const tip = f.git(f.remote, 'rev-parse', 'main')
    if (tip !== remoteTip) {
      try { f.git(f.remote, 'merge-base', '--is-ancestor', remoteTip, tip) } catch { fail(`${after}: remote rewound from ${remoteTip} to ${tip}`) }
      remoteTip = tip
    }
  }
  async function sync(mac: Mac, kind: 'send' | 'receive', unsaved: string[] = []): Promise<void> {
    log.push(`${mac} ${kind}${unsaved.length ? ` (unsaved: ${unsaved.join(', ')})` : ''}`)
    const call = unsaved.length ? { unsavedPaths: unsaved } : undefined
    const held = new Map(await Promise.all(unsaved.map(async (path) => [path, await readFile(join(root(mac), path), 'utf8').catch(() => null)] as const)))
    const result = kind === 'send' ? await engine(mac).send(root(mac), call) : await engine(mac).fetchAndIntegrate(root(mac), call)
    log.push(`  -> ${result.state}${result.pairs.length ? `, ${result.pairs.length} pair(s)` : ''}`)
    await check(`${mac} ${kind}`, result)
    // The caller's unsaved documents: their disk bytes stay exactly as they were (ADR-0055).
    for (const [path, bytes] of held) {
      const after = await readFile(join(root(mac), path), 'utf8').catch(() => null)
      if (after !== bytes) fail(`${mac} ${kind}: unsaved ${path} changed on disk`)
    }
  }
  async function randomSync(): Promise<void> {
    const mac: Mac = chance(0.5) ? 'A' : 'B'
    const docs = [...(await documents(root(mac))).keys()]
    // The writer is typing in a document: the caller names it unsaved, its disk text must stay in place.
    const unsaved = docs.length && chance(0.25) ? [pick(docs)] : []
    await sync(mac, chance(0.5) ? 'send' : 'receive', unsaved)
  }

  try {
    await check('start')
    // One controlled incoming overlap per session, whatever the seed: B is typing in the document A changed.
    log.push('-- overlap')
    await edit('A', 'second.md'); await sync('A', 'send'); await sync('B', 'receive', ['second.md'])
    await sync('B', 'send'); await sync('A', 'receive')
    for (round = 1; round <= rounds; round++) {
      log.push(`-- round ${round}`)
      for (let step = 0; step < STEPS_PER_ROUND; step++) {
        const roll = rand()
        if (roll < 0.25) await pairedOperation()
        else if (roll < 0.6) await soloOperation(chance(0.5) ? 'A' : 'B')
        else await randomSync()
        await check(`round ${round} step ${step + 1}`)
      }
      // 2. settle with no new edits: both Macs hold the same vault documents, byte for byte.
      log.push('-- settle')
      await sync('A', 'send'); await sync('B', 'receive'); await sync('B', 'send'); await sync('A', 'receive')
      const a = await documents(f.av), b = await documents(f.bv)
      const differ = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort()
      if (differ.length) fail(`after settling the Macs differ at ${differ.map((p) => `${p} (A ${a.has(p) ? 'has' : 'lacks'}, B ${b.has(p) ? 'has' : 'lacks'})`).join(', ')}`)
    }
  } catch (error) {
    if (error instanceof SoakFailure) throw error
    fail(`unexpected error — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    await f.close()
  }
}

if (extended) {
  const testSoak = testRequiring(REAL_SCANNER ? missingGitleaks : undefined)
  const sessionTimeout = 60_000 + ROUNDS * 40_000
  for (let s = 0; s < SESSIONS; s++) {
    const seed = SEED + s
    testSoak(`two Macs, seed ${seed}, ${ROUNDS} rounds: no writing lost, convergence, nothing machine-local sent, no rewind, never stopped`, async () => {
      await session(seed, ROUNDS)
    }, sessionTimeout)
  }
}

// Found by the soak (seed 20261121, round 3; reduced by hand). Mac B renames a document while Mac A edits it. ADR-0055:
// a delete/edit clash keeps the edit. On Git 2.39.5 (Apple Git-154, the Mac Studio's /usr/bin/git) `merge-tree
// --write-tree` detects the rename despite `-c merge.renames=false`: A's edit is merged into B's renamed file, the
// keep-this-Mac's-bytes rule then puts B's text back there, the old path stays deleted, and B sends the loss.
// Git 2.54.0 honours the setting and keeps the edit at the old path.
for (const call of ['receive', 'send'] as const) {
  test(`a document renamed on one Mac and edited on the other keeps the edit when the renaming Mac ${call}s`, async () => {
    const f = await fixture()
    const A = f.engineA({ scanner: cleanScanner }), B = f.engineB({ scanner: cleanScanner })
    try {
      await rename(join(f.bv, 'second.md'), join(f.bv, 'moved.md'))
      await writeFile(join(f.av, 'second.md'), 'Mac A edited the second document.\n')
      expect((await A.send(f.av)).state).toBe('up-to-date')
      const result = call === 'receive' ? await B.fetchAndIntegrate(f.bv) : await B.send(f.bv)
      expect(result.state).not.toBe('stopped')
      const b = await documents(f.bv)
      expect([...b.values()]).toContain('Mac A edited the second document.\n')
      expect(b.get('moved.md')).toBe('The second document.\n')
    } finally { await f.close() }
  }, 60_000)
}

// Found by the soak (seed 1, round 4, Git 2.39.5, with the rename fix above applied first; reduced by hand). Mac B
// renames a kept-both copy away while Mac A edits it, and both Macs edit the original again: the new clash's copy
// takes the free name, which is the edited copy's old name. Both the new clash and the edited copy must survive.
test('a new clash copy never takes the name of a kept copy the other Mac edited while this Mac renamed it', async () => {
  const f = await fixture()
  const now = soakClock() // both clashes on one date, so the second clash's first-choice name is the freed one
  const A = f.engineA({ scanner: cleanScanner, now }), B = f.engineB({ scanner: cleanScanner, now })
  try {
    await writeFile(join(f.av, 'draft.md'), 'A first.\n'); await writeFile(join(f.bv, 'draft.md'), 'B first.\n')
    await A.send(f.av); await B.fetchAndIntegrate(f.bv); await B.send(f.bv); await A.fetchAndIntegrate(f.av)
    const copy = [...(await documents(f.bv)).keys()].find((path) => path.startsWith('draft (from Mac A'))!
    expect(copy).toBeDefined()
    await rename(join(f.bv, copy), join(f.bv, 'kept.md'))
    await writeFile(join(f.av, copy), 'A edited the kept copy.\n')
    await writeFile(join(f.av, 'draft.md'), 'A second.\n'); await writeFile(join(f.bv, 'draft.md'), 'B second.\n')
    expect((await A.send(f.av)).state).toBe('up-to-date')
    expect((await B.fetchAndIntegrate(f.bv)).state).not.toBe('stopped')
    const b = [...(await documents(f.bv)).values()]
    for (const text of ['A edited the kept copy.\n', 'A second.\n', 'B second.\n', 'A first.\n']) expect(b).toContain(text)
  } finally { await f.close() }
}, 60_000)

// The caller names a document the writer is typing in: its disk bytes stay, the incoming version goes beside it.
test('an unsaved document keeps its exact disk bytes when the other Mac changed it', async () => {
  const f = await fixture()
  const now = soakClock()
  const A = f.engineA({ scanner: cleanScanner, now }), B = f.engineB({ scanner: cleanScanner, now })
  try {
    const before = await readFile(join(f.bv, 'draft.md'))
    await writeFile(join(f.av, 'draft.md'), 'Mac A changed the draft.\n')
    expect((await A.send(f.av)).state).toBe('up-to-date')
    const result = await B.fetchAndIntegrate(f.bv, { unsavedPaths: ['draft.md'] })
    expect(result.state).toBe('needs-you')
    expect((await readFile(join(f.bv, 'draft.md'))).equals(before)).toBe(true)
    expect(await readFile(join(f.bv, result.pairs[0]!.other), 'utf8')).toBe('Mac A changed the draft.\n')
  } finally { await f.close() }
}, 60_000)
