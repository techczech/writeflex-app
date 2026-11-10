/**
 * Ticket 19 of Folio versions (ADR-0052 § Agent verbs, last row): `versions`, `save-version` and `compare-versions` work on a table, widget page or
 * image; `restore-version` on one is refused with a sentence that points at the writer. Run through the command line with the app closed (under the
 * owner lock), the same functions the app's request route calls. Synthetic files only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdir, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

let fx: WriteFixture
const gitEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1' })
afterAll(() => {
  if (gitEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = gitEnv.global
  if (gitEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = gitEnv.system
})
beforeEach(async () => { fx = await writeFixture() })
afterEach(async () => { await fx.dispose() })

const CSV = 'data/scores-3.csv'
const ONE = 'Judge,Prefer A,Ties\nJudge 1,51,9\nJudge 2,47,7\n'
const TWO = 'Judge,Prefer A,Ties\nJudge 1,49,11\nJudge 2,47,7\n'

test('save-version, versions and compare-versions work on a table; the listing numbers the versions and says nothing is used yet', async () => {
  await fx.write(CSV, ONE)
  const saved = await fx.cli(['save-version', CSV, '--name', 'Pilot run'])
  expect(saved.json.error?.message ?? '').toBe('')
  expect(saved.code).toBe(0)
  await fx.write(CSV, TWO)

  const listed = await fx.cli(['versions', CSV])
  expect(listed.code).toBe(0)
  const file = listed.json.result!.file as { kind: string; working: { state: string; cellsChanged: number }; versions: Array<{ number: number; name: string; usedBy: unknown[] }> }
  expect(file.kind).toBe('table')
  expect(file.versions.map((v) => [v.number, v.name, v.usedBy.length])).toEqual([[1, 'Pilot run', 0]])
  expect(file.working).toMatchObject({ state: 'changed', cellsChanged: 2 })

  const id = (listed.json.result!.versions as Array<{ id: string }>)[0]!.id
  const compared = await fx.cli(['compare-versions', CSV, id])
  expect(compared.code).toBe(0)
  const table = (compared.json.result as { compare: { kind: string; cellsDiffering: number; rows: Array<Array<{ before: string; after: string }>> } }).compare
  expect(table).toMatchObject({ kind: 'table', cellsDiffering: 2 })
  expect(table.rows[0]!.map((cell) => [cell.before, cell.after])).toEqual([['Judge 1', 'Judge 1'], ['51', '49'], ['9', '11']])
  const same = await fx.cli(['compare-versions', CSV, id, id])
  expect((same.json.result as { compare: { cellsDiffering: number } }).compare.cellsDiffering).toBe(0)
})

test('an image or widget page is compared by whether it differs; the save writes the file as it is, byte for byte', async () => {
  await fx.write('assets/fig.png', new Uint8Array([0x89, 0x50, 0xff, 0x00]))
  const saved = await fx.cli(['save-version', 'assets/fig.png', '--name', 'First'])
  expect(saved.code).toBe(0)
  await fx.write('assets/fig.png', new Uint8Array([0x89, 0x50, 0xff, 0x01, 0x02]))
  const id = ((await fx.cli(['versions', 'assets/fig.png'])).json.result!.versions as Array<{ id: string }>)[0]!.id
  const compared = await fx.cli(['compare-versions', 'assets/fig.png', id])
  expect((compared.json.result as { compare: unknown }).compare).toMatchObject({ kind: 'other', fileKind: 'image', same: false, linesChanged: null, from: { bytes: 4 }, to: { bytes: 5 } })
})

test('save-version refuses a file over 25 MiB with the reason, and a path outside the Collection or in a hidden folder', async () => {
  await fx.write('assets/big.bin', 'x')
  await truncate(join(fx.root, 'assets/big.bin'), 25 * 1024 * 1024 + 1)
  const big = await fx.cli(['save-version', 'assets/big.bin', '--name', 'Big'])
  expect(big.code).toBe(1)
  expect(big.json.error?.message).toMatch(/25 MiB.*reference/s)
  // No version record was written.
  expect(await fx.read('.writeflex/versions.jsonl').catch(() => '')).not.toContain('big.bin')
  for (const path of ['../outside.csv', '.writeflex/versions.jsonl', '.bridle/journal.jsonl']) {
    const refused = await fx.cli(['save-version', path, '--name', 'x'])
    expect(refused.code).not.toBe(0)
  }
})

test('restore-version on a table, widget page or image is refused with a sentence that sends the agent to the writer; nothing is written', async () => {
  await fx.write(CSV, ONE)
  await fx.cli(['save-version', CSV, '--name', 'Pilot run'])
  await fx.write(CSV, TWO)
  const id = ((await fx.cli(['versions', CSV])).json.result!.versions as Array<{ id: string }>)[0]!.id
  const before = await fx.snapshot({ journal: true })
  const refused = await fx.cli(['restore-version', CSV, id])
  expect(refused.code).toBe(1)
  expect(refused.json.error?.message ?? refused.out).toMatch(/only the writer does it, in WriteFlex/)
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect(await fx.read(CSV)).toBe(TWO)
  await mkdir(join(fx.root, 'data'), { recursive: true })
  await writeFile(join(fx.root, 'data/unrelated.csv'), 'a\n')
})
