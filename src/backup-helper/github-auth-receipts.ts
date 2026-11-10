/** Non-secret, per-child completion proof. Shared only by main and the trusted helper entry. */
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
export const AUTH_NAMESPACE = 'writeflex.backup.github.v1' as const
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export type ExposureIdentity = { version: 1; namespace: typeof AUTH_NAMESPACE; installId: string; session: string; exposure: string; epoch: number; generation: number; nonce: string }
export type CompletionTarget = { directory: string; dev: number; ino: number; identity: ExposureIdentity }
const keys = ['version', 'namespace', 'installId', 'session', 'exposure', 'epoch', 'generation', 'nonce']
export function exactData(v: unknown, names: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(v))) throw Error('GitHub auth data refused')
  const ds = Object.getOwnPropertyDescriptors(v)
  if (Reflect.ownKeys(ds).length !== names.length || !names.every(k => ds[k] && Object.hasOwn(ds[k]!, 'value'))) throw Error('GitHub auth data refused')
  return Object.fromEntries(names.map(k => [k, ds[k]!.value]))
}
export function exposureIdentity(v: unknown): ExposureIdentity {
  const x = exactData(v, keys)
  if (x.version !== 1 || x.namespace !== AUTH_NAMESPACE || !['installId', 'session', 'exposure'].every(k => typeof x[k] === 'string' && UUID.test(x[k] as string)) || !['epoch', 'generation'].every(k => Number.isSafeInteger(x[k]) && (x[k] as number) > 0) || typeof x.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(x.nonce)) throw Error('GitHub auth identity refused')
  return x as unknown as ExposureIdentity
}
export function receiptMatches(value: unknown, identity: ExposureIdentity): boolean {
  try { const actual = exposureIdentity(value); return keys.every(k => actual[k as keyof ExposureIdentity] === identity[k as keyof ExposureIdentity]) } catch { return false }
}
export function privateDirectory(directory: string): { dev: number; ino: number } {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory || basename(directory) !== 'github-auth-receipts' || basename(dirname(directory)) !== 'backup-helper') throw Error('GitHub auth directory refused')
  const st = lstatSync(directory)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) throw Error('GitHub auth directory refused')
  // Reject symlinks at every level; canonical identity alone is insufficient for a replaced ancestor.
  for (let p = directory; p !== '/'; p = dirname(p)) if (lstatSync(p).isSymbolicLink()) throw Error('GitHub auth directory refused')
  return { dev: st.dev, ino: st.ino }
}
export function completionTarget(value: unknown): CompletionTarget {
  const v = exactData(value, ['directory', 'dev', 'ino', 'identity'])
  if (typeof v.directory !== 'string' || v.directory.length > 4096) throw Error('GitHub auth directory refused')
  const st = privateDirectory(v.directory)
  if (v.dev !== st.dev || v.ino !== st.ino) throw Error('GitHub auth directory changed')
  return { directory: v.directory, ...st, identity: exposureIdentity(v.identity) }
}
export function receiptPath(target: CompletionTarget): string { return join(target.directory, `${target.identity.exposure}.json`) }
export function syncDir(directory: string): void { const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
export function readCompletion(raw: CompletionTarget): boolean {
  try {
    const target = completionTarget(raw), path = receiptPath(target)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > 2048) return false
      fsyncSync(fd)
      const text = readFileSync(fd, 'utf8'), v: unknown = JSON.parse(text)
      if (JSON.stringify(v) !== text || !receiptMatches(v, target.identity)) return false
      syncDir(target.directory)
      return true
    } finally { closeSync(fd) }
  } catch { return false }
}
export function writeCompletion(raw: CompletionTarget): void {
  const target = completionTarget(raw), final = receiptPath(target)
  const temp = join(target.directory, `.${target.identity.exposure}.${randomBytes(16).toString('hex')}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { writeFileSync(fd, JSON.stringify(target.identity)); fsyncSync(fd) } finally { closeSync(fd) }
    completionTarget(target)
    // link is atomic and exclusive, unlike rename over an unrelated destination.
    linkSync(temp, final)
    unlinkSync(temp)
    syncDir(target.directory)
    if (!readCompletion(target)) throw Error('GitHub completion not durable')
  } finally { try { unlinkSync(temp) } catch { /* exact own temporary only */ } }
}
export function removeCompletion(target: CompletionTarget): void {
  if (!readCompletion(target)) return
  unlinkSync(receiptPath(target)); syncDir(target.directory)
}
export function makeReceiptDirectory(authDir: string): string {
  mkdirSync(authDir, { recursive: true, mode: 0o700 })
  if (realpathSync(authDir) !== authDir || lstatSync(authDir).isSymbolicLink() || lstatSync(authDir).uid !== process.getuid?.() || (lstatSync(authDir).mode & 0o022)) throw Error('GitHub auth directory refused')
  const directory = join(authDir, 'github-auth-receipts')
  mkdirSync(directory, { mode: 0o700, recursive: true }); privateDirectory(directory); syncDir(dirname(directory))
  return directory
}
