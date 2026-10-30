/**
 * Shared harness for the Folio bin's write-path tests (tests/main/folio-bin-pin-rule.test.ts,
 * tests/main/folio-bin-copy-fallback.test.ts): a fresh Folio brought to the point just before each bin operation,
 * trees with permissions, folder swaps, call watching, and hard links made to fail with a fallback code so the
 * exclusive-copy path runs (Sol review r4).
 */
import { expect } from 'bun:test'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { copyFileSync, fchmodSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { readFolioPlan } from '../../src/main/plan'
import { writeRoomAuthoring, type RoomAuthoringOptions } from '../../src/main/folio-room-authoring'
import { BIN_INDEX, FOLIO_BIN, forgetBinUndoRecords, readFolioBin, setBinAwaitHookForTest, setBinIoForTest } from '../../src/main/folio-bin'
import type { RoomAuthoringResult } from '../../src/shared/folio-room-authoring'
import { pangramFolio } from '../fixtures/folio-room/folio-room-fixtures'

const made: string[] = []
/** Put the bin's real calls and awaits back, forget its Undo records, remove every temporary folder made. For `afterEach`. */
export async function cleanUpBinTests(): Promise<void> {
  setBinIoForTest(null)
  setBinAwaitHookForTest(null)
  forgetBinUndoRecords()
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
}
export const tempDir = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `wf-folio-pin-${label}-`))
  made.push(dir)
  return dir
}
export const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)
export const ok = (answer: RoomAuthoringResult): Extract<RoomAuthoringResult, { ok: true }> => {
  if (!answer.ok) throw new Error(`refused: ${answer.message}`)
  return answer
}

/** Every file under `dir` (hidden ones included; the Plan's kept backups left out), path → bytes and permissions. */
export async function treeWithModes(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (!entry.name.endsWith('.writeflex-backup') && !entry.name.endsWith('.writeflex-backup.json')) out.set(relative(dir, full), `${((await lstat(full)).mode & 0o7777).toString(8)} ${(await readFile(full)).toString('base64')}`)
    }
  }
  await walk(dir)
  return out
}

/**
 * `treeWithModes`, with the bin list's per-run fields (each item's random id and removal time) blanked, so two runs
 * of the same operation in two Folios compare byte for byte otherwise.
 */
export async function comparableTree(dir: string): Promise<Map<string, string>> {
  const out = await treeWithModes(dir)
  for (const [path, value] of out) {
    if (!path.endsWith(BIN_INDEX)) continue
    const [mode, base64] = value.split(' ')
    const text = Buffer.from(base64!, 'base64').toString('utf8').replace(/"id": "[^"]*"/g, '"id": "-"').replace(/"removedAt": "[^"]*"/g, '"removedAt": "-"')
    out.set(path, `${mode} ${text}`)
  }
  return out
}

/** The inodes of every file under `dir`. */
export async function inodes(dir: string): Promise<Set<number>> {
  const out = new Set<number>()
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.add((await lstat(full)).ino)
    }
  }
  await walk(dir)
  return out
}

export type Op = 'remove' | 'restore' | 'undo-remove' | 'undo-restore'
export const OPS: Op[] = ['remove', 'restore', 'undo-remove', 'undo-restore']

export type Prepared = {
  folio: string
  run: (options?: RoomAuthoringOptions) => Promise<RoomAuthoringResult>
  undo: (token: string) => Promise<RoomAuthoringResult>
}

/** A fresh Folio in `base`, brought to the point just before `op` (the binned file made executable), and `op` itself. */
export async function prepare(op: Op, base: string): Promise<Prepared> {
  const built = await pangramFolio(base)
  const fws = new FolioWorkspace(new Workspace(base), built.dir)
  const folio = join(base, built.dir)
  const undo = (token: string): Promise<RoomAuthoringResult> => writeRoomAuthoring(fws, { op: 'undo', token })
  const plan = (await readFolioPlan(fws, built.dir))!
  if (op === 'remove') return { folio, undo, run: (options) => writeRoomAuthoring(fws, { op: 'remove', indices: [0, 1], expected: plan.parts }, options) }
  const removed = ok(await writeRoomAuthoring(fws, { op: 'remove', indices: [1], expected: plan.parts }))
  await chmod(join(folio, FOLIO_BIN, '02-report.md'), 0o755)
  if (op === 'undo-remove') return { folio, undo, run: (options) => writeRoomAuthoring(fws, { op: 'undo', token: removed.token! }, options) }
  const item = readFolioBin({ root: base }, built.dir).items[0]
  if (op === 'restore') return { folio, undo, run: (options) => writeRoomAuthoring(fws, { op: 'restore', id: item.id }, options) }
  const restored = ok(await writeRoomAuthoring(fws, { op: 'restore', id: item.id }))
  return { folio, undo, run: (options) => writeRoomAuthoring(fws, { op: 'undo', token: restored.token! }, options) }
}

/** Run `op` with `point` called at every await: the module's own (its test hook) and the Plan's history checkpoints. */
export function runWithPoints(run: (options?: RoomAuthoringOptions) => Promise<RoomAuthoringResult>, point: (label: string) => Promise<void>): Promise<RoomAuthoringResult> {
  setBinAwaitHookForTest(point)
  return run({ beforeIndexWrite: () => point('plan:index-checkpoint'), beforeManifestWrite: () => point('plan:manifest-checkpoint') })
}

/**
 * Swap `target` (a folder of the Folio, or where the bin goes) for a link to a folder outside holding the same names
 * with the same bytes, made executable: the strongest stand-in (every byte check passes). Answers the put-back.
 */
export async function swapOut(target: string, outside: string, n: number): Promise<() => Promise<void>> {
  const evil = join(outside, `evil-${n}`)
  const held = join(outside, `held-${n}`)
  await mkdir(evil)
  const present = await exists(target)
  if (present) {
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      await copyFile(join(target, entry.name), join(evil, entry.name))
      await chmod(join(evil, entry.name), 0o755)
    }
    await rename(target, held)
  } else {
    await writeFile(join(evil, '02-report.md'), 'OUTSIDE\n')
    await chmod(join(evil, '02-report.md'), 0o755)
  }
  await symlink(evil, target)
  let back = false
  return async () => {
    if (back) return
    back = true
    await unlink(target)
    if (present) await rename(held, target)
  }
}

/** The codes a file system answers link(2) with where hard links are not supported, each making the bin copy instead. */
export const LINK_FALLBACK_CODES = ['ENOTSUP', 'EXDEV', 'EPERM'] as const
export type LinkFallback = typeof LINK_FALLBACK_CODES[number] | null

/** A `linkSync` that refuses with `code` (no file made), as a file system without hard links does. */
export const refusingLink = (code: string) => ((from: string, to: string) => {
  throw Object.assign(new Error(`${code}: operation not supported, link '${from}' -> '${to}'`), { code, syscall: 'link' })
}) as never

/** Watch every file-system call of the bin: each must land in the Folio's real folder, and no handle may be a file outside. `noLinks`: link(2) refuses with that code. */
export function watchCalls(folioReal: string, outsideInodes: () => Set<number>, violations: string[], noLinks: LinkFallback = null): void {
  const within = (path: unknown): boolean => {
    if (typeof path !== 'string') return true
    let parent: string
    try { parent = realpathSync(dirname(path)) } catch { return true /* no such folder: the call itself fails */ }
    return parent === folioReal || parent.startsWith(`${folioReal}/`)
  }
  const check = (call: string, ...paths: unknown[]): void => { for (const path of paths) if (!within(path)) violations.push(`${call} ${String(path)}`) }
  const outsideFd = (call: string, fd: number): void => { if (outsideInodes().has(fstatSync(fd).ino)) violations.push(`${call} on a file outside the Folio`) }
  setBinIoForTest({
    openSync: ((path: string, flags: number) => { check('open', path); const fd = openSync(path, flags); outsideFd('open', fd); return fd }) as never,
    readFileSync: ((path: string | number, options?: never) => { check('read', path); return readFileSync(path, options) }) as never,
    writeFileSync: ((path: string, data: string, options: never) => { check('write', path); return writeFileSync(path, data, options) }) as never,
    linkSync: ((from: string, to: string) => { check('link', from, to); if (noLinks) (refusingLink(noLinks) as (a: string, b: string) => never)(from, to); return linkSync(from, to) }) as never,
    copyFileSync: ((from: string, to: string, mode: number) => { check('copy', from, to); return copyFileSync(from, to, mode) }) as never,
    renameSync: ((from: string, to: string) => { check('rename', from, to); return renameSync(from, to) }) as never,
    unlinkSync: ((path: string) => { check('unlink', path); return unlinkSync(path) }) as never,
    fchmodSync: ((fd: number, mode: number) => { outsideFd('fchmod', fd); return fchmodSync(fd, mode) }) as never,
    mkdirSync: ((path: string) => { check('mkdir', path); return mkdirSync(path) }) as never,
    rmdirSync: ((path: string) => { check('rmdir', path); return rmdirSync(path) }) as never,
  })
}

/** Fail with `where` in the message when `actual` is not `expected` (a sweep names its case). */
export function expectAt<T>(where: string, actual: T, expected: T): void {
  expect({ where, actual }).toEqual({ where, actual: expected })
}
