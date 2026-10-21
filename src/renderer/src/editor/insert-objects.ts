import { EditorState, type ChangeSpec } from '@codemirror/state'
import { mermaidSkeleton, type MermaidType } from './object-editors/mermaid-editor'

export function renumberFootnotes(doc: string): { changes: ChangeSpec[] } | null {
  const definition = /^\[\^(\d+)\]:[^\n]*(?:\n(?!\[\^\d+\]:)[^\n]+)*/gm
  const definitions = [...doc.matchAll(definition)].map((match) => ({ number: Number(match[1]), text: match[0] }))
  const body = doc.replace(definition, '').replace(/\n{3,}/g, '\n\n').trimEnd()
  const order: number[] = []
  for (const match of body.matchAll(/\[\^(\d+)\]/g)) { const number = Number(match[1]); if (!order.includes(number)) order.push(number) }
  if (!order.length) return null
  const mapping = new Map(order.map((number, index) => [number, index + 1]))
  const replacedBody = body.replace(/\[\^(\d+)\]/g, (whole, raw) => mapping.has(Number(raw)) ? `[^${mapping.get(Number(raw))}]` : whole)
  const used = order.flatMap((number) => {
    const found = definitions.find((item) => item.number === number)
    return found ? [found.text.replace(/^\[\^\d+\]:/, `[^${mapping.get(number)}]:`)] : []
  })
  const unused = definitions.filter((item) => !mapping.has(item.number)).map((item) => item.text)
  const result = [replacedBody, ...used, ...unused].join('\n\n')
  return result === doc ? null : { changes: [{ from: 0, to: doc.length, insert: result }] }
}

export function buildTable(): string {
  return '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n|  |  |  |'
}

export function buildCodeBlock(): string { return '```\n\n```' }
export function buildMermaid(type: MermaidType = 'flowchart-right'): string { return `\`\`\`mermaid\n${mermaidSkeleton(type)}\n\`\`\`` }
export function buildMarkmap(): string { return '```markmap\n- The River\n  - seasons\n    - birds\n```' }
export function buildSvg(): string {
  return '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">\n  <rect width="320" height="180" rx="12" fill="#f2f0ea"/>\n</svg>\n```'
}

export function isSvgText(text: string): boolean {
  return /^\s*<svg(?:\s|>)[\s\S]*<\/svg\s*>\s*$/i.test(text)
}

export function isSvgFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.toLowerCase() === 'image/svg+xml' || /\.svg$/i.test(file.name)
}

export function nextFootnoteNumber(doc: string): number {
  const used = new Set([...doc.matchAll(/\[\^(\d+)\]/g)].map((match) => Number(match[1])))
  let next = 1
  while (used.has(next)) next += 1
  return next
}

/**
 * Insert-object Footnote: the next unused marker at `caret` and its empty definition at the end, the whole
 * document then renumbered by marker position (a marker put before a later one renumbers it).
 */
export function insertFootnote(doc: string, caret: number): string {
  const number = nextFootnoteNumber(doc)
  const inserted = `${doc.slice(0, caret)}[^${number}]${doc.slice(caret)}\n\n[^${number}]: `
  const renumbered = renumberFootnotes(inserted)
  return renumbered ? EditorState.create({ doc: inserted }).update({ changes: renumbered.changes }).newDoc.toString() : inserted
}

/** What Edit metadata / Insert object → Metadata does for a document: open the block it has, refuse a mid-edit one, or create a bare block. */
export type MetadataEntry = { kind: 'open' } | { kind: 'malformed' } | { kind: 'create'; insert: string }

export function metadataEntry(doc: string, hasMetadataBlock: boolean): MetadataEntry {
  if (hasMetadataBlock) return { kind: 'open' }
  if (doc.startsWith('---')) return { kind: 'malformed' }
  return { kind: 'create', insert: '---\ntitle: \n---\n\n' }
}
