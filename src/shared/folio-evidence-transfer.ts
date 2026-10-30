import { evidenceKey, normaliseQuote, type EvidenceItem, type EvidenceOp } from './folio-evidence'
export const EVIDENCE_DRAG_MIME = 'application/x-writeflex-evidence'
export const EVIDENCE_ATTACH_EVENT = 'writeflex:attach-evidence'
export type EvidenceTransfer =
  | { kind: 'file'; path: string; quote?: string }
  | { kind: 'note'; title: string }
  | { kind: 'zotero'; itemTarget: string; label: string; annotation?: { target: string; label: string }; pending?: boolean }
  | { kind: 'archive'; title: string; url: string }
const itemLink = /^zotero:\/\/select\/(library|groups\/\d+)\/items\/[A-Z\d]{8}$/
const annotationLink = /^zotero:\/\/open-pdf\/(library|groups\/\d+)\/items\/[A-Z\d]{8}\?annotation=[A-Z\d]{8}$/
const archiveLink = /^(?:https?:\/\/|file:\/\/|writeflex:\/\/open\?)/i
const oneLine = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value)
export function parseEvidenceTransfer(raw: string): EvidenceTransfer | null {
  if (raw.length > 128000) return null
  try {
    const data = JSON.parse(raw) as EvidenceTransfer
    if (data.kind === 'file' && oneLine(data.path) && (data.quote === undefined || (typeof data.quote === 'string' && data.quote.length <= 100000))) return data
    if (data.kind === 'note' && oneLine(data.title) && !/[\[\]]/.test(data.title)) return data
    if (data.kind === 'archive' && oneLine(data.title) && oneLine(data.url) && archiveLink.test(data.url) && !/[<>]/.test(data.url)) return data
    if (data.kind === 'zotero' && oneLine(data.label) && oneLine(data.itemTarget) && itemLink.test(data.itemTarget)) {
      if (data.annotation && (!oneLine(data.annotation.target) || !annotationLink.test(data.annotation.target) || !oneLine(data.annotation.label) || itemLink.exec(data.itemTarget)?.[1] !== annotationLink.exec(data.annotation.target)?.[1])) return null
      return data
    }
  } catch { /* Not an app evidence payload. */ }
  return null
}
const label = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
const url = (value: string): string => /[()\s]/.test(value) ? `<${value}>` : value
const chip = (name: string, target: string): string => `[${label(`⟨${name}⟩`)}](${url(target)})`

/** One item op includes its chosen highlight, so concurrent subtree changes cannot be discarded. */
export function evidenceAttachment(part: string, dir: string, source: EvidenceTransfer, existing: readonly EvidenceItem[], eol = '\n'): { op: Extract<EvidenceOp, { kind: 'item' }> | null; message?: string } {
  if (!parseEvidenceTransfer(JSON.stringify(source))) throw new Error('That source cannot be attached safely.')
  let target: string, key: string, line: string, highlight: string | null = null, highlightKey: string | null = null
  let message: string | undefined
  if (source.kind === 'file') {
    if ((dir && !source.path.startsWith(dir + '/')) || source.path.split('/').some(segment => segment === '..') || source.path.startsWith('/')) throw new Error('Choose a source inside this Folio, or attach a workspace note.')
    target = dir ? source.path.slice(dir.length + 1) : source.path
    key = evidenceKey(target)
    line = `- [${label(source.path.split('/').at(-1)!)}](${url(target)})${eol}`
    if (source.quote?.trim()) { const quote = normaliseQuote(source.quote); highlight = `  - “${quote}”${eol}`; highlightKey = 'quote:' + quote }
  } else if (source.kind === 'note') {
    target = source.title; key = evidenceKey(target, 'note'); line = `- [[${target}]]${eol}`
  } else if (source.kind === 'archive') {
    target = source.url; key = evidenceKey(target); line = `- [${label(source.title)}](${url(target)})${eol}`
  } else {
    target = source.itemTarget; key = evidenceKey(target); line = `- ${chip(source.label, target)}${eol}`
    if (source.pending) message = 'This highlight is not in Zotero yet, so its item was attached.'
    else if (source.annotation) { highlight = `  - ${chip(source.annotation.label, source.annotation.target)}${eol}`; highlightKey = evidenceKey(source.annotation.target) }
  }
  const found = existing.find(item => item.key === key)
  if (found && (!highlight || found.highlights.some(chosen => chosen.key === highlightKey))) return { op: null, message: message ?? 'That evidence is already attached.' }
  const value = found ? found.raw + (found.raw.endsWith(eol) ? '' : eol) + highlight : line + (highlight ?? '')
  return { op: { kind: 'item', part, key, expect: found?.raw ?? null, value }, ...(message ? { message } : {}) }
}
