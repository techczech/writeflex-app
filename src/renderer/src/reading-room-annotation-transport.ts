import { boundedReaderDTO, validReaderPayload } from '../../shared/reading-room-channel'

const annotationFields = ['key', 'type', 'text', 'comment', 'color', 'pageLabel', 'sortIndex', 'position', 'tags', 'isExternal', 'image']
const openFields = ['bytes', 'kind', 'annotations', 'viewState', 'document', 'citationBaseLink', 'side']

/** Imported marks retain their Zotero compare-and-set state in the parent. Only the closed
 * reader fields cross the port; inspect all input descriptors before copying any values. */
export function readerAnnotationTransport(type: string, payload: unknown): unknown {
  if (type !== 'open' && type !== 'upsert') return payload
  if (!boundedReaderDTO(payload, type === 'open')) throw new Error('Reader annotation data refused.')
  let annotations: unknown = payload
  const result: Record<string, unknown> = {}
  if (type === 'open') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Reader open data refused.')
    const descriptors = Object.getOwnPropertyDescriptors(payload)
    if (Object.keys(descriptors).length !== openFields.length || openFields.some(key => !Object.hasOwn(descriptors, key))) throw new Error('Reader open fields refused.')
    for (const key of openFields) result[key] = descriptors[key].value
    annotations = result.annotations
  }
  if (!Array.isArray(annotations)) throw new Error('Reader annotations refused.')
  const projected: Record<string, unknown>[] = []
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) throw new Error('Reader annotation refused.')
    const descriptors = Object.getOwnPropertyDescriptors(annotation)
    const mark: Record<string, unknown> = {}
    for (const key of Object.keys(descriptors)) {
      if (key === 'zoteroState') continue
      if (!annotationFields.includes(key)) throw new Error('Reader annotation field refused.')
      const value: unknown = descriptors[key].value
      // Copy the tag array too: a subsequent parent refresh cannot mutate an in-flight payload.
      mark[key] = key === 'tags' && Array.isArray(value) ? Array.from(value) : value
    }
    projected.push(mark)
  }
  const transport = type === 'open' ? result : projected
  if (type === 'open') result.annotations = projected
  if (!validReaderPayload(type, transport)) throw new Error('Reader annotation schema refused.')
  return transport
}
