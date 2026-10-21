import { expect, test } from 'bun:test'
import { DEFAULT_VAULT_SIDEBAR_PREFS, readVaultSidebarPrefs, vaultCountText, writeVaultSidebarPrefs } from '../../src/renderer/src/vault-sidebar'
import { hiddenCountText } from '../../src/shared/vault-index'

function memory(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

test('a vault starts on Writing only and Titles; choices are remembered per vault, never shared', () => {
  const store = memory()
  expect(readVaultSidebarPrefs('/a', store)).toEqual({ writingOnly: true, titles: true })
  writeVaultSidebarPrefs('/a', { writingOnly: false, titles: false }, store)
  expect(readVaultSidebarPrefs('/a', store)).toEqual({ writingOnly: false, titles: false })
  expect(readVaultSidebarPrefs('/b', store)).toEqual(DEFAULT_VAULT_SIDEBAR_PREFS)
})

test('unreadable or partial stored prefs fall back field by field; no storage is fine', () => {
  const store = memory()
  store.data.set('writeflex:vault-sidebar:/a', '{not json')
  expect(readVaultSidebarPrefs('/a', store)).toEqual(DEFAULT_VAULT_SIDEBAR_PREFS)
  store.data.set('writeflex:vault-sidebar:/a', '{"titles":false,"writingOnly":"x"}')
  expect(readVaultSidebarPrefs('/a', store)).toEqual({ writingOnly: true, titles: false })
  expect(readVaultSidebarPrefs('/a', null)).toEqual(DEFAULT_VAULT_SIDEBAR_PREFS)
  expect(() => writeVaultSidebarPrefs('/a', DEFAULT_VAULT_SIDEBAR_PREFS, null)).not.toThrow()
})

test('count line: in progress is Notes, Drafting, In review or Final through the status map', () => {
  const work = (status: string | null) => ({ status }) as never
  const map = { draft: 'Drafting', review: 'In review', idea: 'Idea', fin: 'Final', done: 'Done', n: 'Notes' } as const
  const works = [work('draft'), work('review'), work('idea'), work('fin'), work('done'), work('n'), work('mystery'), work(null)]
  expect(vaultCountText(works, map)).toBe('8 works · 4 in progress')
  expect(vaultCountText([work('draft')], map)).toBe('1 work · 1 in progress')
})

test('hidden count text: folders only, files only, both, none', () => {
  expect(hiddenCountText(142, 0)).toBe('142 folders hidden')
  expect(hiddenCountText(0, 1)).toBe('1 file hidden')
  expect(hiddenCountText(1, 14)).toBe('1 folder and 14 files hidden')
  expect(hiddenCountText(0, 0)).toBe('Nothing hidden')
})
