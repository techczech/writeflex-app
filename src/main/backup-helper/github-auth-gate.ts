/** Durable admission debt: a fresh process registry cannot discharge predecessor exposure. */
import { randomBytes, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { writeFileDurable } from './durable-file'
import { AUTH_NAMESPACE, UUID, exactData, exposureIdentity, makeReceiptDirectory, privateDirectory, readCompletion, removeCompletion, type CompletionTarget, type ExposureIdentity } from '../../backup-helper/github-auth-receipts'
export type AuthPhase = 'active' | 'refresh-pending' | 'disconnecting' | 'disconnected' | 'reauth-required'
type Gate = { version: 1; namespace: typeof AUTH_NAMESPACE; installId: string; epoch: number; generation: number; phase: AuthPhase; debt: ExposureIdentity[] }
export function createAuthGate(userData: string, seams: { checkpoint?: (step: string) => void | Promise<void> } = {}) {
  const session = randomUUID()
  let damaged = false, directory = join(userData, 'backup-helper', 'github-auth-receipts')
  try { directory = makeReceiptDirectory(join(realpathSync(userData), 'backup-helper')) } catch { damaged = true }
  const path = join(dirname(directory), 'github-auth-gate.json')
  let gate: Gate | null = null, sealed = true
  let lane: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = lane.then(fn); lane = p.catch(() => undefined); return p }
  const target = (identity: ExposureIdentity): CompletionTarget => ({ directory, ...privateDirectory(directory), identity })
  async function persist(next: Gate, admit = () => true) {
    try {
      await seams.checkpoint?.('before-write')
      await writeFileDurable(path, JSON.stringify(next), admit)
      await seams.checkpoint?.('before-readback')
      const read = await readGate()
      if (JSON.stringify(read) !== JSON.stringify(next)) throw Error('GitHub gate readback refused')
      gate = next
    } catch { sealed = true; throw Error('GitHub auth gate outcome uncertain') }
  }
  async function readGate(): Promise<Gate> {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = await fd.stat()
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 256 * 1024) throw Error('GitHub gate refused')
      const text = await fd.readFile('utf8'), parsed: unknown = JSON.parse(text)
      if (JSON.stringify(parsed) !== text) throw Error('GitHub gate refused')
      const v = exactData(parsed, ['version', 'namespace', 'installId', 'epoch', 'generation', 'phase', 'debt'])
      if (v.version !== 1 || v.namespace !== AUTH_NAMESPACE || typeof v.installId !== 'string' || !UUID.test(v.installId) || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 0 || !Number.isSafeInteger(v.generation) || (v.generation as number) < 0 || !['active', 'refresh-pending', 'disconnecting', 'disconnected', 'reauth-required'].includes(v.phase as string) || !Array.isArray(v.debt) || v.debt.length > 128) throw Error('GitHub gate refused')
      const debt = v.debt.map(exposureIdentity)
      if (new Set(debt.map(d => d.exposure)).size !== debt.length || debt.some(d => d.installId !== v.installId)) throw Error('GitHub gate refused')
      return { ...v, debt } as Gate
    } finally { await fd.close() }
  }
  const api = {
    async load() {
      sealed = true
      if (damaged) return
      try { gate = await readGate() }
      catch (e) {
        try { await lstat(path); damaged = true; return } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') { damaged = true; return } }
        gate = { version: 1, namespace: AUTH_NAMESPACE, installId: randomUUID(), epoch: 0, generation: 0, phase: 'disconnected', debt: [] }
        await persist(gate)
      }
      await api.reconcile()
      sealed = damaged || gate?.phase !== 'active' || !!gate?.debt.length
    },
    state: () => gate ? structuredClone(gate) : null,
    damaged: () => damaged,
    debts: () => gate ? structuredClone(gate.debt) : [],
    seal() { sealed = true },
    admitted(epoch: number, generation: number) { return !damaged && !sealed && gate?.phase === 'active' && gate.epoch === epoch && gate.generation === generation && gate.debt.every(d => d.session === session) },
    activate(epoch: number, generation: number, admit = () => true) { return serial(async () => {
      sealed = true
      if (damaged || !gate || gate.debt.length || epoch < gate.epoch || generation < gate.generation || !admit()) throw Error('GitHub auth held')
      await persist({ ...gate, epoch, generation, phase: 'active' }, admit)
      if (admit()) sealed = false
    }) },
    phase(phase: AuthPhase, epoch: number, generation: number, admit = () => true) { if (admit()) sealed = true; return serial(async () => {
      if (damaged || !gate || epoch < gate.epoch || !admit()) throw Error('GitHub auth held')
      await persist({ ...gate, phase, epoch, generation }, admit)
    }) },
    reserve(epoch: number, generation: number): CompletionTarget {
      if (!api.admitted(epoch, generation) || !gate || gate.debt.length >= 128) throw Error('GitHub credential admission held')
      return target({ version: 1, namespace: AUTH_NAMESPACE, installId: gate.installId, session, exposure: randomUUID(), epoch, generation, nonce: randomBytes(32).toString('hex') })
    },
    expose(reservation: CompletionTarget) { return serial(async () => {
      const d = exposureIdentity(reservation.identity)
      if (!api.admitted(d.epoch, d.generation) || !gate || d.session !== session || d.installId !== gate.installId || gate.debt.length >= 128 || gate.debt.some(x => x.exposure === d.exposure)) throw Error('GitHub credential admission held')
      await persist({ ...gate, debt: [...gate.debt, d] }, () => api.admitted(d.epoch, d.generation))
    }) },
    reconcile() { return serial(async () => {
      if (!gate || damaged) return false
      const done = gate.debt.filter(d => readCompletion(target(d)))
      if (done.length) {
        await persist({ ...gate, debt: gate.debt.filter(d => !done.includes(d)) })
        for (const d of done) { try { removeCompletion(target(d)) } catch { /* gate is already durable; leftover harmless */ } }
      }
      return gate.debt.length === 0
    }) },
    originalDrain(confirmed: boolean) { return serial(async () => {
      if (!sealed || !confirmed || !gate || damaged) return false
      await persist({ ...gate, debt: gate.debt.filter(d => d.session !== session) })
      return gate.debt.length === 0
    }) },
  }
  return api
}
export type AuthGate = ReturnType<typeof createAuthGate>
