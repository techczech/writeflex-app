import { expect, test } from 'bun:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { ReaderHostLifetime } from '../../src/renderer/src/reader-host-lifetime'
import { copyReaderViewState } from '../../src/shared/reading-room-schema'
import { ReaderRegistry } from '../../src/main/reading-room-policy'
const source = readFileSync(new URL('../../src/renderer/src/reader-host.ts', import.meta.url), 'utf8')
const start = source.includes('async function closeReader(') ? source.indexOf('async function closeReader(') : source.indexOf('function closeReader('), end = source.indexOf('\nasync function open(', start)
const closeCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
test('actual host close waits for admitted late opens, both native viewers and repeated disposal', async () => {
  const life = new ReaderHostLifetime(), opening = deferred<void>(), worker = deferred<void>(), save = deferred<void>(), order: string[] = []
  const c = vm.createContext({ lifetime: life, disposed: false, saves: new Set([save.promise]), embed: { detachKeyboardDelivery() { order.push('detach') } }, frame: { contentWindow: { removeEventListener() {}, _reader: {} }, remove() { order.push('inner-frame-remove') } }, installOpenAdapter() {} })
  vm.runInContext(closeCode, c)
  const late = life.run(async () => { await opening.promise; (c as any).frame.contentWindow._reader = { _primaryView: { _iframeWindow: { PDFViewerApplication: { async close() { order.push('primary-close'); await worker.promise; order.push('worker-destroyed') } } } }, _secondaryView: { _iframeWindow: { PDFViewerApplication: { async close() { order.push('secondary-close') } } } } }; order.push('open-settled') })
  const first = vm.runInContext('closeReader()', c), second = vm.runInContext('closeReader()', c)
  let finished = false; void second.then(() => { finished = true })
  await tick(); expect(finished).toBe(false); expect(order).toEqual(['detach'])
  await expect(life.run(async () => {})).rejects.toThrow('closed')
  opening.resolve(); await late; save.resolve(); await tick()
  expect(order).toContain('primary-close'); expect(order).toContain('secondary-close'); expect(order).not.toContain('inner-frame-remove')
  worker.resolve(); await Promise.all([first, second])
  expect(order.at(-1)).toBe('inner-frame-remove'); expect(order.indexOf('worker-destroyed')).toBeLessThan(order.indexOf('inner-frame-remove'))
  expect(order.filter(x => x === 'primary-close')).toHaveLength(1)
})
test('closing one host neither blocks nor tears down its replacement', async () => {
 const old = new ReaderHostLifetime(), replacement = new ReaderHostLifetime(), pending = deferred<void>()
 let closedReplacement = false
 const closing = old.dispose(() => {}, () => pending.promise)
 expect(await replacement.run(async () => 42)).toBe(42)
 expect(closedReplacement).toBe(false)
 pending.resolve(); await closing
 await replacement.dispose(() => {}, async () => { closedReplacement = true })
 expect(closedReplacement).toBe(true)
})
test('realm state copying admits only exact known reader prototypes and executes zero accessors', () => {
 const realm = vm.createContext({}), nested = vm.runInContext('({pageIndex:0,scale:1,top:0,left:0,scrollMode:0,spreadMode:0})', realm)
 const proto = vm.runInContext('Object.prototype', realm)
 expect(copyReaderViewState(nested, [proto])).toEqual({ pageIndex: 0, scale: 1, top: 0, left: 0, scrollMode: 0, spreadMode: 0 })
 expect(() => copyReaderViewState(nested, [])).toThrow('prototype')
 let getters = 0
 for (const bad of [ { get pageIndex() { getters++; return 0 } }, { pageIndex: 0, [Symbol('x')]: 1 }, Object.create({ pageIndex: 0 }), { pageIndex: 0, extra: true }, { pageIndex: 0, scale: Infinity } ]) expect(() => copyReaderViewState(bad, [proto])).toThrow()
 expect(getters).toBe(0)
 const cyclic: any = { pageIndex: 0 }; cyclic.self = cyclic
 expect(() => copyReaderViewState(cyclic, [proto])).toThrow()
})
test('keyboard authority is exact to committed owner frame node and generation, including nested views', () => {
 const r = new ReaderRegistry(), owner = { id: 1, top: '1:1', origin: 'file://', epoch: 1 }, g = r.create(owner, 0)
 const top: any = { processId: 1, routingId: 1, parent: null, origin: 'file://' }
 const host: any = { processId: 2, routingId: 4, frameTreeNodeId: 9, parent: top, origin: g.origin, url: g.url + '#bootstrap' }
 const view: any = { processId: 2, routingId: 5, frameTreeNodeId: 10, parent: host, origin: g.origin }
 g.entryUsed = true; g.frameNode = 9; r.commitFrame(owner.id, host)
 expect(r.keyboardFrame(owner.id, top, view)).toBe(true)
 expect(r.keyboardFrame(2, top, view)).toBe(false)
 expect(r.keyboardFrame(owner.id, top, { ...view, origin: 'null' })).toBe(false)
 expect(r.keyboardFrame(owner.id, top, { ...host, frameTreeNodeId: 99 })).toBe(false)
 expect(r.keyboardFrame(owner.id, top, { ...host, routingId: 99 })).toBe(false)
 g.generation++; expect(r.keyboardFrame(owner.id, top, view)).toBe(false); g.generation--
 const replacement = r.create(owner, 1); replacement.entryUsed = true; replacement.frameNode = 11
 const next: any = { ...host, origin: replacement.origin, url: replacement.url, frameTreeNodeId: 11, routingId: 9 }; r.commitFrame(owner.id, next)
 r.revoke(g.id); expect(r.keyboardFrame(owner.id, top, view)).toBe(false); expect(r.keyboardFrame(owner.id, top, next)).toBe(true)
})
