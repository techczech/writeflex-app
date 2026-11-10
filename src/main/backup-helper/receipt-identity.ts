/**
 * Who this app process is on the receipts lane (locked plan §3).
 *
 * - `clientId`: 32 lowercase hex, minted once per userData and kept in `backup-receipts/client.json`.
 *   It names this app's receipt stream in every vault; it is not a capability.
 * - `clientEpoch`: a counter in the same file, raised and made durable (file and folder synced) at every
 *   process start, before any receipts connection is made. The helper uses it only to fence requests.
 * - `writer`: the physical process that may hold a document's descriptor open: host, pid, the start time
 *   the process table gives for this pid (the same `ps` routine as local-process.ts) and the epoch.
 *   When the start time cannot be read there is no writer identity, and without one main never starts a
 *   non-atomic write (it holds the bytes instead, §10.4).
 *
 * A file that cannot be read or does not parse is never replaced: minting a new clientId would orphan the
 * debt the old stream holds. The caller then runs without receipts (coverage unknown).
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { WriterIncarnation } from '@app-patterns/vault-sync'
import { ensurePrivateDir, writeFileDurable } from './durable-file'

export type ClientIdentity = { clientId: string; clientEpoch: number }

export class ReceiptIdentityError extends Error {
  override readonly name = 'ReceiptIdentityError'
}

const HEX32 = /^[0-9a-f]{32}$/
const FILE = 'client.json'

export const randomHex32 = (): string => randomBytes(16).toString('hex')

function parse(text: string): ClientIdentity {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new ReceiptIdentityError('the receipt client file is not JSON') }
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ReceiptIdentityError('the receipt client file is not an object')
  const keys = Object.keys(v).sort().join(',')
  if (keys !== 'clientId,epoch,v' || v.v !== 1 || typeof v.clientId !== 'string' || !HEX32.test(v.clientId)
    || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 1) {
    throw new ReceiptIdentityError('the receipt client file does not hold a client id and epoch')
  }
  return { clientId: v.clientId, clientEpoch: v.epoch as number }
}

/** Loads (or mints) this userData's client id and makes the next epoch durable before returning it. */
export async function nextClientIdentity(dir: string, mint: () => string = randomHex32): Promise<ClientIdentity> {
  await ensurePrivateDir(dir)
  const file = join(dir, FILE)
  let previous: ClientIdentity | null = null
  try {
    previous = parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof ReceiptIdentityError) throw error
      throw new ReceiptIdentityError(`the receipt client file could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`)
    }
  }
  const clientId = previous?.clientId ?? mint()
  if (!HEX32.test(clientId)) throw new ReceiptIdentityError('a minted client id is not 32 lowercase hex')
  const clientEpoch = (previous?.clientEpoch ?? 0) + 1
  if (!Number.isSafeInteger(clientEpoch)) throw new ReceiptIdentityError('the client epoch is exhausted')
  await writeFileDurable(file, `${JSON.stringify({ v: 1, clientId, epoch: clientEpoch })}\n`)
  return { clientId, clientEpoch }
}

export type WriterDeps = { host?: string; pid?: number; startTime: (pid: number) => Promise<number | null> }

/** This process's writer incarnation, or null when its start time cannot be established. */
export async function writerIncarnation(clientEpoch: number, deps: WriterDeps): Promise<WriterIncarnation | null> {
  const host = deps.host ?? hostname()
  const pid = deps.pid ?? process.pid
  let startedAt: number | null
  try { startedAt = await deps.startTime(pid) } catch { startedAt = null }
  if (startedAt === null || !Number.isSafeInteger(startedAt) || startedAt < 0) return null
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || !Number.isSafeInteger(pid) || pid < 1) return null
  return { host, pid, startedAt, clientEpoch }
}
