import { expect, test } from 'bun:test'
import { parseCanvas, applyMapOps, mapPatch, mapNodeViews, mapPath, mapOrderPreview } from '../../src/shared/folio-map'
const node = (id: string, file: string, x = 0) => ({ id, type: 'file', file, x, y: 0, width: 240, height: 130 })
const edge = (id: string, fromNode: string, toNode: string, label = 'path') => ({ id, fromNode, toNode, label, toEnd: 'arrow' })
const parts = ['Cover', 'A', 'Off path', 'B', 'C'].map((title, index) => ({ index, title, key: { title, path: `paper/${title}.md` }, frontMatter: index === 0, titleClash: null }))

test('canvas reads preserve style and unknown values; an unreadable map is refused', () => {
  const source = '\ufeff{\r\n\t"nodes": [],\r\n\t"edges": [],\r\n\t"foreign": {"keep": true}\r\n}\r\n'
  const read = parseCanvas(source)
  expect(read.style).toEqual({ bom: '\ufeff', eol: '\r\n', indent: '\t', newline: true })
  expect(read.root.foreign).toEqual({ keep: true })
  expect(() => parseCanvas('{"nodes": "bad"}')).toThrow()
  expect(() => parseCanvas('{invalid')).toThrow()
})

test('moves rebase on disjoint nodes and refuse a changed coordinate without touching the other values', () => {
  const a = { ...node('a', 'paper/A.md'), foreign: { owner: 'other app' } }, b = node('b', 'paper/B.md', 300)
  const moveA = mapPatch(a, { x: 20, y: 30 })
  const movedB = { ...b, x: 500 }
  const applied = applyMapOps({ nodes: [a, movedB], edges: [], custom: 'keep' }, [moveA])
  expect(applied.refused).toHaveLength(0)
  expect(applied.root.nodes[0]).toEqual({ ...a, x: 20, y: 30 })
  expect(applied.root.nodes[1]).toBe(movedB)
  expect(applyMapOps(applied.root, applied.inverse).root.nodes[0]).toEqual(a)
  const refused = applyMapOps({ nodes: [{ ...a, x: 1 }, b], edges: [] }, [moveA])
  expect(refused.refused).toHaveLength(1)
  expect(refused.root.nodes[0].x).toBe(1)
})

test('deleting a node expects every attached edge and Undo restores its values and positions', () => {
  const a = node('a', 'paper/A.md'), b = node('b', 'paper/B.md'), ab = edge('ab', 'a', 'b')
  const op = { kind: 'deleteNode' as const, node: a, edges: [ab] }
  const fresh = { nodes: [a, b], edges: [ab, edge('new', 'b', 'a', 'supports')] }
  expect(applyMapOps(fresh, [op]).refused).toHaveLength(1)
  const removed = applyMapOps({ nodes: [a, b], edges: [ab] }, [op])
  expect(removed.root.nodes).toEqual([b])
  expect(removed.root.edges).toEqual([])
  expect(applyMapOps(removed.root, removed.inverse).root).toEqual({ nodes: [a, b], edges: [ab] })
})

test('redrawing a path checks the whole old edge, including a retarget under the same id', () => {
  const a = node('a', 'paper/A.md'), b = node('b', 'paper/B.md'), c = node('c', 'paper/C.md')
  const old = edge('ab', 'a', 'b')
  const result = applyMapOps({ nodes: [a, b, c], edges: [{ ...old, toNode: 'c' }] }, [{ kind: 'path', expect: [old], edges: [edge('ba', 'b', 'a')] }])
  expect(result.refused).toHaveLength(1)
  expect(result.root.edges[0].toNode).toBe('c')
})

test('map meanings come from standard fields; moved-Folio paths recover and duplicate part edges are ignored', () => {
  const root = { nodes: [node('a', 'old/location/paper/A.md'), node('a-copy', 'paper/A.md'), node('b', 'paper/B.md'), { id: 'unwritten', type: 'text', text: '[[C]]', x: 0, y: 200, width: 240, height: 130 }], edges: [edge('ab', 'a', 'b'), edge('duplicate', 'a-copy', 'b')] }
  const views = mapNodeViews(root, parts, 'paper', parts.map(part => part.key.path!))
  expect(views[0].resolvedPath).toBe('paper/A.md')
  expect(views[1].duplicate).toBe(true)
  expect(views[3].partIndex).toBe(4)
  expect(mapPath(root, views, parts)).toMatchObject({ valid: true, parts: [1, 3] })
})

test('path failures name forks, cycles and non-parts; preview moves only path slots and never front matter', () => {
  const root = { nodes: [node('a', 'paper/A.md'), node('b', 'paper/B.md'), node('c', 'paper/C.md'), { id: 'note', type: 'text', text: 'Other thoughts', x: 0, y: 300, width: 200, height: 100 }], edges: [] }
  const views = mapNodeViews(root, parts, 'paper', parts.map(part => part.key.path!))
  expect(mapPath({ ...root, edges: [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')] }, views, parts).message).toContain('fork')
  expect(mapPath({ ...root, edges: [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')] }, views, parts).message).toContain('cycle')
  expect(mapPath({ ...root, edges: [edge('an', 'a', 'note')] }, views, parts).message).toContain('part')
  expect(mapOrderPreview(parts, [4, 1, 3])).toEqual({ order: [0, 4, 2, 1, 3], moved: [1, 3, 4] })
})

test('moves and their inverse expect the complete prior rectangle',()=>{
 const a=node('a','paper/A.md'),move=mapPatch(a,{x:20})
 expect(Object.keys(move.fields)).toEqual(['x','y','width','height'])
 expect(applyMapOps({nodes:[{...a,width:480}],edges:[]},[move]).refused).toHaveLength(1)
 const moved=applyMapOps({nodes:[a],edges:[]},[move])
 expect(applyMapOps({...moved.root,nodes:[{...moved.root.nodes[0],height:180}]},moved.inverse).refused).toHaveLength(1)
 expect(applyMapOps({nodes:[a],edges:[]},[{kind:'patch',id:a.id,fields:{x:move.fields.x}}]).refused).toHaveLength(1)
})
