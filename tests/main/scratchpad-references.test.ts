import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { attachCanonicalReference, collectCanonicalSource, prepareCanonicalReference, readCanonicalSources, undoCanonicalAttach } from '../../src/main/scratchpad-references'
import { evidencePath } from '../../src/main/folio-evidence'
import { setFolioZoteroEvidenceReader } from '../../src/main/folio-zotero-evidence'
import { documentAssets, documentAssetsProjected, assetStillCurrent } from '../../src/shared/scratchpad-inventory'
import { scratchpadReferenceVerbs } from '../../src/main/verbs/scratchpad-references'
import { prepareBoundInsert, executeBoundInsert } from '../../src/main/scratchpad-agent-insert'
import { pangramFolio } from '../fixtures/folio-room/folio-room-fixtures'

// Ticket 03: canonical Folio evidence projected as Reference/Evidence candidates. Synthetic
// Zotero/archive shapes only — the Zotero reader below is a fixture, never a live account.

const ANNOTATION = 'zotero://open-pdf/library/items/EFGH5678?annotation=IJKL9012'
const ZOTERO_ITEM = 'zotero://select/library/items/ABCD1234'
const QUOTE = 'A quoted sentence from the note.'

let root: string
let ws: Workspace
let store: ScratchpadStore
let releaseReader: (() => void) | null

const EVIDENCE = [
  'WriteFlex keeps the evidence and notes for each part of this Folio here. Each ## heading names one part.',
  '',
  '## [[Summary]]',
  '',
  '### Evidence',
  '- [lea-street-1998.md](research/lea-street-1998.md)',
  `  - “${QUOTE}”`,
  `- [⟨Lea and Street 1998⟩](${ZOTERO_ITEM})`,
  `  - [⟨Lea and Street 1998, p. 157⟩](${ANNOTATION})`,
  '- [Synthetic archive piece](https://example.test/piece)',
  '',
].join('\n')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-scratch-refs-'))
  await pangramFolio(root)
  await writeFile(join(root, 'pangram/research/lea-street-1998.md'), `---\nauthor: Lea and Street\nyear: 1998\n---\n\n# Academic literacies\n\n${QUOTE} More text follows.\n`)
  ws = new Workspace(root)
  store = new ScratchpadStore(ws, null)
  await writeFile(join(root, evidencePath({ root, folioDir: 'pangram' })), EVIDENCE)
  releaseReader = setFolioZoteroEvidenceReader(async (requests) => requests.map((request) => ({
    target: request.target, state: 'ready' as const, label: 'Lea and Street 1998', title: 'Student Writing in Higher Education',
    highlights: request.highlights.map((target) => ({ target, quote: 'Words highlighted in the reader.', label: 'Lea and Street 1998, p. 157' })),
  })))
})
afterEach(async () => { releaseReader?.(); releaseReader = null; await rm(root, { recursive: true, force: true }) })

const SUMMARY = 'pangram/contents/01-summary.md'
const DETAILS = 'pangram/contents/02-report.md'
const evidenceFile = (): Promise<string> => readFile(join(root, evidencePath({ root, folioDir: 'pangram' })), 'utf8')

test('canonical sources project typed Reference and Evidence cards; reading and collecting leave the records byte-identical', async () => {
  const before = await evidenceFile()
  const { sources, notices } = await readCanonicalSources(ws, store, SUMMARY)
  expect(notices).toEqual([])
  const refs = sources.filter((s) => s.kind === 'ref')
  const evs = sources.filter((s) => s.kind === 'evidence')
  expect(refs.map((s) => s.ref.evidenceKind).sort()).toEqual(['archive', 'file', 'zotero'])
  const file = refs.find((s) => s.ref.evidenceKind === 'file')!
  expect(file.ref.citationId).toBe('path:pangram/research/lea-street-1998.md')
  expect(file.ref.label).toBe('Lea and Street 1998')
  expect(file.ref.attachedParts).toEqual(['Summary'])
  expect(file.ref.sourcePart).toBe('Summary')
  const zotero = refs.find((s) => s.ref.evidenceKind === 'zotero')!
  expect(zotero.ref.sourceTitle).toBe('Student Writing in Higher Education')
  expect(zotero.ref.citationId).toBe('zotero:library/ABCD1234')
  expect(evs).toHaveLength(2)
  expect(evs.find((s) => s.ref.evidenceKind === 'file')!.ref.quote).toBe(QUOTE)
  const zoteroEv = evs.find((s) => s.ref.evidenceKind === 'zotero')!
  expect(zoteroEv.ref.quote).toBe('Words highlighted in the reader.')
  expect(zoteroEv.ref.highlightTarget).toBe(ANNOTATION)
  expect(zoteroEv.ref.highlightLabel).toBe('Lea and Street 1998, p. 157')

  const collected = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: file.sourceId })
  expect(collected.kind).toBe('ref')
  expect(collected.ref?.sourceId).toBe(file.sourceId)
  const again = await collectCanonicalSource(ws, store, { activePath: DETAILS, sourceId: file.sourceId })
  expect(again.id).toBe(collected.id) // one candidate, wherever it is collected from
  const snapshot = await store.list({ activePath: DETAILS })
  expect(snapshot.groups.map((g) => g.name)).toContain('References')
  expect(snapshot.items.find((i) => i.id === collected.id)!.group).toBe(snapshot.groups.find((g) => g.name === 'References')!.id)
  const after = await readCanonicalSources(ws, store, DETAILS)
  expect(after.sources.find((s) => s.sourceId === file.sourceId)!.collectedId).toBe(collected.id)
  expect(await evidenceFile()).toBe(before) // canonical record untouched by read + collect
  expect(await readFile(join(root, 'pangram/research/lea-street-1998.md'), 'utf8')).toContain(QUOTE)
})

test('prepare writes the canonical chip, link and quote for the destination part; archive cite refuses as a link in disguise', async () => {
  const { sources } = await readCanonicalSources(ws, store, SUMMARY)
  const fileRef = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: sources.find((s) => s.ref.evidenceKind === 'file')!.sourceId })
  const cite = await prepareCanonicalReference(ws, store, { id: fileRef.id, action: 'cite', destination: DETAILS })
  expect(cite).toEqual({ markdown: '[⟨Lea and Street 1998⟩](../research/lea-street-1998.md)', style: 'inline', label: 'Lea and Street 1998' })
  const link = await prepareCanonicalReference(ws, store, { id: fileRef.id, action: 'link', destination: DETAILS })
  expect(link.markdown).toBe('[lea-street-1998.md](../research/lea-street-1998.md)')
  const ev = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: sources.find((s) => s.kind === 'evidence' && s.ref.evidenceKind === 'file')!.sourceId })
  const quote = await prepareCanonicalReference(ws, store, { id: ev.id, action: 'quote', destination: DETAILS })
  expect(quote.markdown).toBe(`> “${QUOTE}”\n>\n> [⟨Lea and Street 1998⟩](../research/lea-street-1998.md)`)
  expect(quote.style).toBe('block')
  const zoteroEv = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: sources.find((s) => s.kind === 'evidence' && s.ref.evidenceKind === 'zotero')!.sourceId })
  const zQuote = await prepareCanonicalReference(ws, store, { id: zoteroEv.id, action: 'quote', destination: SUMMARY })
  expect(zQuote.markdown).toContain(`[⟨Lea and Street 1998, p. 157⟩](${ANNOTATION})`)
  const archive = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: sources.find((s) => s.ref.evidenceKind === 'archive')!.sourceId })
  await expect(prepareCanonicalReference(ws, store, { id: archive.id, action: 'cite', destination: DETAILS })).rejects.toThrow('linked, not cited')
  const archiveLink = await prepareCanonicalReference(ws, store, { id: archive.id, action: 'link', destination: DETAILS })
  expect(archiveLink.markdown).toBe('[Synthetic archive piece](https://example.test/piece)')
  // The generic insert never writes a reference's preview into a document.
  expect(await store.prepareInsert(fileRef.id, DETAILS)).toMatchObject({ ok: false })
  expect(await store.prepareInsert(ev.id, DETAILS)).toMatchObject({ ok: false })
})

test('attach goes through the evidence operation with checkpoint and token Undo; wrong part and stale source refuse byte-identical', async () => {
  const { sources } = await readCanonicalSources(ws, store, SUMMARY)
  const zotero = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: sources.find((s) => s.ref.evidenceKind === 'zotero')!.sourceId })
  const before = await evidenceFile()
  // A destination that is not a Folio part refuses, and writes nothing.
  await expect(attachCanonicalReference(ws, store, { id: zotero.id, destination: 'pangram/research/lea-street-1998.md' }, { session: 't' })).rejects.toThrow('not a part of this Folio')
  expect(await evidenceFile()).toBe(before)
  let checkpoints = 0
  const attached = await attachCanonicalReference(ws, store, { id: zotero.id, destination: DETAILS }, { session: 't', checkpoint: async () => { checkpoints++ } })
  expect(attached.part).toBe('Details')
  expect(attached.token).toStartWith('ev:')
  expect(checkpoints).toBe(1)
  const during = await evidenceFile()
  expect(during).toContain('## [[Details]]')
  expect(during).toContain(ZOTERO_ITEM)
  const refreshed = await store.get(zotero.id)
  expect(refreshed.ref?.attachedParts?.sort()).toEqual(['Details', 'Summary'])
  // Attaching again is the operation's own refusal, not a second entry.
  await expect(attachCanonicalReference(ws, store, { id: zotero.id, destination: DETAILS }, { session: 't' })).rejects.toThrow('already attached')
  const undone = await undoCanonicalAttach(ws, store, { id: zotero.id, token: attached.token!, destination: DETAILS }, { session: 't' })
  expect(undone.message).toContain('Undone')
  expect(await evidenceFile()).toBe(before)
  expect((await store.get(zotero.id)).ref?.attachedParts).toEqual(['Summary'])
})

test('a deleted source and a vanished evidence entry refuse recoverably; the candidate is kept', async () => {
  const { sources } = await readCanonicalSources(ws, store, SUMMARY)
  const fileRef = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: sources.find((s) => s.ref.evidenceKind === 'file')!.sourceId })
  await unlink(join(root, 'pangram/research/lea-street-1998.md'))
  await expect(prepareCanonicalReference(ws, store, { id: fileRef.id, action: 'cite', destination: DETAILS })).rejects.toThrow('not at its last known place')
  await writeFile(join(root, 'pangram/research/lea-street-1998.md'), `# Back\n\n${QUOTE}\n`)
  await writeFile(join(root, evidencePath({ root, folioDir: 'pangram' })), 'WriteFlex keeps the evidence and notes for each part of this Folio here. Each ## heading names one part.\n')
  await expect(prepareCanonicalReference(ws, store, { id: fileRef.id, action: 'cite', destination: DETAILS })).rejects.toThrow('not in the Folio\'s evidence any more')
  const kept = await store.get(fileRef.id)
  expect(kept.ref?.citationId).toBe('path:pangram/research/lea-street-1998.md')
})

test('agent verbs keep the postures: collect and attach direct, cite/quote proposals that stage-validate the canonical source', async () => {
  const verbs = scratchpadReferenceVerbs(ws, null)
  const byId = new Map(verbs.map((v) => [v.id, v]))
  expect(byId.get('scratchpad.collect')!.posture).toBe('direct')
  expect(byId.get('scratchpad.attach_evidence')!.posture).toBe('direct')
  for (const id of ['scratchpad.cite', 'scratchpad.link', 'scratchpad.insert_quote']) expect(byId.get(id)!.posture).toBe('proposal')
  const listed = await byId.get('scratchpad.sources')!.run({} as never, { path: SUMMARY })
  const sources = (listed as { details: { sources: Array<{ sourceId: string; kind: string; ref: { evidenceKind: string } }> } }).details.sources
  const collectedReply = await byId.get('scratchpad.collect')!.run({} as never, { path: SUMMARY, sourceId: sources.find((s) => s.kind === 'evidence' && s.ref.evidenceKind === 'file')!.sourceId })
  const itemId = (collectedReply as { details: { item: { id: string; by: string } } }).details.item.id
  expect((collectedReply as { details: { item: { by: string } } }).details.item.by).toBe('agent')
  const stage = await byId.get('scratchpad.insert_quote')!.validateStage!({ id: itemId, path: DETAILS, insertAfter: '' } as never)
  expect(stage.decision).toBe('pass')
  const detailsBefore = await readFile(join(root, DETAILS), 'utf8')
  // A proposal verb never writes on its own (ticket 04 bound proposals): without the frozen proof
  // of the Change being accepted, run refuses and the document is untouched. The bound accept
  // itself is covered in scratchpad-agent-insert.test.ts.
  const ran = await byId.get('scratchpad.insert_quote')!.run({} as never, { id: itemId, path: DETAILS, insertAfter: '' })
  expect((ran as { text: string }).text).toContain('no reviewed text on record in this session')
  expect(await readFile(join(root, DETAILS), 'utf8')).toBe(detailsBefore)
  const badStage = await byId.get('scratchpad.cite')!.validateStage!({ id: 'p_missing99', path: DETAILS, insertAfter: 'x' } as never)
  expect(badStage.decision).toBe('deny')
})

test('inventory groups cited references by canonical citation id with exact ranges, also under Reviewing projection', () => {
  const chipZ = `[⟨Lea and Street 1998⟩](${ZOTERO_ITEM})`
  const chipF = '[⟨Lea and Street 1998⟩](../research/lea-street-1998.md)'
  const doc = `# Details\n\nFirst ${chipZ} and again ${chipZ}.\n\nAlso ${chipF} here.\n\nAn ordinary [link](../research/lea-street-1998.md) is not a citation.\n`
  const items = documentAssets(DETAILS, doc, 'disk').filter((i) => i.kind === 'ref')
  expect(items).toHaveLength(2)
  const zotero = items.find((i) => i.ref?.evidenceKind === 'zotero')!
  expect(zotero.ref?.citationId).toBe('zotero:library/ABCD1234')
  expect(zotero.cited?.count).toBe(2)
  expect(zotero.cited?.positions.map((p) => doc.slice(p.from, p.to))).toEqual([chipZ, chipZ])
  expect(zotero.cited?.positions[0].line).toBe(3)
  const file = items.find((i) => i.ref?.evidenceKind === 'file')!
  expect(file.ref?.citationId).toBe('path:pangram/research/lea-street-1998.md')
  expect(file.cited?.count).toBe(1)
  // Reviewing: a pending replacement before the citations; positions report in RAW coordinates.
  const raw = doc.replace('First', 'OLDWORD SFirst')
  const removed = [{ from: raw.indexOf('OLDWORD'), to: raw.indexOf('OLDWORD') + 'OLDWORD '.length }]
  const projected = documentAssetsProjected(DETAILS, raw, 'live', removed).filter((i) => i.kind === 'ref')
  const pz = projected.find((i) => i.ref?.evidenceKind === 'zotero')!
  expect(pz.cited?.positions.map((p) => raw.slice(p.from, p.to))).toEqual([chipZ, chipZ])
  expect(pz.id).toBe(zotero.id)
  // Show-in-document revalidation is by exact recorded range, never by matching prose.
  const second = { ...pz, markdown: pz.cited!.positions[1].markdown, document: { ...pz.document!, ...pz.cited!.positions[1] } }
  expect(assetStillCurrent(second, { raw, removedSpans: removed })).toBe(true)
  const shifted = { ...second, document: { ...second.document!, from: second.document!.from + 1, to: second.document!.to + 1 } }
  expect(assetStillCurrent(shifted, { raw, removedSpans: removed })).toBe(false)
})

test('agent reference proposals preserve an external edit after their destination read', async () => {
  const sources = await readCanonicalSources(ws, store, SUMMARY)
  const ev = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: sources.sources.find(source => source.kind === 'evidence' && source.ref.evidenceKind === 'file')!.sourceId })
  // Bound at staging (ticket 04): the destination the writer reviewed is frozen with the proposal.
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert_quote', { id: ev.id, path: DETAILS, insertAfter: '' })
  const external = '# Details\n\nAn intervening edit must survive.\n'
  await writeFile(join(root, DETAILS), external) // another writer, after the proposal was staged
  await expect(executeBoundInsert(ws, store, bound, null)).rejects.toThrow('changed since this proposal was made')
  expect(await readFile(join(root, DETAILS), 'utf8')).toBe(external)
  // And the verb alone, without an accept's frozen proof, writes nothing either.
  const verb = scratchpadReferenceVerbs(ws, null).find(candidate => candidate.id === 'scratchpad.insert_quote')!
  const result = await verb.run({} as never, { id: ev.id, path: DETAILS, insertAfter: '' })
  expect(result).toMatchObject({ isError: true })
  expect(await readFile(join(root, DETAILS), 'utf8')).toBe(external)
})


test('collected file reference and evidence keep working after their source is renamed', async () => {
  const sources = (await readCanonicalSources(ws, store, SUMMARY)).sources
  const picked = sources.filter(source => source.ref.evidenceKind === 'file')
  const kept = await Promise.all(picked.map(source => collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: source.sourceId })))
  const originalPayloads = kept.map(item => item.markdown)
  const oldPath = 'pangram/research/lea-street-1998.md'
  const newPath = 'pangram/research/renamed-study.md'
  await rename(join(root, oldPath), join(root, newPath))
  await writeFile(join(root, evidencePath({ root, folioDir: 'pangram' })), EVIDENCE.replaceAll('research/lea-street-1998.md', 'research/renamed-study.md'))
  await writeFile(join(root, DETAILS), '# Details\n')
  await store.followRename(oldPath, newPath)
  for (let at = 0; at < kept.length; at++) {
    const item = await store.get(kept[at].id)
    expect(item.markdown).toBe(originalPayloads[at])
    expect(item.ref?.citationId).toBe(`path:${newPath}`)
    const prepared = await prepareCanonicalReference(ws, store, { id: item.id, action: item.kind === 'evidence' ? 'quote' : 'cite', destination: DETAILS })
    expect(prepared.markdown).toContain('../research/renamed-study.md')
    const again = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: item.ref!.sourceId })
    expect(again.id).toBe(item.id)
  }
})
