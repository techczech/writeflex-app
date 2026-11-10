import { afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const roots: { path: string; dev: number; ino: number }[] = []
afterEach(() => {
  while (roots.length) {
    const r = roots.pop()!, s = lstatSync(r.path)
    if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== r.dev || s.ino !== r.ino) throw new Error('synthetic fixture identity changed; cleanup refused')
    rmSync(r.path, { recursive: true })
  }
})
export function earlierFixture() {
  const base = mkdtempSync(join(tmpdir(), 'wf-earlier-')); const identity = lstatSync(base); roots.push({ path: base, dev: identity.dev, ino: identity.ino })
  const original = join(base, 'original'), root = join(base, 'current')
  mkdirSync(join(original, '.writeflex'), { recursive: true }); mkdirSync(join(original, '.bridle/objects'), { recursive: true })
  const content = Buffer.from('Synthetic named text\n'), hash = createHash('sha256').update(content).digest('hex')
  writeFileSync(join(original, '.bridle/objects', hash), content)
  const versions = [], journal = []
  for (let i = 0; i < 213; i++) {
    const old = i < 200 ? root : i < 210 ? original : join(base, 'earlier')
    versions.push({ id: `v_synthetic_${i}`, ts: i, path: 'a.md', name: `Synthetic ${i}`, author: { name: 'Synthetic' }, snapshotId: `s${i}`, versionId: `r${i}` })
    journal.push({ kind: 'restore-point', id: `r${i}`, ts: i, sessionId: 'synthetic' }, { kind: 'snapshot', id: `s${i}`, ts: i, sessionId: 'synthetic', file: `${old}/a.md`, hash })
  }
  // Four valid move-fold rows give the requested 217 version-journal records.
  versions.push(...[0,1].flatMap(i => [{ kind: 'version-paths', id: `m${i}`, assignments: [] }, { kind: 'version-paths-finish', id: `m${i}`, state: 'done' }]) as any)
  writeFileSync(join(original, '.writeflex/versions.jsonl'), versions.map(v => JSON.stringify(v)+'\n').join(''))
  writeFileSync(join(original, '.bridle/journal.jsonl'), journal.map(v => JSON.stringify(v)+'\n').join(''))
  renameSync(original, root)
  const before = [readFileSync(join(root, '.writeflex/versions.jsonl')), readFileSync(join(root, '.bridle/journal.jsonl'))]
  return { base, root, original, before }
}
