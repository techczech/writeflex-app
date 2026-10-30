import { readLabelVocabulary, inlineLabelNames, withoutYamlComment } from './folio-room'
import { frontmatterBlock } from './markdown/frontmatter'
import type { LabelChange } from './folio-room-authoring'

type Line = { text: string; ending: string }
const split = (source: string): Line[] => [...source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)].filter(match => match[0] !== '').map(match => ({ text: match[1], ending: match[2] }))
const joined = (lines: Line[]): string => lines.map(line => line.text + line.ending).join('')

/** Splice the labels span only; leave unknown YAML keys and every body byte alone. */
export function spliceLabelVocabulary(source: string, names: string[], change: LabelChange): string {
  const bom = source.startsWith('\ufeff') ? '\ufeff' : ''
  const block = frontmatterBlock(source)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const items = names.map(name => `  - ${JSON.stringify(name)}${eol}`).join('')
  if (!block) return `${bom}---${eol}labels:${eol}${items}---${eol}${source.slice(bom.length)}`
  const lines = split(source.slice(bom.length, block.end))
  const at = lines.findIndex(line => /^labels\s*:/.test(line.text))
  if (at < 0) { lines.splice(lines.length - 1, 0, { text: `labels:${eol}${items}`, ending: '' }); return bom + joined(lines) + source.slice(block.end) }
  const raw = lines[at].text.replace(/^labels\s*:[ \t]*/, '')
  const value = withoutYamlComment(raw).trim()
  let end = at + 1
  while (end < lines.length - 1 && !/^[^\s#][^:]*:/.test(lines[end].text)) end += 1
  const segment = lines.slice(at + 1, end)
  if (segment.some(line => line.text.trim() && !/^\s*#/.test(line.text) && !/^\s*-\s+/.test(line.text))) throw new Error('The labels value is not a plain list, so nothing was changed.')
  if (value === '') {
    const vocabulary = readLabelVocabulary(source).labels
    const itemLines = segment.filter(line => /^\s*-\s+/.test(line.text))
    if (itemLines.length !== vocabulary.length) throw new Error('The labels list contains an unreadable name, so nothing was changed.')
    let i = 0
    const kept: Line[] = []
    for (const line of segment) {
      if (!/^\s*-\s+/.test(line.text)) { kept.push(line); continue }
      const label = vocabulary[i++]
      if (change.op === 'delete' && label.slug === change.slug) continue
      if (change.op === 'rename' && label.slug === change.slug) {
        const lead = /^(\s*-\s+)(.*)$/.exec(line.text)!
        const body = withoutYamlComment(lead[2])
        const comment = lead[2].slice(body.trimEnd().length)
        kept.push({ text: lead[1] + JSON.stringify(change.name.trim()) + comment, ending: line.ending })
      } else kept.push(line)
    }
    if (change.op === 'add') kept.push({ text: `  - ${JSON.stringify(change.name.trim())}`, ending: eol })
    lines.splice(at + 1, end - at - 1, ...kept)
  } else {
    if (value.startsWith('[') && inlineLabelNames(value) === null) throw new Error('The inline labels list cannot be read safely, so nothing was changed.')
    if (/^[|>{&*!]/.test(value) || (value.startsWith('[') && !value.endsWith(']'))) throw new Error('The labels value cannot be safely converted to a list.')
    const comment = raw.slice(withoutYamlComment(raw).trimEnd().length)
    if (segment.some(line => line.text.trim() && !/^\s*#/.test(line.text))) throw new Error('The labels value mixes inline and block content, so nothing was changed.')
    lines.splice(at, 1, { text: `labels:${comment}`, ending: eol }, ...names.map(name => ({ text: `  - ${JSON.stringify(name)}`, ending: eol })))
  }
  const next = bom + joined(lines) + source.slice(block.end)
  if (JSON.stringify(readLabelVocabulary(next).labels.map(label => label.name)) !== JSON.stringify(names)) throw new Error('The labels did not round-trip, so nothing was changed.')
  return next
}
