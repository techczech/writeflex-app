/** Private inherited descriptors; never imported by a renderer or exposed through the helper socket. */
import { fstatSync, lstatSync, realpathSync } from 'node:fs'
import { Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { HostCredentialFactory, RegisteredVault, ProcessLauncher } from '@app-patterns/vault-sync/helper/host'

export const NAMESPACE = 'writeflex.backup.github.v1' as const
export const SNAPSHOT_CAP = 256 * 1024
export const GRANT_CAP = 16 * 1024
export const EXPIRY_MARGIN_MS = 120000
export const MIN_WORK_MS = 90000
export interface AcceptedBinding {
  vaultId: string; realRoot: string; repositoryId: number; installationId: number
  exactRemote: string; credentialPath: string
}
export interface CredentialSnapshot {
  version: 1; namespace: typeof NAMESPACE; installId: string; epoch: number; generation: number
  expiresAt: number; accessToken: string; bindings: readonly AcceptedBinding[]
}
interface Grant extends Omit<CredentialSnapshot, 'bindings'> { protocol: 'https'; host: 'github.com'; path: string }
const denied = () => new Error('GitHub credential bridge refused')
function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw denied()
  const descriptors = Object.getOwnPropertyDescriptors(v)
  if (Reflect.ownKeys(descriptors).length !== keys.length || !keys.every(k => Object.hasOwn(descriptors, k) && Object.hasOwn(descriptors[k]!, 'value'))) throw denied()
  return Object.fromEntries(keys.map(k => [k, descriptors[k]!.value]))
}
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0
const pathPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,104}$/
function identity(v: Record<string, unknown>, now: number): void {
  if (v.version !== 1 || v.namespace !== NAMESPACE || typeof v.installId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.installId) || !positive(v.epoch) || !positive(v.generation) || !positive(v.expiresAt) || v.expiresAt <= now + EXPIRY_MARGIN_MS || typeof v.accessToken !== 'string' || !/^[A-Za-z0-9_.-]{1,8192}$/.test(v.accessToken)) throw denied()
}
const identityKeys = ['version', 'namespace', 'installId', 'epoch', 'generation', 'expiresAt', 'accessToken']
export function validateSnapshot(value: unknown, now = Date.now()): CredentialSnapshot {
  const data = exact(value, [...identityKeys, 'bindings']); identity(data, now)
  if (!Array.isArray(data.bindings) || Object.getPrototypeOf(data.bindings) !== Array.prototype) throw denied()
  const entries = Object.getOwnPropertyDescriptors(data.bindings as object)
  const length = entries.length!.value as number
  if (length > 1000 || Reflect.ownKeys(entries).length !== length + 1) throw denied()
  const ids = new Set<string>()
  const bindings = Array.from({ length }, (_, i) => {
    const entry = entries[String(i)]
    if (!entry || !Object.hasOwn(entry, 'value')) throw denied()
    const b = exact(entry.value, ['vaultId', 'realRoot', 'repositoryId', 'installationId', 'exactRemote', 'credentialPath'])
    if (typeof b.vaultId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(b.vaultId) || ids.has(b.vaultId) || typeof b.realRoot !== 'string' || !isAbsolute(b.realRoot) || /[\0\r\n]/.test(b.realRoot) || b.realRoot.split('/').some(x => x === '.' || x === '..') || !positive(b.repositoryId) || !positive(b.installationId) || typeof b.credentialPath !== 'string' || !pathPattern.test(b.credentialPath) || b.exactRemote !== `https://github.com/${b.credentialPath}`) throw denied()
    ids.add(b.vaultId)
    return Object.freeze({ ...b }) as unknown as AcceptedBinding
  })
  return Object.freeze({ ...data, bindings: Object.freeze(bindings) }) as unknown as CredentialSnapshot
}
export function frame(value: unknown, cap = SNAPSHOT_CAP): Buffer {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length + 4 > cap) throw denied()
  const head = Buffer.alloc(4); head.writeUInt32BE(bytes.length)
  return Buffer.concat([head, bytes])
}
/** Actually interruptible: no readSync, no waiting for EOF on a blocking descriptor. */
export function readBytes(stream: Readable, cap: number, deadlineMs: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let done = false
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      stream.removeListener('data', data); stream.removeListener('end', end)
      stream.removeListener('close', close)
      stream.destroy()
      error ? reject(denied()) : resolve(Buffer.concat(chunks, size))
    }
    const abort = () => finish(denied())
    const data = (b: Buffer) => { size += b.length; if (size > cap) finish(denied()); else chunks.push(b) }
    const end = () => finish()
    const close = () => finish(denied())
    const timer = setTimeout(abort, Math.min(Math.max(deadlineMs, 1), 5000))
    stream.on('data', data); stream.once('end', end); stream.once('error', abort); stream.once('close', close)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
export async function readFrame(stream: Readable, cap: number, deadlineMs: number, signal?: AbortSignal): Promise<unknown> {
  const bytes = await readBytes(stream, cap, deadlineMs, signal)
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== bytes.length - 4) throw denied()
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4))
    const value: unknown = JSON.parse(text)
    // Our writer emits compact JSON. This also rejects duplicate keys and noncanonical encodings.
    if (JSON.stringify(value) !== text) throw denied()
    return value
  } catch { throw denied() }
}
export function privateDescriptor(fd: number): Socket {
  // Node may already have reused a missing descriptor for a file or event handle.
  if (!fstatSync(fd).isSocket()) throw denied()
  return new Socket({ fd, readable: true, writable: false })
}
export function parentLifetime(fd = 4): { signal: AbortSignal; close(): void } {
  const controller = new AbortController()
  const stream = privateDescriptor(fd)
  const abort = () => controller.abort()
  stream.once('end', abort); stream.once('close', abort); stream.once('error', abort)
  // The lifetime channel carries no data. Data is a protocol error, not a keepalive.
  stream.once('data', abort); stream.resume()
  return { signal: controller.signal, close() { controller.abort(); stream.destroy() } }
}
export function credentialAnswer(value: unknown, input: string, now: number, parentAlive: boolean): string {
  value = exact(value, [...identityKeys, 'protocol', 'host', 'path'])
  const data = value as Record<string, unknown>; identity(data, now)
  if (!parentAlive || data.protocol !== 'https' || data.host !== 'github.com' || typeof data.path !== 'string' || !pathPattern.test(data.path) || Buffer.byteLength(input) > GRANT_CAP || !input.endsWith('\n')) throw denied()
  const fields = new Map<string, string>(); let metadata = 0
  for (const line of input.slice(0, input.endsWith('\n\n') ? -2 : -1).split('\n')) {
    const at = line.indexOf('='); if (at <= 0 || /[\0\r]/.test(line)) throw denied()
    const key = line.slice(0, at), text = line.slice(at + 1)
    if (key === 'capability[]' || key === 'wwwauth[]') { if (++metadata > 32 || text.length > 2048) throw denied(); continue }
    if (!['protocol', 'host', 'path', 'username'].includes(key) || fields.has(key)) throw denied()
    fields.set(key, text)
  }
  if (fields.get('protocol') !== 'https' || fields.get('host') !== data.host || fields.get('path') !== data.path || (fields.has('username') && fields.get('username') !== 'x-access-token')) throw denied()
  return `username=x-access-token\npassword=${data.accessToken}\n\n`
}
/** No diagnostics: neither Git's store input nor private frames may appear in an error. */
export async function credentialMode(operation: string): Promise<number> {
  if (!['get', 'store', 'erase'].includes(operation)) return 1
  let lifetime: ReturnType<typeof parentLifetime> | undefined
  try {
    if (operation !== 'get') { await readBytes(process.stdin, GRANT_CAP, 2000); return 0 }
    lifetime = parentLifetime()
    const [value, bytes] = await Promise.all([readFrame(privateDescriptor(3), GRANT_CAP, 2000, lifetime.signal), readBytes(process.stdin, GRANT_CAP, 2000, lifetime.signal)])
    // Let an already queued EOF retire admission before releasing a credential.
    await new Promise<void>(resolve => setImmediate(resolve))
    const answer = credentialAnswer(value, new TextDecoder('utf-8', { fatal: true }).decode(bytes), Date.now(), !lifetime.signal.aborted)
    process.stdout.write(answer)
    return 0
  } catch { return 1 } finally { lifetime?.close() }
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
export function fixedCredentialCommand(executable: string, entry: string): string {
  for (const path of [executable, entry]) if (!isAbsolute(path) || /[\0\r\n]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) throw denied()
  return `!ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(entry)} credential`
}
/** Stock macOS /Applications is root:admin 0775. Only that exact folder may be group-writable; nothing below or above it. */
export function trustedAncestor(path: string, stat: { mode: number; uid: number; gid: number }, uid = process.getuid?.()): boolean {
  if (path === '/Applications' && stat.uid === 0 && stat.gid === 80 && (stat.mode & 0o7777) === 0o775) return true
  return (stat.mode & 0o022) === 0 && (stat.uid === 0 || stat.uid === uid)
}
function trustedSelfPath(path: string, executable: boolean): string {
  const real = realpathSync(path)
  const info = lstatSync(real)
  if (!info.isFile() || (info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid?.()) || (executable && !(info.mode & 0o111))) throw denied()
  // Every ancestor must resist writes by another user.
  let ancestor = real.slice(0, real.lastIndexOf('/')) || '/'
  for (;;) {
    const stat = lstatSync(ancestor)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedAncestor(ancestor, stat)) throw denied()
    if (ancestor === '/') break
    ancestor = ancestor.slice(0, ancestor.lastIndexOf('/')) || '/'
  }
  return real
}
export interface HostBridge { hostCredentials: HostCredentialFactory; signal: AbortSignal; maxRuntimeMs: number; close(): void }
/** Snapshot descriptors are used only when the supervisor explicitly enables this fixed mode. */
export async function receiveHostBridge(executable: string, entry: string): Promise<HostBridge> {
  const lifetime = parentLifetime()
  try {
    const snapshot = validateSnapshot(await readFrame(privateDescriptor(3), SNAPSHOT_CAP, 5000, lifetime.signal))
    const remaining = snapshot.expiresAt - EXPIRY_MARGIN_MS - Date.now()
    if (remaining < MIN_WORK_MS || lifetime.signal.aborted) throw denied()
    const controller = new AbortController()
    const streams = new Set<Writable>()
    const close = () => { controller.abort(); for (const stream of streams) stream.destroy(); streams.clear() }
    lifetime.signal.addEventListener('abort', close, { once: true })
    const timer = setTimeout(close, Math.min(remaining, 6 * 60 * 60000))
    const command = fixedCredentialCommand(trustedSelfPath(executable, true), trustedSelfPath(entry, false))
    const live = () => !controller.signal.aborted && Date.now() + EXPIRY_MARGIN_MS < snapshot.expiresAt
    const hostCredentials: HostCredentialFactory = (vault, launch) => {
      const binding = snapshot.bindings.find(b => b.vaultId === vault.id && b.realRoot === vault.path && b.repositoryId === vault.github?.repositoryId && b.exactRemote.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '').toLowerCase() === vault.github?.repository.toLowerCase())
      const admit = (path: string) => { if (!binding || !live() || path !== binding.credentialPath) throw denied(); return snapshot.accessToken }
      const wrapped: ProcessLauncher = (program, args, options) => {
        // Only the engine's isolated transport commands to this exact accepted URL receive a grant.
        const commandIndex = args.findIndex(x => ['push', 'fetch', 'ls-remote'].includes(x))
        const env = options.env ?? {}
        const transport = commandIndex >= 0 && program.length > 0 && env.GIT_CONFIG_NOSYSTEM === '1' && env.GIT_CONFIG_GLOBAL === '/dev/null' && typeof env.GIT_DIR === 'string' && options.cwd === env.GIT_DIR && typeof env.GIT_OBJECT_DIRECTORY === 'string'
        if (!transport) return launch(program, args, options)
        const urls = args.filter(a => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(a))
        if (urls.every(u => u.startsWith('file://'))) return launch(program, args, options)
        if (!binding || urls.length !== 1 || urls[0] !== binding.exactRemote) throw denied()
        admit(binding.credentialPath)
        const grant: Grant = { version: 1, namespace: snapshot.namespace, installId: snapshot.installId, epoch: snapshot.epoch, generation: snapshot.generation, expiresAt: snapshot.expiresAt, accessToken: snapshot.accessToken, protocol: 'https', host: 'github.com', path: binding.credentialPath }
        const child = launch(program, args, { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
        const secret = child.stdio[3] as Writable | null, life = child.stdio[4] as Writable | null
        if (!secret || !life) { child.kill('SIGTERM'); throw denied() }
        streams.add(secret); streams.add(life)
        secret.on('error', () => undefined); life.on('error', () => undefined)
        secret.end(frame(grant, GRANT_CAP))
        child.once('close', () => { streams.delete(secret); streams.delete(life); secret.destroy(); life.destroy() })
        return child
      }
      return { credential: async ({ path }) => { try { return admit(path) } catch { return null } }, launch: wrapped, helpers: [command], signal: controller.signal }
    }
    return { hostCredentials, signal: controller.signal, maxRuntimeMs: remaining, close() { clearTimeout(timer); close(); lifetime.close() } }
  } catch { lifetime.close(); throw denied() }
}
