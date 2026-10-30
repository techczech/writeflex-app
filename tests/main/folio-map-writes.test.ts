import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { mapFilePath, writeMap, undoMap, readMap, serializeCanvas } from '../../src/main/folio-map'
import { parseCanvas, mapPatch } from '../../src/shared/folio-map'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-map-')); await mixedFolio(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const a = { id: 'a', type: 'file', file: 'mixed/intro.md', x: 0, y: 0, width: 240, height: 130, foreign: { author: 'external' } }
const b = { ...a, id: 'b', file: 'mixed/methods.md', x: 300 }
test('first create and inverse leave every other Folio file unchanged', async () => {
 const ws = new FolioWorkspace(new Workspace(root), 'mixed')
 const index = await readFile(join(root, 'mixed/_mixed_INDEX.md'), 'utf8')
 const { foreign, ...partNode } = a
 const result = await writeMap(ws, [{ kind: 'addNode', node: partNode }], { session: 'create' })
 expect(result.ok).toBe(true)
 expect((await readMap(ws, 'mixed')).nodes[0].title).toBe('Intro')
 expect((await undoMap(ws, result.token!, { session: 'create' })).ok).toBe(true)
 expect(JSON.parse(await readFile(join(root, mapFilePath(ws)), 'utf8')).nodes).toEqual([])
 expect(await readFile(join(root, 'mixed/_mixed_INDEX.md'), 'utf8')).toBe(index)
})
test('checkpoint races rebase disjoint moves, preserve style and reject stale Undo', async () => {
 const ws = new FolioWorkspace(new Workspace(root), 'mixed'), path = join(root, mapFilePath(ws))
 const original = '\ufeff' + JSON.stringify({ nodes: [a,b], edges: [], foreign: { keep: true } }, null, '\t').replace(/\n/g, '\r\n') + '\r\n'
 await writeFile(path, original)
 const result = await writeMap(ws, [mapPatch(a, { x: 20 })], { session: 'race', beforeWrite: async () => { await writeFile(path, original.replace('"x": 300', '"x": 500')) } })
 expect(result.ok).toBe(true)
 const text = await readFile(path, 'utf8'), doc = parseCanvas(text)
 expect(doc.style).toEqual(parseCanvas(original).style)
 expect(doc.root.nodes[1].x).toBe(500)
 expect(doc.root.nodes[0].foreign).toEqual(a.foreign)
 await writeFile(path, text.replace('"x": 20', '"x": 40'))
 expect((await undoMap(ws, result.token!, { session: 'race' })).ok).toBe(false)
 expect(parseCanvas(await readFile(path, 'utf8')).root.nodes[0].x).toBe(40)
})
test('unreadable and lossy foreign values are never overwritten, including inside changed nodes', async () => {
 const ws = new FolioWorkspace(new Workspace(root), 'mixed'), path = join(root, mapFilePath(ws))
 for (const source of ['broken', '{"nodes":[],"edges":[],"foreign":9007199254740993}', '{"nodes":[],"edges":[],"foreign":{"n":9007199254740993}}', '{"nodes":[],"edges":[],"foreign":[{"keep":1,"keep":2}]}', '{"nodes":[],"edges":[],"foreign":{"2":2,"1":1}}', JSON.stringify({nodes:[a],edges:[]}).replace('"foreign":{"author":"external"}', '"foreign":9007199254740993')]) {
  await writeFile(path, source)
  const result = await writeMap(ws, source.includes('"id":"a"') ? [mapPatch({...a, foreign:9007199254740992}, {x:30})] : [{kind:'addNode',node:b}], {session:source})
  expect(result.ok).toBe(false)
  expect(await readFile(path,'utf8')).toBe(source)
 }
})
test('serialisation preserves optional edges absence and refuses duplicate or reordered keys', () => {
 expect(serializeCanvas(parseCanvas('{"nodes":[]}'), {nodes:[a], edges:[]})).not.toContain('"edges"')
 for (const source of ['{"nodes":[],"edges":[],"foreign":1,"foreign":2}', '{"nodes":[],"edges":[],"2":"two","1":"one"}']) expect(() => serializeCanvas(parseCanvas(source), { ...parseCanvas(source).root, nodes:[a] })).toThrow()
})

test('moving a recovered research node repairs only its own file field', async () => {
 const ws=new FolioWorkspace(new Workspace(root),'mixed'), path=join(root,mapFilePath(ws))
 const research={...a,file:'old/path/mixed/research/scores.json'}
 await writeFile(path,JSON.stringify({nodes:[research,b],edges:[]}))
 const result=await writeMap(ws,[mapPatch(research,{x:20})],{session:'research'})
 expect(result.ok).toBe(true)
 const nodes=JSON.parse(await readFile(path,'utf8')).nodes
 expect(nodes[0].file).toBe('mixed/research/scores.json');expect(nodes[1]).toEqual(b)
})
