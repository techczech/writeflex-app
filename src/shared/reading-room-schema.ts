import { readerByteLength } from './reading-room-bytes'
import type { ReaderAnnotation, ReaderSelectionAnnotation, ReaderLiveness } from '@readflex/reader-embed'

export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const text = (v: unknown, max = 1024 * 1024): v is string => typeof v === 'string' && v.length <= max
const nullableText = (v: unknown): boolean => v === null || text(v)
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const scale = (v: unknown): boolean => (finite(v) && v > 0) || (typeof v === 'string' && (/^(auto|page-actual|page-fit|page-width)$/.test(v) || (/^\d+(?:\.\d+)?$/.test(v) && Number(v) > 0 && v.length <= 24)))
export function readerViewState(v: unknown): v is Record<string, unknown> {
  if (!record(v)) return false
  // The primary reader appends this field even with read-aloud disabled by the host.
  if (Object.hasOwn(v, 'lastReadAloudPosition') && v.lastReadAloudPosition !== null) return false
  const keys = Object.keys(v)
  if (Object.hasOwn(v, 'pageIndex')) return keys.every(k => ['pageIndex','scale','top','left','scrollMode','spreadMode','lastReadAloudPosition'].includes(k))
    && integer(v.pageIndex) && (!Object.hasOwn(v, 'scale') || scale(v.scale))
    && ['top','left'].every(k => !Object.hasOwn(v, k) || finite(v[k]))
    && (!Object.hasOwn(v, 'scrollMode') || (integer(v.scrollMode) && v.scrollMode <= 3))
    && (!Object.hasOwn(v, 'spreadMode') || (integer(v.spreadMode) && v.spreadMode <= 2))
  return exact(v, ['scale','scrollYPercent','appearance', ...(Object.hasOwn(v, 'lastReadAloudPosition') ? ['lastReadAloudPosition'] : [])]) && finite(v.scale) && v.scale > 0
    && finite(v.scrollYPercent) && v.scrollYPercent >= 0 && v.scrollYPercent <= 100
    && record(v.appearance) && exact(v.appearance, ['lineHeight','wordSpacing','letterSpacing','pageWidth','useOriginalFont'])
    && ['lineHeight','wordSpacing','letterSpacing'].every(k => finite((v.appearance as Record<string, unknown>)[k]))
    && [-1,0,1].includes(Number(v.appearance.pageWidth)) && typeof v.appearance.pageWidth === 'number' && typeof v.appearance.useOriginalFont === 'boolean'
}
export function readerAnnotation(v: unknown): v is ReaderAnnotation {
  return record(v) && exact(v, ['key','type','text','comment','color','pageLabel','sortIndex','position','tags','isExternal', ...(Object.hasOwn(v, 'image') ? ['image'] : [])])
    && text(v.key, 256) && v.key.length > 0 && typeof v.type === 'string' && ['highlight','note','image','ink','underline','text'].includes(v.type)
    && ['text','comment','color','pageLabel'].every(k => nullableText(v[k])) && text(v.sortIndex, 4096) && text(v.position)
    && Array.isArray(v.tags) && v.tags.length <= 1000 && v.tags.every(t => text(t, 4096)) && typeof v.isExternal === 'boolean'
    && (!Object.hasOwn(v, 'image') || v.image === null || text(v.image, 8 * 1024 * 1024))
}
export function readerSelectionAnnotation(v: unknown): v is ReaderSelectionAnnotation {
  return record(v) && exact(v, ['type','text','color','pageLabel','sortIndex','position']) && v.type === 'highlight'
    && ['text','color','pageLabel'].every(k => nullableText(v[k])) && text(v.sortIndex, 4096) && text(v.position)
}
export function readerLiveness(v: unknown): v is ReaderLiveness {
  return record(v) && exact(v, ['activeViewInitialised','canvas','page','pageCount']) && v.activeViewInitialised === true
    && (v.canvas === null || (record(v.canvas) && exact(v.canvas, ['height','width']) && integer(v.canvas.height) && integer(v.canvas.width)))
    && (v.page === null || integer(v.page, 1)) && (v.pageCount === null || integer(v.pageCount, 1))
    && (v.page === null || v.pageCount === null || Number(v.page) <= Number(v.pageCount))
}
export function readerSnapshot(v: unknown): boolean {
  return record(v) && exact(v, ['liveness','viewState']) && readerLiveness(v.liveness) && (v.viewState === null || readerViewState(v.viewState))
}
/** Called only after the descriptor-safe DTO gate, including for replies. */
export function readerPayload(type: string, v: unknown): boolean {
  if (['live','dispose','mark-mode-cancelled'].includes(type)) return v === null
  if (type === 'side') return v === 'left' || v === 'right'
  if (type === 'error') return text(v, 4096)
  if (['annotation-created','annotation-updated','annotation-deleted'].includes(type)) return readerAnnotation(v)
  if (type === 'upsert') return Array.isArray(v) && v.length <= 1000 && v.every(readerAnnotation)
  if (type === 'tool') return record(v) && Object.hasOwn(v, 'type') && Object.keys(v).every(k => k === 'type' || k === 'color')
    && typeof v.type === 'string' && ['pointer','highlight','image'].includes(v.type) && (!Object.hasOwn(v, 'color') || text(v.color, 128))
  if (type === 'navigate') return record(v) && Object.keys(v).length === 1 && ((Object.hasOwn(v, 'position') && text(v.position)) || (Object.hasOwn(v, 'annotationKey') && text(v.annotationKey, 256)) || (Object.hasOwn(v, 'page') && integer(v.page, 1)))
  if (type === 'position' || type === 'view-state-changed') return readerViewState(v)
  if (type === 'host-chord') return record(v) && exact(v, ['altKey','code','ctrlKey','key','metaKey','shiftKey']) && ['altKey','ctrlKey','metaKey','shiftKey'].every(k => typeof v[k] === 'boolean') && text(v.key, 64) && text(v.code, 64)
  if (type === 'selection') return v === null || (record(v) && exact(v, ['annotation','text','pageLabel','pageIndex','pageLink']) && text(v.text) && text(v.pageLink, 4096) && nullableText(v.pageLabel) && (v.pageIndex === null || integer(v.pageIndex)) && (v.annotation === null || readerSelectionAnnotation(v.annotation)))
  if (type !== 'open' || !record(v) || !exact(v, ['bytes','kind','annotations','viewState','document','citationBaseLink','side'])) return false
  return (readerByteLength(v.bytes) ?? 0) > 0 && (v.kind === 'pdf' || v.kind === 'snapshot')
    && Array.isArray(v.annotations) && v.annotations.length <= 10000 && v.annotations.every(readerAnnotation)
    && (v.viewState === null || readerViewState(v.viewState)) && text(v.citationBaseLink, 4096) && (v.side === 'left' || v.side === 'right')
    && record(v.document) && exact(v.document, ['attachmentKey','authorYear','itemKey','libraryId','shortTitle'])
    && ['attachmentKey','authorYear','itemKey','shortTitle'].every(k => text((v.document as Record<string, unknown>)[k], 4096)) && integer(v.document.libraryId)
}

/** Copy only data descriptors from the actual reader realms supplied by the host. No getter,
 * toJSON or prototype coercion runs, and the result still has to satisfy the closed state schema. */
export function copyReaderViewState(value: unknown, prototypes: readonly object[]): Record<string, unknown> {
  const seen = new Set<object>()
  const copy = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'string' && v.length > 4096) throw new Error('Reader view state is too large.')
      if (v !== null && !['number','string','boolean'].includes(typeof v)) throw new Error('Reader view state is not data.')
      return v
    }
    if (depth > 3 || seen.has(v) || ![Object.prototype, null, ...prototypes].includes(Object.getPrototypeOf(v))) throw new Error('Reader view state prototype refused.')
    seen.add(v)
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors)
    if (keys.length > 8) throw new Error('Reader view state has too many fields.')
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key)) throw new Error('Reader view state key refused.')
      const d = descriptors[key]
      if (!('value' in d) || !d.enumerable) throw new Error('Reader view state descriptor refused.')
      result[key] = copy(d.value, depth + 1)
    }
    seen.delete(v); return result
  }
  const result = copy(value, 0)
  if (!readerViewState(result)) throw new Error('Reader view state schema refused.')
  return result
}

export type ReaderDataRealm = { object: object; array: object }
/** Trusted adapter output only. Copy data descriptors from exact live reader realms, then enforce
 * the existing closed output schema. Port inputs keep their independent local-only DTO gate. */
export function copyReaderOutput(type: string, value: unknown, realms: readonly ReaderDataRealm[]): unknown {
  if (!['annotation-created','annotation-updated','annotation-deleted','view-state-changed','host-chord','mark-mode-cancelled','selection','error','snapshot'].includes(type)) throw new Error('Reader output type refused.')
  let budget = 24 * 1024 * 1024
  const seen = new Set<object>()
  const copy = (v: unknown, depth: number): unknown => {
    if (depth > 24 || (budget -= 8) < 0) throw new Error('Reader output budget refused.')
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      if ((budget -= v.length * 2) < 0) throw new Error('Reader output budget refused.')
      return v
    }
    if (!v || typeof v !== 'object' || seen.has(v)) throw new Error('Reader output data refused.')
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v)
    if (array ? ![Array.prototype, ...realms.map(r => r.array)].includes(proto)
      : ![Object.prototype, null, ...realms.map(r => r.object)].includes(proto)) throw new Error('Reader output realm refused.')
    seen.add(v)
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors)
    if (keys.length > 10000) throw new Error('Reader output fields refused.')
    const length = array ? descriptors.length?.value : null
    if (array && (!Number.isSafeInteger(length) || length < 0 || length > 10000 || keys.length !== length + 1)) throw new Error('Reader output array refused.')
    const result: Record<string, unknown> | unknown[] = array ? [] : {}
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key)
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new Error('Reader output key refused.')
      const descriptor = descriptors[key]
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('Reader output descriptor refused.')
      if ((budget -= key.length * 2) < 0) throw new Error('Reader output budget refused.')
      ;(result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1)
    }
    seen.delete(v)
    return result
  }
  const result = copy(value, 0)
  if (!(type === 'snapshot' ? readerSnapshot(result) : readerPayload(type, result))) throw new Error('Reader output schema refused.')
  return result
}
