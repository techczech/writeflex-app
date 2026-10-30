import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { readEvidence } from '../../src/main/folio-evidence'
import { setFolioZoteroEvidenceReader, zoteroSourceQuote } from '../../src/main/folio-zotero-evidence'

let root: string | undefined
let cleanup: (() => void) | undefined
afterEach(async () => { cleanup?.(); cleanup = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined })
const target = 'zotero://select/library/items/ABCD1234'
const annotation = 'zotero://open-pdf/library/items/EFGH5678?annotation=IJKL9012'

test('chosen Zotero quotes are read live, never stored, and unavailable sources remain in the evidence file', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-zotero-evidence-')); await mixedFolio(root)
  const path = join(root, 'mixed/_mixed_EVIDENCE-AND-NOTES.md')
  const original = `## [[Results]]\n\n### Evidence\n- [⟨Smith 2025⟩](${target})\n  - [⟨Smith 2025, p. 4⟩](${annotation})\n`
  await writeFile(path, original)
  let quote = 'Live quote one.'
  cleanup = setFolioZoteroEvidenceReader(async requests => requests.map(request => ({ target: request.target, state: 'ready', label: 'Smith 2025', title: 'The study', highlights: [{ target: annotation, quote, label: 'Smith 2025, p. 4' }] })))
  const ws = new Workspace(root)
  expect((await readEvidence(ws, 'mixed')).parts.results.rows[0].highlights[0].quote).toBe('Live quote one.')
  quote = 'Changed in Zotero.'
  expect((await readEvidence(ws, 'mixed')).parts.results.rows[0].highlights[0].quote).toBe('Changed in Zotero.')
  cleanup(); cleanup = undefined
  const unavailable = (await readEvidence(ws, 'mixed')).parts.results.rows[0]
  expect(unavailable.state).toBe('Zotero not available')
  expect(unavailable.highlights).toHaveLength(1)
  expect(await readFile(path, 'utf8')).toBe(original)
})

test('attached items merge their item and annotation citations; reader notes never become quotations', async () => {
 root=await mkdtemp(join(tmpdir(),'wf-zotero-evidence-'));await mixedFolio(root)
 await writeFile(join(root,'mixed/_mixed_EVIDENCE-AND-NOTES.md'),`## [[Intro]]
### Evidence
- [Smith](${target})
  - [Reader note](${annotation})
`)
 await writeFile(join(root,'mixed/intro.md'),`# Intro

[Smith](${target}) and [Smith p.4](${annotation}).
`)
 cleanup=setFolioZoteroEvidenceReader(async requests=>requests.map(request=>({target:request.target,state:'ready',itemTarget:target,label:'Smith 2025',highlights:[{target:annotation,quote:null,bodyKind:'note',label:'Smith 2025'}]})))
 const rows=(await readEvidence(new Workspace(root),'mixed')).parts.intro.rows
 expect(rows).toHaveLength(1);expect(rows[0].origins).toEqual(['attached here','cited in the text'])
 expect(rows[0].highlights[0].quote).toBeNull();expect(rows[0].highlights[0].state).toBe('Reader note in Zotero')
})

test('empty highlight or underline text never quotes reader comments or display placeholders', () => {
 for(const type of ['highlight','underline','note','image'])for(const text of [null,'','  \n '])expect(zoteroSourceQuote({type,text})).toBeNull()
 expect(zoteroSourceQuote({type:'highlight',text:' Actual   source words. '})).toBe('Actual source words.')
})

test('an empty highlight stays attached in the merged reader without an insertable quotation', async () => {
 root=await mkdtemp(join(tmpdir(),'wf-zotero-evidence-'));await mixedFolio(root)
 await writeFile(join(root,'mixed/_mixed_EVIDENCE-AND-NOTES.md'),`## [[Intro]]\n### Evidence\n- [Smith](${target})\n  - [Highlight](${annotation})\n`)
 cleanup=setFolioZoteroEvidenceReader(async requests=>requests.map(request=>({target:request.target,state:'ready',label:'Smith 2025',highlights:[{target:annotation,quote:zoteroSourceQuote({type:'highlight',text:null}),bodyKind:'quote',label:'Smith 2025'}]})))
 const row=(await readEvidence(new Workspace(root),'mixed')).parts.intro.rows[0]
 expect(row.state).toBe('ready');expect(row.highlights).toHaveLength(1);expect(row.highlights[0].quote).toBeNull()
})
