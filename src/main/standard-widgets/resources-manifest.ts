/**
 * The Folio manifest's `resources` declaration (contracts §1), written surgically: only the bytes of the
 * `resources` value change; every other byte of the manifest, and every item already declared, is kept exactly as
 * it was. A rewrite that would alter a carried value (a number past 2^53, a key written twice) is refused
 * (`firstLossyCarriedKey`), and the result is parsed back and compared with what was meant before it is used.
 * Pure text in, text out; the caller writes it (only over the bytes it read).
 */
import { jsonObjectPropertyRange, jsonValueRangeEnd } from '../json-array-layout'
import { firstLossyCarriedKey } from '../lossless-json'

export type ResourceCapture = { sha256: string; bytes: number; media_type: string; captured_at: string }
export type ResourceItem = { id: string; path: string; inclusion: 'copy' | 'sync'; grant?: string; capture: ResourceCapture }

/** The manifest cannot take the change; nothing is written. */
export class ResourcesManifestRefused extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function lineIndentBefore(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  return /^[ \t]*/.exec(source.slice(lineStart, index))?.[0] ?? ''
}
function lastNonSpaceBefore(source: string, index: number): number {
  let at = index - 1
  while (at >= 0 && /\s/.test(source[at])) at -= 1
  return at
}
function firstNonSpaceFrom(source: string, index: number): number {
  let at = index
  while (at < source.length && /\s/.test(source[at])) at += 1
  return at
}
const indented = (value: unknown, indent: string): string => JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`)

function parsedManifest(source: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new ResourcesManifestRefused('The Folio manifest is not valid JSON, so nothing was added to it.') }
  if (!isObject(parsed)) throw new ResourcesManifestRefused('The Folio manifest is not a JSON object, so nothing was added to it.')
  return parsed
}

/** The declared items, or null when there is no `resources` key; throws when it is not the §1 shape. */
export function declaredResourceItems(source: string): Array<Record<string, unknown>> | null {
  const parsed = parsedManifest(source)
  if (!Object.hasOwn(parsed, 'resources')) return null
  const resources = parsed.resources
  if (!isObject(resources) || !Array.isArray(resources.items)) throw new ResourcesManifestRefused('The Folio manifest\'s resources are not in a form WriteFlex can add to, so nothing was added.')
  return resources.items.map((item) => (isObject(item) ? item : {}))
}

/** The check every rewrite passes: the text parses to exactly `expected`, and no carried top-level value is lost. */
function checked(source: string, parsed: Record<string, unknown>, next: string, resources: unknown): string {
  const expected = { ...parsed, resources }
  const lossy = firstLossyCarriedKey(source, parsed, expected)
  if (lossy !== null) throw new ResourcesManifestRefused(`The Folio manifest's ${lossy} would not be kept exactly, so nothing was added to it.`)
  let reread: unknown
  try { reread = JSON.parse(next) } catch { throw new ResourcesManifestRefused('The Folio manifest could not be rewritten exactly, so nothing was added to it.') }
  if (JSON.stringify(reread) !== JSON.stringify(expected)) throw new ResourcesManifestRefused('The Folio manifest could not be rewritten exactly, so nothing was added to it.')
  return next
}

/** `source` with `item` appended to `resources.items` (the `resources` key made, version 1, when there is none). */
export function addResourceItemText(source: string, item: ResourceItem): string {
  const parsed = parsedManifest(source)
  let range: { valueStart: number; valueEnd: number } | null
  try { range = jsonObjectPropertyRange(source, 'resources') } catch { throw new ResourcesManifestRefused('The Folio manifest declares resources twice, so nothing was added to it.') }
  if (range === null) {
    if (Object.hasOwn(parsed, 'resources')) throw new ResourcesManifestRefused('The Folio manifest could not be read exactly, so nothing was added to it.')
    const resources = { version: 1, items: [item] }
    const close = jsonValueRangeEnd(source, 0) - 1
    const last = lastNonSpaceBefore(source, close)
    const hasKeys = Object.keys(parsed).length > 0
    const firstKey = firstNonSpaceFrom(source, firstNonSpaceFrom(source, 0) + 1)
    const indent = hasKeys ? lineIndentBefore(source, firstKey) || '  ' : '  '
    const next = `${source.slice(0, last + 1)}${hasKeys ? ',' : ''}\n${indent}"resources": ${indented(resources, indent)}${hasKeys ? '' : '\n'}${source.slice(last + 1)}`
    return checked(source, parsed, next, resources)
  }
  declaredResourceItems(source)
  const items = (parsed.resources as { items: unknown[] }).items
  let itemsRange: { valueStart: number; valueEnd: number } | null
  try { itemsRange = jsonObjectPropertyRange(source, 'items', range.valueStart) } catch { throw new ResourcesManifestRefused('The Folio manifest lists its resources twice, so nothing was added to it.') }
  if (itemsRange === null || source[itemsRange.valueStart] !== '[') throw new ResourcesManifestRefused('The Folio manifest could not be read exactly, so nothing was added to it.')
  const open = itemsRange.valueStart
  const close = itemsRange.valueEnd - 1
  const last = lastNonSpaceBefore(source, close)
  const closeIndent = lineIndentBefore(source, close)
  let next: string
  if (last === open) {
    const entryIndent = `${lineIndentBefore(source, open)}  `
    next = `${source.slice(0, open + 1)}\n${entryIndent}${indented(item, entryIndent)}\n${lineIndentBefore(source, open)}${source.slice(close)}`
  } else {
    const first = firstNonSpaceFrom(source, open + 1)
    const entryIndent = source.lastIndexOf('\n', first) > open ? lineIndentBefore(source, first) : `${closeIndent}  `
    next = `${source.slice(0, last + 1)},\n${entryIndent}${indented(item, entryIndent)}${source.slice(last + 1)}`
  }
  const resources = { ...(parsed.resources as Record<string, unknown>), items: [...items, item] }
  return checked(source, parsed, next, resources)
}

/** `source` with the `capture` of item `id` replaced (contracts §1: updated only when the cached bytes change). */
export function setResourceItemCaptureText(source: string, id: string, capture: ResourceCapture): string {
  const parsed = parsedManifest(source)
  if (declaredResourceItems(source) === null) throw new ResourcesManifestRefused('The Folio manifest declares no resources.')
  const items = (parsed.resources as { items: unknown[] }).items
  const at = items.flatMap((item, index) => (isObject(item) && item.id === id ? [index] : []))
  if (at.length !== 1) throw new ResourcesManifestRefused(`The Folio manifest does not declare ${id} exactly once.`)
  const range = jsonObjectPropertyRange(source, 'resources')!
  const itemsRange = jsonObjectPropertyRange(source, 'items', range.valueStart)!
  // The entries of the items array, in order.
  let cursor = itemsRange.valueStart + 1
  let entry: { start: number; end: number } | null = null
  for (let index = 0; index <= at[0]; index += 1) {
    cursor = firstNonSpaceFrom(source, cursor)
    if (source[cursor] === ',') cursor = firstNonSpaceFrom(source, cursor + 1)
    const end = jsonValueRangeEnd(source, cursor)
    if (index === at[0]) entry = { start: cursor, end }
    cursor = end
  }
  if (entry === null || source[entry.start] !== '{') throw new ResourcesManifestRefused(`The Folio manifest's ${id} could not be read exactly.`)
  const captureRange = jsonObjectPropertyRange(source, 'capture', entry.start)
  const value = JSON.stringify(capture)
  let next: string
  if (captureRange) next = `${source.slice(0, captureRange.valueStart)}${value}${source.slice(captureRange.valueEnd)}`
  else {
    const last = lastNonSpaceBefore(source, entry.end - 1)
    next = `${source.slice(0, last + 1)}, "capture": ${value}${source.slice(last + 1)}`
  }
  const nextItems = items.map((item, index) => (index === at[0] ? { ...(item as Record<string, unknown>), capture } : item))
  return checked(source, parsed, next, { ...(parsed.resources as Record<string, unknown>), items: nextItems })
}
