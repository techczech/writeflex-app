/** JSON Canvas uses standard fields only. Part metadata is derived from the Folio, never copied to nodes. */
export type CanvasNode = Record<string, unknown> & { id: string; type: string; x: number; y: number; width: number; height: number }
export type CanvasEdge = Record<string, unknown> & { id: string; fromNode: string; toNode: string; label?: string }
export type CanvasRoot = Record<string, unknown> & { nodes: CanvasNode[]; edges: CanvasEdge[] }
export type CanvasStyle = { bom: string; eol: string; indent: string; newline: boolean }
export type CanvasDocument = { source: string | null; root: CanvasRoot; style: CanvasStyle }
export type MapField = { before: { present: boolean; value?: unknown }; after: { present: boolean; value?: unknown } }
export type MapOp =
  | { kind: 'addNode'; node: CanvasNode; at?: number; edges?: CanvasEdge[]; edgeAt?: number[] }
  | { kind: 'patch'; id: string; fields: Record<string, MapField> }
  | { kind: 'deleteNode'; node: CanvasNode; edges: CanvasEdge[] }
  | { kind: 'addEdge'; edge: CanvasEdge; at?: number }
  | { kind: 'deleteEdge'; edge: CanvasEdge }
  | { kind: 'path'; expect: CanvasEdge[]; edges: CanvasEdge[]; at?: number[] }
export type MapPart = { index: number; title: string; key: { title: string; path: string | null }; frontMatter: boolean; titleClash?: string | null }
export type MapNodeView = { raw: CanvasNode; kind: 'part' | 'research' | 'note' | 'text' | 'group' | 'zotero' | 'highlight' | 'link' | 'missing'; title: string; partIndex: number | null; resolvedPath: string | null; duplicate: boolean; target?: string; quote?: string; itemTarget?: string; sourceState?: string }
export type MapPath = { valid: boolean; parts: number[]; nodes: string[]; message: string }
export type RoomMap = { path: string; state: 'missing' | 'ready' | 'unreadable'; message?: string; document: CanvasDocument | null; nodes: MapNodeView[]; pathOrder: MapPath }
const fold = (text: string): string => text.normalize('NFC').trim().toLocaleLowerCase('en-GB')
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function canvasNode(value: unknown): value is CanvasNode {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 200 || typeof value.type !== 'string') return false
  if (!['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key])) || (value.width as number) <= 0 || (value.height as number) <= 0) return false
  return value.type === 'file' ? typeof value.file === 'string' : value.type === 'text' ? typeof value.text === 'string' : value.type === 'link' ? typeof value.url === 'string' : value.type === 'group'
}
export function canvasEdge(value: unknown): value is CanvasEdge { return record(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200 && typeof value.fromNode === 'string' && typeof value.toNode === 'string' && (value.label === undefined || typeof value.label === 'string') }
export function parseCanvas(source: string | null): CanvasDocument {
  if (source === null) return { source, root: { nodes: [], edges: [] }, style: { bom: '', eol: '\n', indent: '  ', newline: true } }
  const bom = source.startsWith('\ufeff') ? '\ufeff' : ''
  const root: unknown = JSON.parse(source.slice(bom.length))
  if (!record(root) || !Array.isArray(root.nodes) || !root.nodes.every(canvasNode) || (root.edges !== undefined && (!Array.isArray(root.edges) || !root.edges.every(canvasEdge)))) throw new Error('This map file cannot be read.')
  const nodes = root.nodes as CanvasNode[], edges = (root.edges ?? []) as CanvasEdge[]
  if (new Set(nodes.map(node => node.id)).size !== nodes.length || new Set(edges.map(edge => edge.id)).size !== edges.length) throw new Error('This map has repeated card or arrow identifiers and cannot be edited safely.')
  const indent = /(?:\r\n|\n|\r)([\t ]+)"/.exec(source)?.[1] ?? '  '
  return { source, root: { ...root, nodes, edges } as CanvasRoot, style: { bom, eol: /\r\n|\n|\r/.exec(source)?.[0] ?? '\n', indent: indent.includes('\t') ? '\t' : indent, newline: /(?:\r\n|\n|\r)[\t ]*$/.test(source) } }
}
export function sameCanvasValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, at) => sameCanvasValue(value, b[at]))
  if (record(a) && record(b)) { const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameCanvasValue(a[key], b[key])) }
  return false
}
export function mapPatch(node: CanvasNode, changes: Record<string, unknown>): Extract<MapOp, { kind: 'patch' }> {
  if (['x','y','width','height'].some(key => Object.hasOwn(changes,key))) changes = {x:node.x,y:node.y,width:node.width,height:node.height,...changes}
  return { kind: 'patch', id: node.id, fields: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { before: Object.hasOwn(node, key) ? { present: true, value: node[key] } : { present: false }, after: value === undefined ? { present: false } : { present: true, value } }])) }
}
const PATCH_FIELDS = new Set(['x', 'y', 'width', 'height', 'type', 'file', 'text', 'label', 'url', 'color'])
export function applyMapOps(input: CanvasRoot, ops: readonly MapOp[]): { root: CanvasRoot; applied: MapOp[]; refused: MapOp[]; inverse: MapOp[] } {
  const root: CanvasRoot = { ...input, nodes: [...input.nodes], edges: [...(input.edges ?? [])] }
  const applied: MapOp[] = [], refused: MapOp[] = [], inverse: MapOp[] = []
  const reject = (op: MapOp): void => { refused.push(op) }
  for (const op of ops) {
    if (op.kind === 'addNode') {
      const edges = op.edges ?? [], ids = new Set([...root.nodes.map(node => node.id), op.node.id])
      if (!canvasNode(op.node) || root.nodes.some(node => node.id === op.node.id) || edges.some(edge => !canvasEdge(edge) || root.edges.some(existing => existing.id === edge.id) || !ids.has(edge.fromNode) || !ids.has(edge.toNode)) || new Set(edges.map(edge => edge.id)).size !== edges.length) { reject(op); continue }
      root.nodes.splice(op.at ?? root.nodes.length, 0, op.node)
      edges.forEach((edge, at) => root.edges.splice(op.edgeAt?.[at] ?? root.edges.length, 0, edge))
      inverse.unshift({ kind: 'deleteNode', node: op.node, edges }); applied.push(op)
    } else if (op.kind === 'patch') {
      const at = root.nodes.findIndex(node => node.id === op.id), node = root.nodes[at]
      const fields = Object.entries(op.fields)
      if (!node || !fields.length || (fields.some(([key])=>['x','y','width','height'].includes(key)) && !['x','y','width','height'].every(key=>Object.hasOwn(op.fields,key))) || fields.some(([key, field]) => !PATCH_FIELDS.has(key) || Object.hasOwn(node, key) !== field.before.present || (field.before.present && !sameCanvasValue(node[key], field.before.value)))) { reject(op); continue }
      const next = { ...node }
      for (const [key, field] of fields) { if (field.after.present) next[key] = field.after.value; else delete next[key] }
      if (!canvasNode(next)) { reject(op); continue }
      root.nodes[at] = next
      inverse.unshift({ ...op, fields: Object.fromEntries(fields.map(([key, field]) => [key, { before: field.after, after: field.before }])) }); applied.push(op)
    } else if (op.kind === 'deleteNode') {
      const at = root.nodes.findIndex(node => node.id === op.node.id)
      const edges = root.edges.filter(edge => edge.fromNode === op.node.id || edge.toNode === op.node.id)
      if (at < 0 || !sameCanvasValue(root.nodes[at], op.node) || !sameCanvasValue(edges, op.edges)) { reject(op); continue }
      const positions = edges.map(edge => root.edges.indexOf(edge))
      root.nodes.splice(at, 1); root.edges = root.edges.filter(edge => !edges.includes(edge))
      inverse.unshift({ kind: 'addNode', node: op.node, at, edges, edgeAt: positions }); applied.push(op)
    } else if (op.kind === 'addEdge') {
      if (!canvasEdge(op.edge) || root.edges.some(edge => edge.id === op.edge.id) || !root.nodes.some(node => node.id === op.edge.fromNode) || !root.nodes.some(node => node.id === op.edge.toNode)) { reject(op); continue }
      root.edges.splice(op.at ?? root.edges.length, 0, op.edge)
      inverse.unshift({ kind: 'deleteEdge', edge: op.edge }); applied.push(op)
    } else if (op.kind === 'deleteEdge') {
      const at = root.edges.findIndex(edge => edge.id === op.edge.id)
      if (at < 0 || !sameCanvasValue(root.edges[at], op.edge)) { reject(op); continue }
      root.edges.splice(at, 1); inverse.unshift({ kind: 'addEdge', edge: op.edge, at }); applied.push(op)
    } else if (op.kind === 'path') {
      const old = root.edges.filter(edge => edge.label === 'path')
      const other = root.edges.filter(edge => edge.label !== 'path')
      if (!sameCanvasValue(old, op.expect) || op.edges.some(edge => !canvasEdge(edge) || edge.label !== 'path' || other.some(existing => existing.id === edge.id) || !root.nodes.some(node => node.id === edge.fromNode) || !root.nodes.some(node => node.id === edge.toNode)) || new Set(op.edges.map(edge => edge.id)).size !== op.edges.length) { reject(op); continue }
      const positions = old.map(edge => root.edges.indexOf(edge))
      root.edges = other; op.edges.forEach((edge, at) => root.edges.splice(op.at?.[at] ?? root.edges.length, 0, edge))
      inverse.unshift({ kind: 'path', expect: op.edges, edges: old, at: positions }); applied.push(op)
    } else reject(op)
  }
  return { root, applied, refused, inverse }
}

function normalPath(path: string): string | null {
  if (path.startsWith('/') || path.includes('\\')) return null
  const parts: string[] = []
  for (const part of path.split('/')) { if (!part || part === '.') continue; if (part === '..') { if (!parts.length) return null; parts.pop() } else parts.push(part) }
  return parts.join('/')
}
export function resolveCanvasFile(file: string, dir: string, files: readonly string[]): string | null {
  const match = (path: string | null): string | null => {
    if (path === null) return null
    if (files.includes(path)) return path
    const folded = files.filter(file => fold(file) === fold(path)); return folded.length === 1 ? folded[0] : null
  }
  const direct = match(normalPath(file)); if (direct) return direct
  const segments = file.replace(/\\/g, '/').split('/'), folder = dir.split('/').filter(Boolean).at(-1)
  if (folder) {
    let at = -1; segments.forEach((part, index) => { if (fold(part) === fold(folder)) at = index })
    if (at >= 0) { const recovered = match(normalPath([dir, ...segments.slice(at + 1)].join('/'))); if (recovered) return recovered }
  }
  const basename = segments.at(-1)
  const found = files.filter(path => (!dir || path.startsWith(dir + '/')) && fold(path.split('/').at(-1)!) === fold(basename ?? ''))
  return found.length === 1 ? found[0] : null
}
export function mapNodeViews(root: CanvasRoot, parts: readonly MapPart[], dir: string, files: readonly string[]): MapNodeView[] {
  const placed = new Set<number>()
  return root.nodes.map(raw => {
    const view: MapNodeView = { raw, kind: 'text', title: '', partIndex: null, resolvedPath: null, duplicate: false }
    if (raw.type === 'group') { view.kind = 'group'; view.title = typeof raw.label === 'string' ? raw.label : 'Cluster'; return view }
    if (raw.type === 'file') {
      view.resolvedPath = resolveCanvasFile(String(raw.file), dir, files)
      const part = parts.find(part => part.key.path !== null && part.key.path === view.resolvedPath)
      if (part) { view.kind = 'part'; view.partIndex = part.index; view.title = part.title }
      else { view.kind = view.resolvedPath ? 'research' : 'missing'; view.title = String(raw.file).split('/').at(-1) ?? String(raw.file) }
    } else if (raw.type === 'link') { view.kind = 'link'; view.title = String(raw.url); view.target = String(raw.url) }
    else {
      const text = String(raw.text ?? ''), wiki = /^\[\[([^\]\r\n]+)\]\]$/.exec(text)
      if (wiki) {
        const matches = parts.filter(part => fold(part.title) === fold(wiki[1]))
        if (matches.length === 1) { view.kind = 'part'; view.partIndex = matches[0].index; view.title = matches[0].title; view.resolvedPath = matches[0].key.path }
        else { view.kind = 'note'; view.title = wiki[1] }
      } else {
        const link = /^\[((?:\\.|[^\]\\])*)\]\((<[^>\r\n]+>|[^)\r\n]+)\)$/.exec(text)
        const target = link?.[2].replace(/^<|>$/g, '')
        if (target?.startsWith('zotero://')) { view.kind = target.includes('?annotation=') ? 'highlight' : 'zotero'; view.target = target; view.title = link![1].replace(/\\([\\[\]])/g, '$1') }
        else { view.title = text || 'Text card'; view.target = target }
      }
    }
    if (view.partIndex !== null) { view.duplicate = placed.has(view.partIndex); placed.add(view.partIndex) }
    return view
  })
}
export function mapPath(root: CanvasRoot, views: readonly MapNodeView[], parts: readonly MapPart[]): MapPath {
  const bad = (message: string): MapPath => ({ valid: false, parts: [], nodes: [], message })
  if (parts.some(part => part.titleClash)) return bad('Two parts share a title. Resolve the title clash before using the path.')
  const byId = new Map(views.map(view => [view.raw.id, view]))
  const edges = root.edges.filter(edge => edge.label === 'path' && !byId.get(edge.fromNode)?.duplicate && !byId.get(edge.toNode)?.duplicate)
  const outgoing = new Map<string, string>(), incoming = new Map<string, string>(), used = new Set<string>()
  for (const edge of edges) {
    const from = byId.get(edge.fromNode), to = byId.get(edge.toNode)
    if (!from || !to || from.partIndex === null || to.partIndex === null || parts[from.partIndex]?.frontMatter || parts[to.partIndex]?.frontMatter) return bad('The path must join running-order parts, excluding front matter.')
    if (outgoing.has(edge.fromNode)) return bad(`The path forks at ${from.title}.`)
    if (incoming.has(edge.toNode)) return bad(`The path joins more than once at ${to.title}.`)
    outgoing.set(edge.fromNode, edge.toNode); incoming.set(edge.toNode, edge.fromNode); used.add(edge.fromNode); used.add(edge.toNode)
  }
  if (!edges.length) {
    const only = views.filter(view => view.partIndex !== null && !view.duplicate && !parts[view.partIndex]?.frontMatter)
    return only.length === 1 ? { valid: true, parts: [only[0].partIndex!], nodes: [only[0].raw.id], message: 'The path contains one part.' } : bad('Draw a path through your parts.')
  }
  const roots = [...used].filter(id => !incoming.has(id))
  if (!roots.length) return bad('The path contains a cycle.')
  if (roots.length > 1) return bad('The path has more than one chain.')
  const chain: string[] = []; let at: string | undefined = roots[0]
  while (at !== undefined && !chain.includes(at)) { chain.push(at); at = outgoing.get(at) }
  if (at !== undefined || chain.length !== used.size) return bad('The path contains a cycle or a disconnected chain.')
  return { valid: true, nodes: chain, parts: chain.map(id => byId.get(id)!.partIndex!), message: `${chain.length} parts on the path` }
}
export function mapOrderPreview(parts: readonly MapPart[], path: readonly number[]): { order: number[]; moved: number[] } {
  if (new Set(path).size !== path.length || path.some(index => !parts[index] || parts[index].frontMatter)) throw new Error('The path does not name distinct running-order parts.')
  const slots = [...path].sort((a, b) => a - b), order = parts.map((_, index) => index)
  slots.forEach((slot, at) => { order[slot] = path[at] })
  return { order, moved: order.flatMap((value, at) => value !== at ? [at] : []) }
}
