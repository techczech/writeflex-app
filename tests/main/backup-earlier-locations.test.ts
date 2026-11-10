import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { appendFileSync, chmodSync, existsSync, linkSync, symlinkSync } from 'node:fs'
import { appendHistoryApproval, loadHistoryApprovals } from '../../src/backup-helper/history-approvals'
import { historySeams } from '../../src/backup-helper/history-projection'
import { join } from 'node:path'
import { readHistoryProjection } from '../../src/backup-helper/history-projection'
import { earlierFixture } from './backup-earlier-fixture'
afterEach(() => { delete historySeams.afterFirstRead })
test('moved synthetic 217 records / 213 versions offer exact earlier roots only after full validation', async () => {
  const f = earlierFixture()
  const result = await readHistoryProjection(f.root, p => p.endsWith('.md'))
  expect(result.state).toBe('unavailable')
  expect((result as any).earlier?.roots).toEqual([{ root: f.original, namedVersions: 10 }, { root: join(f.base, 'earlier'), namedVersions: 3 }].sort((a,b) => a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
  expect([readFileSync(join(f.root, '.writeflex/versions.jsonl')), readFileSync(join(f.root, '.bridle/journal.jsonl'))]).toEqual(f.before)
})

async function candidate(f: ReturnType<typeof earlierFixture>, file?: string) {
  const r = await readHistoryProjection(f.root, p => p.endsWith('.md'), undefined, undefined, file)
  if (r.state !== 'unavailable' || !r.earlier) throw new Error(r.state === 'unavailable' ? r.reason : 'expected earlier locations')
  return r.earlier
}
function approvalFile(f: ReturnType<typeof earlierFixture>) { return join(f.base, 'private', 'earlier-locations.jsonl') }
test('exact confirmation retains all 213 versions; portable copy reprojects identically and source bytes stay unchanged', async () => {
  const f = earlierFixture(), file = approvalFile(f)
  appendHistoryApproval(file, f.root, await candidate(f), () => true)
  const r = await readHistoryProjection(f.root, p => p.endsWith('.md'), undefined, undefined, file)
  expect(r.state).toBe('complete')
  if (r.state !== 'complete') throw new Error(r.reason)
  expect(r.summary.namedVersions).toBe(213)
  const copy = join(f.base, 'portable'); mkdirSync(copy)
  for (const p of r.files) { mkdirSync(join(copy,p.path,'..'), { recursive: true }); writeFileSync(join(copy,p.path),p.content) }
  expect(await readHistoryProjection(copy, p => p.endsWith('.md'))).toEqual(r)
  expect(r.files.filter(p => p.path.endsWith('.jsonl')).every(p => !p.content.includes(Buffer.from(f.base)))).toBe(true)
  expect([readFileSync(join(f.root,'.writeflex/versions.jsonl')),readFileSync(join(f.root,'.bridle/journal.jsonl'))]).toEqual(f.before)
  console.log(JSON.stringify({ syntheticVersionRows: 217, namedVersions: 213, current: 200, earlierCounts: [10,3], sourceBytesUnchanged: true, portableReprojectionIdentical: true }))
})
test('missing acknowledgement/admission writes no approval, and append preserves previous bytes', async () => {
  const f = earlierFixture(), file = approvalFile(f), c = await candidate(f)
  expect(() => appendHistoryApproval(file,f.root,c,() => false)).toThrow()
  expect(existsSync(file)).toBe(false)
  appendHistoryApproval(file,f.root,c,() => true)
  const first = readFileSync(file)
  appendFileSync(join(f.root,'.writeflex/versions.jsonl'), JSON.stringify({ id: 'v_new',ts:300,path:'a.md',name:'New',author:{name:'Synthetic'},snapshotId:'s200',versionId:'r200' })+'\n')
  const next = await candidate(f,file)
  expect(next.records).toHaveLength(1)
  appendHistoryApproval(file,f.root,next,() => true)
  expect(readFileSync(file).subarray(0,first.length)).toEqual(first)
  expect(loadHistoryApprovals(file).records.get(f.root)?.size).toBe(14)
})
for (const mode of ['foreign-root','new-version','restore-point','snapshot-file','object-hash','malformed','truncated','empty','permissions','linked-parent','symlink','hardlink','approval-change','during-read','wrong-owner'] as const) test(`approved history fails closed: ${mode}`, async () => {
  const f = earlierFixture(), file = approvalFile(f)
  appendHistoryApproval(file,f.root,await candidate(f),() => true)
  if (mode === 'foreign-root') { const moved=join(f.base,'foreign');renameSync(f.root,moved);f.root=moved }
  if (mode === 'new-version') appendFileSync(join(f.root,'.writeflex/versions.jsonl'),JSON.stringify({id:'v_new',ts:300,path:'a.md',name:'New',author:{name:'Synthetic'},snapshotId:'s200',versionId:'r200'})+'\n')
  if (mode === 'restore-point') { const rows=readFileSync(join(f.root,'.writeflex/versions.jsonl'),'utf8').trim().split('\n'); const v=JSON.parse(rows[200]!);v.versionId='r201';appendFileSync(join(f.root,'.writeflex/versions.jsonl'),JSON.stringify(v)+'\n') }
  if (mode === 'snapshot-file' || mode === 'wrong-owner' || mode === 'object-hash') {
    const p=join(f.root,'.bridle/journal.jsonl'),rows=readFileSync(p,'utf8').trim().split('\n').map(l=>JSON.parse(l)),snapshot=rows.find(r=>r.id==='s200')
    if(mode==='object-hash') writeFileSync(join(f.root,'.bridle/objects',snapshot.hash),'Changed object')
    else snapshot.file=mode==='wrong-owner' ? '/synthetic/other.md' : '/synthetic/unconfirmed/a.md'
    writeFileSync(p,rows.map(r=>JSON.stringify(r)+'\n').join(''))
  }
  if(mode==='malformed') appendFileSync(file,'{}\n')
  if(mode==='empty') writeFileSync(file,'')
  if(mode==='permissions') chmodSync(file,0o644)
  if(mode==='linked-parent') { renameSync(join(f.base,'private'),join(f.base,'private-original'));symlinkSync(join(f.base,'private-original'),join(f.base,'private')) }
  if(mode==='truncated') writeFileSync(file,readFileSync(file).subarray(0,-1))
  if(mode==='symlink') { renameSync(file,file+'.original');symlinkSync(file+'.original',file) }
  if(mode==='hardlink') linkSync(file,file+'.other')
  if(mode==='approval-change') { const a=JSON.parse(readFileSync(file,'utf8'));a.cohort='f'.repeat(64);writeFileSync(file,JSON.stringify(a)+'\n') }
  if(mode==='during-read') historySeams.afterFirstRead=()=>{appendFileSync(file,'{}\n')}
  const r=await readHistoryProjection(f.root,p=>p.endsWith('.md'),undefined,undefined,file)
  expect(r.state).toBe('unavailable')
  if(mode==='wrong-owner' || mode==='object-hash') expect(r.state==='unavailable' && r.earlier).toBeUndefined()
})
test('new current-root history remains valid without broadening old-root authority', async () => {
  const f=earlierFixture(),file=approvalFile(f)
  appendHistoryApproval(file,f.root,await candidate(f),()=>true)
  appendFileSync(join(f.root,'.writeflex/versions.jsonl'),JSON.stringify({id:'v_current_new',ts:300,path:'a.md',name:'New current',author:{name:'Synthetic'},snapshotId:'s0',versionId:'r0'})+'\n')
  expect(await readHistoryProjection(f.root,p=>p.endsWith('.md'),undefined,undefined,file)).toMatchObject({state:'complete',summary:{namedVersions:214}})
})
