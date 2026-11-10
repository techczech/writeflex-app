import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Execute the actual host bind function with realm-local structured-clone DTOs.
// ReaderPort and receive are explicit stubs; no PDF or native runtime is needed.
const host = readFileSync(new URL('../../src/renderer/src/reader-host.ts', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../../src/shared/reading-room-channel.ts', import.meta.url), 'utf8')
const bind = host.slice(host.indexOf('function bind('), host.indexOf("\naddEventListener('message', bind)"))
const helperStart = host.indexOf('function expectedParentMessageOrigin(')
const helper = helperStart < 0 ? '' : host.slice(helperStart, host.indexOf('\nfunction bind(', helperStart))
const boundedStart = shared.indexOf('export function boundedReaderDTO(')
const boundedEnd = shared.indexOf('\nfunction record(', boundedStart)
if (!bind.includes('new ReaderPort') || boundedStart < 0 || boundedEnd < 0) throw new Error('Host boundary extraction refused')
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(shared.slice(boundedStart, boundedEnd).replace('export ', '') + '\n' + helper + '\n' + bind)
function accepts(patch = '', parentOrigin = 'file://'): boolean {
  const c = vm.createContext({})
  vm.runInContext(`
    const parent = {}, port = {}, config = { parentOrigin: ${JSON.stringify(parentOrigin)}, lease: {id:'a'.repeat(32), nonce:'b'.repeat(48), generation:1} };
    const MAX_JSON = 24 * 1024 * 1024;
    let channel = null, constructed = false, removed = false;
    function receive() { return null }
    function removeEventListener(type, callback) { if (type !== 'message' || callback !== bind) throw Error('Wrong listener'); removed = true }
    class ReaderPort { constructor(p, lease, role, callback) {
      if (p !== port || lease !== config.lease || role !== 'host' || callback !== receive) throw Error('Wrong channel arguments');
      constructed = true;
    } }
    ${code}
    const event = {source:parent, origin:'null', ports:[port], data:{type:'bind',version:1,reader:config.lease.id,generation:1,nonce:config.lease.nonce}};
    ${patch}
    bind(event);
    if (constructed !== removed) throw Error('Listener/channel mismatch');
  `, c)
  return vm.runInContext('constructed', c)
}
test('approved file editor binds with its exact null message-origin serialisation', () => {
  expect(accepts()).toBe(true)
})
test('approved file editor refuses its location origin as a message sender origin', () => {
  expect(accepts("event.origin = 'file://'")).toBe(false)
})
test('custom trusted parent keeps its exact origin comparison', () => {
  expect(accepts("event.origin = 'wf-editor://approved'", 'wf-editor://approved')).toBe(true)
  expect(accepts('', 'wf-editor://approved')).toBe(false)
  expect(accepts("event.origin = 'wf-editor://other'", 'wf-editor://approved')).toBe(false)
})
for (const [name, patch] of [
  ['wrong source', 'event.source = {}'],
  ['wrong origin', "event.origin = 'https://example.invalid'"],
  ['wrong nonce', "event.data.nonce = 'c'.repeat(48)"],
  ['wrong generation', 'event.data.generation++'],
  ['wrong lease id', "event.data.reader = 'c'.repeat(32)"],
  ['wrong version', 'event.data.version = 2'],
  ['wrong type', "event.data.type = 'open'"],
  ['existing channel', 'channel = {}'],
  ['no port', 'event.ports = []'],
  ['two ports', 'event.ports = [port, {}]'],
  ['extra DTO key', 'event.data.extra = true'],
  ['missing DTO key', 'delete event.data.nonce'],
  ['null DTO', 'event.data = null'],
  ['array DTO', 'event.data = []'],
  ['accessor DTO', "Object.defineProperty(event.data, 'nonce', {get(){throw Error('Accessor read')}, enumerable:true})"],
  ['non-data DTO', 'event.data = new Date()'],
  ['cyclic DTO', 'event.data.loop = event.data'],
] as const) test(`bind refuses ${name}`, () => { expect(accepts(patch)).toBe(false) })
test('a second bind cannot replace an already accepted channel', () => {
  expect(accepts(`bind(event); if (!constructed) throw Error('First bind refused'); constructed = false; removed = false;`)).toBe(false)
})
test('file-like and unrelated opaque parents do not inherit approved file message conversion', () => {
  expect(accepts('', 'file://other')).toBe(false)
  expect(accepts('', 'data:')).toBe(false)
  expect(accepts('', 'about:blank')).toBe(false)
})
