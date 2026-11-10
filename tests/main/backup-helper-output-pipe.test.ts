// Actual authenticated app helper bundle; real Node supervisor and pipes. Synthetic bridge frame only.
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyBackupHelperInputs } from '../../scripts/lib/backup-helper-inputs'
const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
for (const bridge of [false, true]) for (const brokenPipe of [false, true]) test(`actual app helper: bridge=${bridge}, broken pipe=${brokenPipe}`, () => {
  const root = resolve(import.meta.dir, '../..')
  verifyBackupHelperInputs(root)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wf-pipe-'))); roots.push(dir)
  const config = join(dir, 'config.json'), supervisor = join(dir, 'supervisor.cjs')
  const include = Array.from({ length: 24000 }, (_, i) => `x${i}`)
  writeFileSync(config, JSON.stringify({ configVersion: 2, machineId: 'm', tools: { git: '/nonexistent/synthetic-git', gitleaks: '/nonexistent/synthetic-gitleaks' }, vaults: [{ id: 'v', path: dir, include }] }))
  writeFileSync(supervisor, `const {spawn} = require('node:child_process');
const child=spawn(process.execPath, [${JSON.stringify(join(root, 'out/backup-helper/writeflex-backup-helper.js'))}, ...${bridge} ? ['--github-credentials'] : [], 'preview','--config',${JSON.stringify(config)},'--vault','v'], {stdio:['ignore','pipe','pipe', ...${bridge} ? ['pipe','pipe'] : []]});
let chunks=[], stderr='', exit; child.stdout.on('data', c=>chunks.push(c)); child.stdout.pause();
child.stderr.on('data',c=>stderr+=c); child.once('exit',code=>exit=code);
if (${bridge}) {const bytes=Buffer.from(JSON.stringify({version:1,namespace:'writeflex.backup.github.v1',installId:'11111111-1111-4111-8111-111111111111',epoch:1,generation:1,expiresAt:Date.now()+600000,accessToken:'synthetic-placeholder',bindings:[]})); const head=Buffer.alloc(4); head.writeUInt32BE(bytes.length); child.stdio[3].end(Buffer.concat([head,bytes])); child.stdio[3].on('error',()=>{}); child.stdio[4].on('error',()=>{});}
if (${brokenPipe}) child.stdout.destroy(); else setTimeout(()=>child.stdout.resume(),200);
child.once('close',close=>{ const bytes=Buffer.concat(chunks); let answer=null; try {answer=JSON.parse(bytes.toString());}catch{} process.stdout.write(JSON.stringify({exit,close,stderr,bytes:bytes.length,answer})); });`)
  const run = spawnSync('/usr/local/bin/node', [supervisor], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
  expect(run.status).toBe(0)
  const result = JSON.parse(run.stdout)
  expect(result.exit).toBe(brokenPipe ? 2 : 0); expect(result.close).toBe(result.exit)
  if (brokenPipe) expect(result.stderr).toMatch(bridge ? /outcome uncertain/ : /EPIPE|broken pipe/)
  else {
    expect(result.bytes).toBeGreaterThan(256 * 1024)
    expect(result.answer.scope.include).toEqual(include)
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result.answer, null, 2) + '\n'))
  }
  console.log(JSON.stringify({ appHelper: true, bridge, brokenPipe, bytes: result.bytes, exit: result.exit, close: result.close }))
})
