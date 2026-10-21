import { describe, expect, test } from 'bun:test'
import { parentPath, rootName, switcherList, switchStayedMessage, worksText, type RootPresence } from '../../src/shared/vault-switcher'

/** Vaults ticket 06: the switcher's list model (settings pins and recents + vault presence → sections). */
const HOME = '/tmp/example-author'
const presenceOf = (table: Record<string, RootPresence>) => (root: string): RootPresence => table[root] ?? { kind: 'folder' }

describe('switcherList', () => {
  test('pins then recents, each once; vaults and plain folders in their own sections; the current root ticked', () => {
    const list = switcherList({
      pinned: ['/tmp/example-author/Writing', '/tmp/example-author/Documents/WriteFlex/guides'],
      recents: ['/tmp/example-author/file-sync/reports-and-proposals-draft', '/tmp/example-author/Writing', '/tmp/example-author/sample-storage/_agent-work-space'],
      current: '/tmp/example-author/file-sync/reports-and-proposals-draft',
      home: HOME,
      presence: presenceOf({
        '/tmp/example-author/Writing': { kind: 'vault', name: 'Writing', works: 1882 },
        '/tmp/example-author/file-sync/reports-and-proposals-draft': { kind: 'vault', name: 'Reports and proposals', works: 14 },
      }),
    })
    expect(list.vaults).toEqual([
      { root: '/tmp/example-author/Writing', name: 'Writing', works: 1882, current: false },
      { root: '/tmp/example-author/file-sync/reports-and-proposals-draft', name: 'Reports and proposals', works: 14, current: true },
    ])
    expect(list.folders).toEqual([
      { root: '/tmp/example-author/Documents/WriteFlex/guides', name: 'guides', parent: '~/Documents/WriteFlex', current: false },
      { root: '/tmp/example-author/sample-storage/_agent-work-space', name: '_agent-work-space', parent: '~/sample-storage', current: false },
    ])
    expect(list.currentIsVault).toBe(true)
  })

  test('a folder that is gone is left out; the current root is listed even when it is in neither list', () => {
    const list = switcherList({
      pinned: ['/Volumes/Gone/notes'],
      recents: [],
      current: '/tmp/example',
      home: HOME,
      presence: presenceOf({ '/Volumes/Gone/notes': { kind: 'missing' } }),
    })
    expect(list.vaults).toEqual([])
    expect(list.folders).toEqual([{ root: '/tmp/example', name: 'example', parent: '/tmp', current: true }])
    expect(list.currentIsVault).toBe(false)
  })

  test('a vault with no cached count reads —; counts are grouped the British way', () => {
    expect(worksText(null)).toBe('—')
    expect(worksText(1)).toBe('1 work')
    expect(worksText(1882)).toBe('1,882 works')
  })

  test('names and parent paths', () => {
    expect(rootName('/tmp/example-author/Writing/')).toBe('Writing')
    expect(parentPath('/tmp/example-author/Writing', HOME)).toBe('~')
    expect(parentPath('/tmp/example-author-other/Writing', HOME)).toBe('/tmp/example-author-other')
    expect(parentPath('/Writing', HOME)).toBe('/')
  })
})

test('the line when a switch stays because the window could not close names what could not be saved', () => {
  expect(switchStayedMessage({ kind: 'refused', failed: [{ path: 'drafts/policy.md' }] })).toBe('Could not save policy.md — staying in this folder')
  expect(switchStayedMessage({ kind: 'refused', failed: [{ path: 'a.md' }, { path: 'b.md' }] })).toBe('Could not save 2 documents — staying in this folder')
  expect(switchStayedMessage({ kind: 'refused', failed: [{ path: 'a.md', reason: 'The disk is full.' }] })).toBe('The disk is full. Staying in this folder.')
  expect(switchStayedMessage({ kind: 'refused', failed: [{ path: 'a.md', reason: 'The disk is full.' }, { path: 'b.md' }] })).toBe('The disk is full. Could not save 1 more — staying in this folder')
  expect(switchStayedMessage({ kind: 'still-typing' })).toBe('Still saving what you typed — staying in this folder')
  expect(switchStayedMessage(null)).toBe('Could not save your documents — staying in this folder')
})
