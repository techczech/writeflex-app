import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('vault benchmark reports every journey and removes its synthetic vault', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'wf-bench-smoke-'))
  try {
    const output = join(scratch, 'result.json')
    const child = Bun.spawn([process.execPath, 'scripts/bench-vault.ts', '--files', '50', '--runs', '1', '--json', output], {
      env: { ...process.env, TMPDIR: scratch },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    if (exit !== 0) throw new Error(`Benchmark exited ${exit}\n${stdout}\n${stderr}`)
    const result = JSON.parse(await readFile(output, 'utf8'))
    expect(result.files).toBe(50)
    expect(result.rows.map((row: { journey: string }) => row.journey)).toEqual([
      'open vault', 'first search after open', 'repeat search', 'quick-open name search',
      'save document', 'rename document', 'move document', 'rename folder',
    ])
    for (const row of result.rows) {
      expect(Number.isFinite(row.medianMs)).toBe(true)
      expect(Number.isFinite(row.p90Ms)).toBe(true)
      expect(Number.isFinite(row.medianWalks)).toBe(true)
    }
    expect(await readdir(scratch)).toEqual(['result.json'])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 30000)
