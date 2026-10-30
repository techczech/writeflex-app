import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A cached helper's module-level hook belongs to its first importing file. Each owning file
// registers cleanup explicitly so a later file's fixtures do not accumulate until process teardown.
test('cached scratch tracking removes each serial test file fixture at its own file boundary', () => {
  const base = mkdtempSync(join(tmpdir(), 'wf-scratch-scope-'))
  const helper = new URL('../helpers/scratch-dirs.ts', import.meta.url).href
  try {
    for (const name of ['a', 'b']) {
      writeFileSync(join(base, `${name}.test.ts`), `
import { afterAll, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import * as scratch from ${JSON.stringify(helper)}
const path = ${JSON.stringify(join(base, name))}
if (typeof scratch.cleanUpScratch === 'function') afterAll(scratch.cleanUpScratch)
afterAll(() => writeFileSync(${JSON.stringify(join(base, `${name}.json`))}, JSON.stringify({ removed: !existsSync(path) })))
test('synthetic fixture ${name}', () => { mkdirSync(path); scratch.trackScratch(path) })
`)
    }
    const child = Bun.spawnSync([process.execPath, 'test', join(base, 'a.test.ts'), join(base, 'b.test.ts')], {
      cwd: base,
      env: { ...process.env },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(readFileSync(join(base, 'a.json'), 'utf8'))).toEqual({ removed: true })
    expect(JSON.parse(readFileSync(join(base, 'b.json'), 'utf8'))).toEqual({ removed: true })
    expect(existsSync(join(base, 'a'))).toBe(false)
    expect(existsSync(join(base, 'b'))).toBe(false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
