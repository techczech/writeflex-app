import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { appendHistoryApproval } from '../../src/backup-helper/history-approvals'
import { readHistoryProjection, historySeams } from '../../src/backup-helper/history-projection'
import { createEarlierLocations } from '../../src/main/backup-helper/earlier-locations'
import { prepareVersionMove } from '../../src/main/version-moves'
import { WRITEFLEX_SCOPE } from '../../src/main/backup-helper/enrolment'
import { earlierFixture } from './backup-earlier-fixture'
afterEach(() => { delete historySeams.afterFirstRead })
const scope = (p: string) => p.endsWith('.md')
async function proposal(f: ReturnType<typeof earlierFixture>, file?: string) {
  const r = await readHistoryProjection(f.root, scope, undefined, undefined, file)
  if (r.state !== 'unavailable' || !r.earlier) throw new Error('expected earlier roots')
  return r.earlier
}
for (const change of ['document-move', 'label-edit'] as const) test(`approval survives ordinary ${change} without widening snapshot authority`, async () => {
  const f = earlierFixture(), file = join(f.base, 'private', 'approvals.jsonl')
  appendHistoryApproval(file, f.root, await proposal(f), () => true)
  if (change === 'document-move') {
    fs.writeFileSync(join(f.root, 'a.md'), 'Synthetic current text')
    const move = prepareVersionMove(f.root, 'a.md', 'b.md')
    fs.renameSync(join(f.root, 'a.md'), join(f.root, 'b.md')); move.finish()
  } else {
    const v = JSON.parse(fs.readFileSync(join(f.root, '.writeflex/versions.jsonl'), 'utf8').split('\n')[200]!)
    v.name = 'Renamed label'
    fs.appendFileSync(join(f.root, '.writeflex/versions.jsonl'), JSON.stringify(v) + '\n')
  }
  expect(await readHistoryProjection(f.root, scope, undefined, undefined, file)).toMatchObject({state:'complete', summary:{namedVersions:213}})
  const v = JSON.parse(fs.readFileSync(join(f.root, '.writeflex/versions.jsonl'), 'utf8').split('\n')[200]!)
  v.id = 'v_still_unapproved'
  fs.appendFileSync(join(f.root, '.writeflex/versions.jsonl'), JSON.stringify(v) + '\n')
  expect((await readHistoryProjection(f.root, scope, undefined, undefined, file)).state).toBe('unavailable')
})
test('damaged private approvals do not block a vault that needs no old-root authority', async () => {
  const f = earlierFixture(), file = join(f.base, 'broken-approvals.jsonl'), empty = join(f.base, 'empty-vault')
  fs.mkdirSync(empty); fs.writeFileSync(file, '{torn', { mode:0o600 })
  expect(await readHistoryProjection(empty, scope, undefined, undefined, file)).toMatchObject({state:'complete',summary:{namedVersions:0}})
  const journal = join(f.root, '.bridle/journal.jsonl')
  const rows = fs.readFileSync(journal,'utf8').trim().split('\n').map(l => JSON.parse(l))
  for (const row of rows) if (row.kind === 'snapshot') row.file = join(f.root,'a.md')
  fs.writeFileSync(journal,rows.map(r => JSON.stringify(r)+'\n').join(''))
  expect(await readHistoryProjection(f.root, scope, undefined, undefined, file)).toMatchObject({state:'complete',summary:{namedVersions:213}})
})
for (const existing of [false,true]) test(`failed partial append restores ${existing ? 'existing bytes' : 'initial absence'}`, async () => {
  const f = earlierFixture(), file = join(f.base,'private','approvals.jsonl')
  const c = await proposal(f)
  if (existing) appendHistoryApproval(file,f.root,c,()=>true)
  const before = existing ? fs.readFileSync(file) : null
  const fresh = existing ? {...c, approvalState:(await import('../../src/backup-helper/history-approvals')).loadHistoryApprovals(file).state} : c
  const realWrite = fs.writeSync; let calls = 0
  const mock = spyOn(fs,'writeSync').mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) => {
    if (calls++ === 0) return realWrite(fd,bytes,offset,Math.min(length,17))
    throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'})
  }) as typeof fs.writeSync)
  try { expect(()=>appendHistoryApproval(file,f.root,fresh,()=>true)).toThrow('synthetic disk full') }
  finally { mock.mockRestore() }
  expect(fs.existsSync(file) ? fs.readFileSync(file) : null).toEqual(before)
  if (!existing) appendHistoryApproval(file,f.root,c,()=>true)
  expect(await readHistoryProjection(f.root,scope,undefined,undefined,file)).toMatchObject({state:'complete'})
})
test('trusted userData ancestor resolves while the private approval folder remains no-follow', async () => {
  const f = earlierFixture(), target = join(f.base,'userdata'), alias = join(f.base,'userdata-alias')
  fs.mkdirSync(target); fs.symlinkSync(target,alias)
  const service = createEarlierLocations({file:join(alias,'private','approvals.jsonl'),root:()=>f.root,now:()=>100,ttl:1000})
  const c = await service.inspect(f.root,WRITEFLEX_SCOPE)
  expect(c).toBeDefined()
  service.bind(1,'a'.repeat(32),f.root,f.root,WRITEFLEX_SCOPE,c!)
  expect(await service.confirm(1,{previewId:'a'.repeat(32),confirmEarlier:true})).toBe(true)
  expect(fs.existsSync(join(target,'private','approvals.jsonl'))).toBe(true)
})
test('FIFO history refuses without waiting for a writer or wedging main', async () => {
  const f = earlierFixture(), path = join(f.root,'.writeflex/versions.jsonl')
  fs.unlinkSync(path)
  expect(spawnSync('/usr/bin/mkfifo',[path]).status).toBe(0)
  let unblock: number | undefined
  const timer = setTimeout(()=>{unblock=fs.openSync(path,fs.constants.O_RDWR|fs.constants.O_NONBLOCK)},250)
  const started=performance.now()
  try {
    expect(await readHistoryProjection(f.root,scope)).toMatchObject({state:'unavailable'})
    expect(performance.now()-started).toBeLessThan(200)
  } finally { clearTimeout(timer); if(unblock!==undefined)fs.closeSync(unblock) }
})
test('confirmation inspection uses the helper projection budget rather than a five-second cutoff', async () => {
  const f = earlierFixture(), service=createEarlierLocations({file:join(f.base,'private','approvals.jsonl'),root:()=>f.root,now:()=>100,ttl:100000})
  historySeams.afterFirstRead=async()=>{await new Promise(resolve=>setTimeout(resolve,5100))}
  expect((await service.inspect(f.root,WRITEFLEX_SCOPE))?.records).toHaveLength(13)
},10000)

test('approval ordering is identical for Czech writer and C-locale helper reader', async () => {
  const f=earlierFixture(), file=join(f.base,'private','approvals.jsonl')
  const journal=join(f.root,'.bridle/journal.jsonl')
  const rows=fs.readFileSync(journal,'utf8').trim().split('\n').map(l=>JSON.parse(l))
  for (const row of rows) if(row.kind==='snapshot' && Number(row.id.slice(1))>=200) row.file=join(f.base,Number(row.id.slice(1))<210?'ch':'h','a.md')
  fs.writeFileSync(journal,rows.map(r=>JSON.stringify(r)+'\n').join(''))
  const source=join(f.base,'locale.ts')
  fs.writeFileSync(source,`import {readHistoryProjection} from ${JSON.stringify(join(import.meta.dir,'../../src/backup-helper/history-projection.ts'))};
import {appendHistoryApproval,loadHistoryApprovals} from ${JSON.stringify(join(import.meta.dir,'../../src/backup-helper/history-approvals.ts'))};
const [mode,root,file]=process.argv.slice(2);
if(mode==='write'){const r=await readHistoryProjection(root,p=>p.endsWith('.md'));if(r.state!=='unavailable'||!r.earlier)throw Error('missing proposal');appendHistoryApproval(file,root,r.earlier,()=>true);}
else{const a=loadHistoryApprovals(file);if(a.records.get(root)?.size!==13)throw Error('approval refused');}
`)
  expect((await Bun.build({entrypoints:[source],target:'node',format:'esm',outdir:f.base,naming:'locale.mjs'})).success).toBe(true)
  const node=Bun.which('node');if(!node)throw new Error('real Node required')
  for(const [mode,locale] of [['write','cs_CZ.UTF-8'],['read','C']]) {
    const r=spawnSync(node,[join(f.base,'locale.mjs'),mode!,f.root,file],{env:{PATH:'/usr/bin:/bin',HOME:f.base,LANG:locale,LC_ALL:locale},encoding:'utf8',timeout:10000})
    expect({status:r.status,stderr:r.stderr}).toEqual({status:0,stderr:''})
  }
})
