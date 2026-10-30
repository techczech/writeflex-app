/** A read-only view supplied by the existing Reading Room library owner. No independent database or writer. */
export type FolioZoteroRequest = { target: string; highlights: string[] }
export type FolioZoteroFact = { target: string; state: 'ready' | 'Zotero not available' | 'not found in Zotero'; label?: string; title?: string; itemTarget?: string; highlights: Array<{ target: string; quote: string | null; label: string; bodyKind?: 'quote' | 'note' | 'mark' }> }
export type FolioZoteroReader = (requests: FolioZoteroRequest[]) => Promise<FolioZoteroFact[]>
let reader: FolioZoteroReader | null = null
export function setFolioZoteroEvidenceReader(next: FolioZoteroReader): () => void {
  reader = next
  return () => { if (reader === next) reader = null }
}
export async function readFolioZoteroEvidence(requests: FolioZoteroRequest[]): Promise<FolioZoteroFact[]> {
  if (!requests.length) return []
  try { if (reader) return await reader(requests) } catch { /* Retain stored references when the library is unavailable. */ }
  return requests.map(request => ({ target: request.target, state: 'Zotero not available', highlights: [] }))
}

/** Display fallbacks and reader comments are never words quoted from the source. */
export function zoteroSourceQuote(annotation: { type: string; text: string | null }): string | null {
 if (!['highlight','underline'].includes(annotation.type)) return null
 return annotation.text?.replace(/\s+/g,' ').trim() || null
}
