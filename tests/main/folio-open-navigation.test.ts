import { expect, test } from 'bun:test'
import { createFolioOpenNavigation, type FolioOpenDecision } from '../../src/renderer/src/app/folio-open-navigation'
import type { FolioOpenPart } from '../../src/renderer/src/components/FolioOpenButton'

const first = { path: 'a/first.md', title: 'First' }
const a = { workspace: '/workspace', dir: 'a' }
const b = { workspace: '/workspace', dir: 'b' }

function heldRead() {
  const reads: string[] = []
  const decisions: FolioOpenDecision[] = []
  const { promise, resolve } = Promise.withResolvers<FolioOpenPart[]>()
  const navigation = createFolioOpenNavigation(dir => { reads.push(dir); return promise })
  const apply = (decision: FolioOpenDecision): void => { decisions.push(decision) }
  navigation.bind(a)
  return { navigation, apply, decisions, reads, resolve }
}

test('a late Open Folio cannot take over after navigating to B or after A → B → A', async () => {
  for (const returnsToA of [false, true]) {
    const { navigation, apply, decisions, reads, resolve } = heldRead()
    const waiting = navigation.openDefault(a, apply)
    navigation.bind(b)
    if (returnsToA) navigation.bind(a)
    resolve([first])
    await waiting

    expect(reads).toEqual(['a'])
    expect(decisions).toEqual([])
  }
})

test('a direct part selection supersedes an outstanding default, even within the same Folio', async () => {
  const { navigation, apply, decisions, resolve } = heldRead()
  const waiting = navigation.openDefault(a, apply)
  navigation.openAt(a, 'a/chosen.md', apply)
  resolve([first])
  await waiting

  expect(decisions).toEqual([{ kind: 'editor', dir: 'a', path: 'a/chosen.md' }])
})

test('only the latest default command can hand the first part to the editor', async () => {
  const { navigation, apply, decisions, reads, resolve } = heldRead()
  const older = navigation.openDefault(a, apply)
  const newer = navigation.openDefault(a, apply)
  resolve([first, { path: 'a/second.md', title: 'Second' }])
  await Promise.all([older, newer])

  expect(reads).toEqual(['a', 'a'])
  expect(decisions).toEqual([{ kind: 'editor', dir: 'a', path: first.path }])
})

test('a live empty result is reported once; retired, rebound and unmounted requests are silent', async () => {
  const live = heldRead()
  const waiting = live.navigation.openDefault(a, live.apply)
  live.resolve([])
  await waiting
  expect(live.decisions).toEqual([{ kind: 'empty' }])

  const exits = [
    (navigation: ReturnType<typeof createFolioOpenNavigation>) => navigation.retire(),
    (navigation: ReturnType<typeof createFolioOpenNavigation>) => navigation.bind({ ...a, workspace: '/new-workspace' }),
    (navigation: ReturnType<typeof createFolioOpenNavigation>) => navigation.bind(null),
  ]
  for (const exit of exits) {
    const { navigation, apply, decisions, resolve } = heldRead()
    const waiting = navigation.openDefault(a, apply)
    exit(navigation)
    resolve([])
    await waiting
    expect(decisions).toEqual([])
  }
})

test('a direct selection from a retired surface cannot pair its path with a new Folio', () => {
  const { navigation, apply, decisions } = heldRead()
  navigation.bind(b)
  navigation.openAt(a, 'a/chosen.md', apply)
  navigation.openAt(b, 'b/chosen.md', apply)
  expect(decisions).toEqual([{ kind: 'editor', dir: 'b', path: 'b/chosen.md' }])
})
