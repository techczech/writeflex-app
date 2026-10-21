import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withVaults, type StartScreenModel } from '../../src/main/start-screen-model'

// A vault root is listed once, as a card; pins and recents keep only plain folders.

test('withVaults takes vault roots out of pinned and recents and keeps the rest in order', async () => {
  const base = mkdtempSync(join(tmpdir(), 'wf-start-vaults-'))
  const vault = join(base, 'writing')
  const plain = join(base, 'notes')
  const recentVault = join(base, 'reports')
  for (const dir of [vault, plain, recentVault]) mkdirSync(dir, { recursive: true })
  for (const dir of [vault, recentVault]) {
    mkdirSync(join(dir, '.writeflex'))
    writeFileSync(join(dir, '.writeflex', 'vault.json'), '{}')
  }
  const model: StartScreenModel = {
    example: null,
    pinned: [{ root: vault, missing: false }, { root: plain, missing: false }, { root: join(base, 'gone'), missing: true }],
    recents: [{ root: recentVault, openedAt: 5 }],
  }
  const settings = { recents: () => [{ root: vault, openedAt: 9 }, { root: recentVault, openedAt: 5 }] }
  const out = await withVaults(model, settings, { cacheDir: null, home: base })
  expect(out.vaults.map((v) => v.root)).toEqual([vault, recentVault])
  expect(out.vaults[0]).toMatchObject({ name: 'writing', location: '~/writing', works: null, inProgress: null, lastWorked: 9 })
  expect(out.pinned.map((p) => p.root)).toEqual([plain, join(base, 'gone')])
  expect(out.recents).toEqual([])
})
