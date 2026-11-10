// Keep a part's newer source while another Mac publishes a different part before sync arrives.
// The caller hashes a merge, then rechecks the service revision immediately before its write.
import type { PublishBody } from './share-protocol.ts'

export function retainNewerFolioParts(body: PublishBody, previous: PublishBody | null): string[] {
  if (body.kind !== 'folio' || previous?.kind !== 'folio') return []
  const older = new Map(previous.parts.flatMap((part) => part.key ? [[part.key, part] as const] : []))
  const skipped: string[] = []
  body.parts = body.parts.map((part) => {
    // An explicit missing-file placeholder has no older source save to compare. Keep the existing
    // missing-part behaviour; a stale, present file is the case guarded here.
    if (part.html === null) return part
    const held = part.key ? older.get(part.key) : null
    if (!held || held.savedAt === undefined || (part.savedAt ?? 0) > held.savedAt) return part
    if (part.html === held.html && part.title === held.title && JSON.stringify(part.headings) === JSON.stringify(held.headings)) return part
    skipped.push(part.key!)
    return held
  })
  if (body.structureKind === 'index') {
    // The folder listing decides membership. An absent part this Mac has seen was deleted;
    // an absent part it has never rendered locally may still be waiting for sync.
    const seen = new Set(body.seenPartKeys ?? [])
    const present = new Set(body.parts.map(part => part.key))
    for (const [index, part] of previous.parts.entries()) {
      if (!part.key || present.has(part.key) || seen.has(part.key)) continue
      body.parts.splice(Math.min(index, body.parts.length), 0, part)
      present.add(part.key)
      skipped.push(part.key)
      if (body.folioState && previous.folioState) {
        const entry = previous.folioState.parts.find(p => previous.folioState!.partKeys[p.path] === part.key)
        if (entry) {
          body.folioState.partKeys[entry.path] = part.key
          body.folioState.parts.splice(Math.min(index, body.folioState.parts.length), 0, entry)
        }
      }
    }
  }
  if (skipped.length) {
    const html = body.parts.map((part) => part.html ?? '').join('\n')
    body.images = [...new Set([...body.images, ...previous.images])].filter((name) => html.includes(`/images/${name}`))
    if (body.folioState && previous.folioState) {
      body.folioState.parts = body.folioState.parts.map((part) => {
        const key = body.folioState!.partKeys[part.path]
        return skipped.includes(key) ? previous.folioState!.parts.find((p) => previous.folioState!.partKeys[p.path] === key) ?? part : part
      })
    }
  }
  return skipped
}

export function publishedContent(body: PublishBody): string {
  return JSON.stringify({ kind: body.kind, title: body.title, chips: body.chips,
    parts: body.parts.map((p) => p.html === null ? { title: p.title, missing: true, headings: [] } : { title: p.title, html: p.html, headings: p.headings }), images: body.images })
}


/** A newer part save does not authorise replacing an older saved running order. */
export function hasOlderFolioStructure(body: PublishBody, previous: PublishBody | null): boolean {
  if (body.kind !== 'folio' || previous?.kind !== 'folio' || previous.structureSavedAt === undefined) return false
  if (body.structureKind === 'index') {
    // Membership changes have per-part protection. Order compares only members both Macs know.
    const key = (copy: PublishBody) => copy.parts.map(part => part.key).filter((key): key is string => !!key)
    const before = key(previous), after = key(body)
    const common = new Set(before.filter(key => after.includes(key)))
    return (body.structureSavedAt ?? 0) < previous.structureSavedAt &&
      JSON.stringify(before.filter(key => common.has(key))) !== JSON.stringify(after.filter(key => common.has(key)))
  }
  const structure = (copy: PublishBody) => JSON.stringify({ keys: copy.parts.map((part) => part.key), paths: copy.folioState?.parts.map((part) => part.path) })
  return (body.structureSavedAt ?? 0) < previous.structureSavedAt && structure(body) !== structure(previous)
}
