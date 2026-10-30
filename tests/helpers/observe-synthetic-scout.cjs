// Opt-in diagnostic preload (bun test --preload ./tests/helpers/observe-synthetic-scout.cjs).
// Observes ONLY child_process.execFile calls whose binary is a synthetic wf-exec-scout fixture and
// delegates every call unchanged. Logs bounded JSON lines on stderr prefixed [scout-diagnostic]:
// never raw stdout, stderr, stdin, arguments or environment. Observing can shift timing; an observed
// pass is diagnosis, not acceptance of any fix.
const cp = require('node:child_process')
const fs = require('node:fs')
const crypto = require('node:crypto')
const util = require('node:util')

const FAKE = /\/wf-exec-scout-[^/]+\/scout$/
const original = cp.execFile
const started = process.hrtime.bigint()
let sequence = 0
let observed = 0

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)
const bound = (value, max = 160) => (value == null ? null : String(value).split('\n')[0].slice(0, max))

function log(stage, fields) {
  try {
    const line = JSON.stringify({ stage, seq: ++sequence, ns: String(process.hrtime.bigint() - started), pid: process.pid, ...fields })
    fs.writeSync(2, `[scout-diagnostic] ${line}\n`)
  } catch { /* best effort: logging never reaches the observed call */ }
}

function errorFields(error) {
  if (!error) return { error: false }
  return { error: true, name: bound(error.name, 40), code: error.code ?? null, errno: error.errno ?? null, syscall: bound(error.syscall, 40), signal: error.signal ?? null, killed: error.killed ?? false, message: /^Command failed/.test(error.message) ? 'Command failed' : bound(error.message) }
}

// Run `fn` for observation; its own failure becomes one safe constant line.
function safely(id, fn) {
  try { fn() } catch { log('observer-error', { id }) }
}

// Our listener must not hide an event that would otherwise be unhandled: rethrow when it is the only one.
function listen(emitter, event, handler) {
  emitter.on(event, function (...args) {
    safely(0, () => handler(...args))
    if (event === 'error' && emitter.listenerCount('error') === 1) throw args[0]
  })
}

function observed_execFile(thisArg, args) {
  const id = ++observed
  const binary = args[0]
  let child
  const state = () => ({ childPid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null })
  safely(id, () => {
    const stat = fs.statSync(binary)
    log('execFile', { id, regular: stat.isFile(), mode: (stat.mode & 0o777).toString(8), size: stat.size, sha256: sha(fs.readFileSync(binary)), argc: args.length, hasCallback: typeof args[args.length - 1] === 'function', envOverrideIsBinary: process.env.WRITEFLEX_SCOUT_BIN === binary })
  })
  const last = args.length - 1
  const callback = args[last]
  if (typeof callback === 'function') {
    args[last] = function (error, stdout, stderr) {
      safely(id, () => log('callback', { id, ...state(), ...errorFields(error), stdoutBytes: Buffer.byteLength(String(stdout ?? '')), stdoutSha: sha(String(stdout ?? '')), stderrBytes: Buffer.byteLength(String(stderr ?? '')), stderrSha: sha(String(stderr ?? '')) }))
      return Reflect.apply(callback, this, arguments)
    }
  }
  child = Reflect.apply(original, thisArg, args)
  safely(id, () => {
    listen(child, 'spawn', () => log('spawn', { id, childPid: child.pid }))
    listen(child, 'error', (e) => log('child-error', { id, ...state(), ...errorFields(e) }))
    listen(child, 'exit', (code, signal) => log('exit', { id, ...state(), code, signal }))
    listen(child, 'close', (code, signal) => log('close', { id, ...state(), code, signal }))
    const stdin = child.stdin
    if (stdin) {
      const end = stdin.end
      stdin.end = function (...inputArgs) {
        safely(id, () => {
          const chunk = inputArgs[0]
          const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof inputArgs[1] === 'string' ? inputArgs[1] : 'utf8') : (chunk && chunk.byteLength) || 0
          log('stdin-end', { id, bytes })
        })
        return Reflect.apply(end, this, inputArgs)
      }
      listen(stdin, 'error', (e) => log('stdin-error', { id, ...state(), ...errorFields(e) }))
      listen(stdin, 'finish', () => log('stdin-finish', { id }))
      listen(stdin, 'close', () => log('stdin-close', { id }))
    }
  })
  return child
}

const isFake = (binary) => typeof binary === 'string' && FAKE.test(binary)

const patched = function execFile(...args) {
  if (!isFake(args[0])) return Reflect.apply(original, this, args)
  return observed_execFile(this, args)
}
// Keep util.promisify(execFile) working; fixture calls go through the observed callback form.
const customPromisify = original[util.promisify.custom]
if (customPromisify) {
  Object.defineProperty(patched, util.promisify.custom, {
    enumerable: false,
    value: function execFile(...args) {
      if (!isFake(args[0])) return Reflect.apply(customPromisify, this, args)
      let child
      const promise = new Promise((resolve, reject) => {
        child = observed_execFile(this, [...args, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))])
      })
      promise.child = child
      return promise
    },
  })
}
cp.execFile = patched
require('node:module').syncBuiltinESMExports()
log('preload-ready', { node: process.version, bun: process.versions.bun ?? null })
process.on('exit', () => log('observer-exit', { observed }))
