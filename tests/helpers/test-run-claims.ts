import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const RUN_ROOT = 'WRITEFLEX_TEST_RUN_ROOT'
export const RUN_ID = 'WRITEFLEX_TEST_RUN_ID'
export interface RunIdentity { root: string; id: string; dev: number; ino: number; storeDev: number; storeIno: number }
export interface ClaimAdmission { binary: string; main: string; userData: string; temporaryRoot: string; roots: string[] }
export interface DurableClaim { run: RunIdentity; id: string }
type RunRecord = RunIdentity & { version: 1; phase: 'open' | 'closing'; claims: string[] }
type Record = ClaimAdmission & { version: 1; runId: string; id: string; worker: { pid: number; instance: string }; status: 'armed' | 'launching' | 'captured' | 'failed' | 'released'; pid: number | null }
const workerInstance = randomUUID()
const canonicalPath = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && isAbsolute(value) && resolve(value) === value
const positivePid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const store = (run: RunIdentity) => join(run.root, '.wf-claims')
const contains = (root: string, path: string) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)) }
const refused = (root: string, reason: unknown): never => { throw new Error(`WriteFlex test root retained: ${root}; ${String(reason)}`) }
function json(path: string): any {
  const s = lstatSync(path)
  if (!s.isFile() || s.isSymbolicLink() || s.size > 65536 || !(s.mode & 0o400)) throw Error('unreadable or invalid claim record')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return JSON.parse(readFileSync(fd, 'utf8')) } finally { closeSync(fd) }
}
function publish(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.pending`
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, path)
  const dir = openSync(dirname(path), constants.O_RDONLY)
  try { fsyncSync(dir) } finally { closeSync(dir) }
}
function validate(run: RunIdentity): RunRecord {
  if (dirname(run.root) !== '/private/tmp' || !/^[a-zA-Z0-9]{6}$/.test(run.root.split('/').at(-1)!) || realpathSync(run.root) !== run.root) throw Error('nonphysical run root')
  const s = lstatSync(run.root), d = lstatSync(store(run))
  if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== run.dev || s.ino !== run.ino || !d.isDirectory() || d.isSymbolicLink() || d.dev !== run.storeDev || d.ino !== run.storeIno) throw Error('run identity changed')
  const r = json(join(store(run), 'run.json')) as RunRecord
  if (r.version !== 1 || r.root !== run.root || r.id !== run.id || r.dev !== run.dev || r.ino !== run.ino || r.storeDev !== run.storeDev || r.storeIno !== run.storeIno || !['open', 'closing'].includes(r.phase) || !Array.isArray(r.claims) || !r.claims.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) || new Set(r.claims).size !== r.claims.length) throw Error('missing or malformed run identity')
  return r
}
function locked<T>(run: RunIdentity, action: (record: RunRecord) => T): T {
  let acquired = false
  try {
    validate(run); mkdirSync(join(store(run), '.lock'), { mode: 0o700 }); acquired = true
    return action(validate(run))
  } catch (e) { return refused(run.root, e) }
  finally { if (acquired) { try { rmdirSync(join(store(run), '.lock')) } catch { /* A successfully deleted root has no lock. */ } } }
}
export function createE2ERunIdentity(): RunIdentity {
  let root = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    root = join('/private/tmp', randomBytes(3).toString('hex'))
    try { mkdirSync(root, { mode: 0o700 }); break } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 7) throw e }
  }
  const s = lstatSync(root); mkdirSync(join(root, '.wf-claims'), { mode: 0o700 }); const d = lstatSync(join(root, '.wf-claims'))
  const run: RunIdentity = { root, id: randomUUID(), dev: s.dev, ino: s.ino, storeDev: d.dev, storeIno: d.ino }
  try { publish(join(store(run), 'run.json'), { ...run, version: 1, phase: 'open', claims: [] }) }
  catch (e) { return refused(root, e) }
  return run
}
export function configuredTestRun(required = false): RunIdentity | undefined {
  const root = process.env[RUN_ROOT], id = process.env[RUN_ID]
  if (!root && !id && !required) return undefined
  try {
    if (!root || !id) throw Error('missing claims environment')
    const run = json(join(root, '.wf-claims/run.json')) as RunIdentity
    if (run.root !== root || run.id !== id || ['TMPDIR', 'TEMP', 'TMP'].some(k => process.env[k] !== root)) throw Error('claims environment mismatch')
    validate(run); return { root: run.root, id: run.id, dev: run.dev, ino: run.ino, storeDev: run.storeDev, storeIno: run.storeIno }
  } catch (e) { return refused(root ?? '(missing run root)', e) }
}
function checkAdmission(run: RunIdentity, admission: ClaimAdmission): void {
  if (admission.temporaryRoot !== run.root || ![admission.binary, admission.main].every(canonicalPath) || !Array.isArray(admission.roots) || !admission.roots.includes(admission.userData)) throw Error('claim admission mismatch')
  for (const path of [admission.userData, ...admission.roots]) {
    if (!isAbsolute(path) || resolve(path) !== path || path === run.root || !contains(run.root, path) || contains(store(run), path) || realpathSync(path) !== path) throw Error('claim root escape or symlink')
  }
}
function claims(run: RunIdentity, record: RunRecord): Record[] {
  const entries = readdirSync(store(run)).filter(n => n !== 'run.json' && n !== '.lock').sort()
  if (JSON.stringify(entries) !== JSON.stringify([...record.claims].sort())) throw Error('missing, inflight or unregistered claim')
  return record.claims.map(id => {
    const dir = join(store(run), id), s = lstatSync(dir)
    if (!s.isDirectory() || s.isSymbolicLink() || JSON.stringify(readdirSync(dir)) !== '["claim.json"]') throw Error('incomplete claim directory')
    const c = json(join(dir, 'claim.json')) as Record
    if (c.version !== 1 || c.runId !== run.id || c.id !== id || !c.worker || !Number.isSafeInteger(c.worker.pid) || c.worker.pid <= 0 || typeof c.worker.instance !== 'string' || !['armed', 'launching', 'captured', 'failed', 'released'].includes(c.status) || !(c.pid === null || Number.isSafeInteger(c.pid) && c.pid > 0)) throw Error('malformed claim')
    if (![c.binary, c.main].every(canonicalPath) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.worker.instance) || (c.status === 'released' && !positivePid(c.pid))) throw Error('malformed claim identity')
    // Released roots may already have been individually removed; validate their lexical ownership.
    if (c.temporaryRoot !== run.root || !Array.isArray(c.roots) || !c.roots.includes(c.userData) || c.roots.some(p => typeof p !== 'string' || resolve(p) !== p || p === run.root || !contains(run.root, p) || contains(store(run), p))) throw Error('malformed claimed paths')
    return c
  })
}
export function armTestRunClaim(admission: ClaimAdmission): DurableClaim | undefined {
  const run = configuredTestRun(); if (!run) return undefined
  return locked(run, record => {
    if (record.phase !== 'open') throw Error('global cleanup already started')
    checkAdmission(run, admission); claims(run, record)
    const id = randomUUID(); record.claims.push(id)
    // Publish the expected ID first: interruption before record completion remains fail-closed.
    publish(join(store(run), 'run.json'), record)
    mkdirSync(join(store(run), id), { mode: 0o700 })
    publish(join(store(run), id, 'claim.json'), { ...admission, version: 1, runId: run.id, id, worker: { pid: process.pid, instance: workerInstance }, status: 'armed', pid: null })
    return { run, id }
  })
}
export function updateTestRunClaim(claim: DurableClaim | undefined, status: Record['status'], pid?: number): void {
  if (!claim) return
  locked(claim.run, record => {
    if (record.phase !== 'open') throw Error('global cleanup already started')
    const c = claims(claim.run, record).find(c => c.id === claim.id)
    if (!c || c.worker.pid !== process.pid || c.worker.instance !== workerInstance || c.status === 'failed' || c.status === 'released') throw Error('terminal or foreign claim')
    const nextPid = pid ?? c.pid
    if (status === 'released' && (c.status !== 'captured' || !positivePid(nextPid))) throw Error('normal closure requires captured child with a positive PID')
    publish(join(store(claim.run), claim.id, 'claim.json'), { ...c, status, pid: nextPid })
  })
}
function assertReleased(run: RunIdentity, record: RunRecord, path?: string): void {
  if (claims(run, record).some(c => c.status !== 'released' && (!path || c.roots.some(root => contains(path, root) || contains(root, path))))) throw Error('unreleased worker claims')
}
/** Serialise cross-worker admission with the actual synchronous fixture deletion. */
export function withTestClaimCleanup<T>(path: string, remove: () => T): T {
  const run = configuredTestRun(); if (!run) return remove()
  return locked(run, record => {
    if (path === run.root || !contains(run.root, path) || contains(store(run), path) || realpathSync(path) !== path) throw Error('fixture cleanup root escape')
    assertReleased(run, record, path); return remove()
  })
}
export function finishE2ERun(run: RunIdentity, remove: () => void): void {
  locked(run, record => {
    record.phase = 'closing'; publish(join(store(run), 'run.json'), record)
    assertReleased(run, record); remove()
  })
}
