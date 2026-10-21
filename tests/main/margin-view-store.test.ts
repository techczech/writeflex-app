import { afterAll, expect, test } from 'bun:test'

// Dominik 2026-10-19, "margin is default": a view stored by 0.24's Margin | Under bar does not carry over.

const store = new Map<string, string>()
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  removeItem: (key: string) => { store.delete(key) },
}
const hadWindow = 'window' in globalThis
const previous = (globalThis as { window?: unknown }).window
;(globalThis as { window?: unknown }).window = { ...(previous as object | undefined), localStorage }
afterAll(() => { if (hadWindow) (globalThis as { window?: unknown }).window = previous; else delete (globalThis as { window?: unknown }).window })

test('a legacy stored Under starts in Margin, the old key goes, and a choice made in this build is kept and announced', async () => {
  store.set('writeflex-margin-view', 'under')
  const { readPreferredView, setPreferredView, subscribePreferredView, VIEW_KEY, LEGACY_VIEW_KEY } = await import('../../src/renderer/src/app/margin-view-store')
  expect(VIEW_KEY).not.toBe(LEGACY_VIEW_KEY)
  expect(readPreferredView()).toBe('margin')
  expect(store.has(LEGACY_VIEW_KEY)).toBe(false)
  let heard = 0
  const off = subscribePreferredView(() => { heard += 1 })
  setPreferredView('under')
  expect(heard).toBe(1)
  expect(readPreferredView()).toBe('under')
  setPreferredView('margin')
  expect(readPreferredView()).toBe('margin')
  off()
  setPreferredView('under')
  expect(heard).toBe(2)
})
