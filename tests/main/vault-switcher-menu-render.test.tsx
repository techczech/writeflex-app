import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { switcherRows, VaultSwitcherMenu } from '../../src/renderer/src/components/VaultSwitcherMenu'
import type { SwitcherList } from '../../src/shared/vault-switcher'

/** Vaults ticket 06: the switcher menu as drawn in the locked frame (render seam: a list already read). */
const LIST: SwitcherList = {
  vaults: [
    { root: '/tmp/example-author/reports', name: 'Reports and proposals', works: 14, current: true },
    { root: '/tmp/example-author/Writing', name: 'Writing', works: 1882, current: false },
  ],
  folders: [
    { root: '/tmp/example-author/Documents/WriteFlex/guides', name: 'guides', parent: '~/Documents/WriteFlex', current: false },
    { root: '/tmp/example-author/sample-storage/_agent-work-space', name: '_agent-work-space', parent: '~/sample-storage', current: false },
  ],
  currentIsVault: true,
}
const labels = (list: SwitcherList | null, isVault = false) => switcherRows(list, isVault).map((row) => (row.kind === 'item' ? `${row.label}${row.small ? ` · ${row.small}` : ''}${row.tick ? ' ✓' : ''}${row.off ? ' (off)' : ''}` : row.kind === 'head' ? `[${row.label}]` : '—'))

describe('the switcher rows', () => {
  test('on a vault: Vaults with the tick and counts, Folders with parent paths, Open folder…, Make greyed "already a vault"; no Vault settings yet', () => {
    expect(labels(LIST)).toEqual([
      '[Vaults]', 'Reports and proposals · 14 works ✓', 'Writing · 1,882 works',
      '—', '[Folders]', 'guides · ~/Documents/WriteFlex', '_agent-work-space · ~/sample-storage',
      '—', 'Open folder…', 'Make this folder a vault… · already a vault (off)',
    ])
  })

  test('on a plain folder Make can be chosen; empty sections are not drawn; while loading only the two actions show', () => {
    expect(labels({ vaults: [], folders: [{ root: '/x/notes', name: 'notes', parent: '/x', current: true }], currentIsVault: false })).toEqual([
      '[Folders]', 'notes · /x ✓', '—', 'Open folder…', 'Make this folder a vault…',
    ])
    expect(labels(null, true)).toEqual(['Open folder…', 'Make this folder a vault… · already a vault (off)'])
  })

  test('the menu renders as a keyboard menu: radio items for roots with the current one checked, the greyed item disabled', () => {
    const html = renderToStaticMarkup(<VaultSwitcherMenu x={10} y={20} currentIsVault onChoose={() => {}} onClose={() => {}} load={async () => LIST} initialList={LIST} />)
    expect(html).toContain('role="menu"')
    expect(html).toContain('role="menuitemradio" aria-checked="true" data-root="/tmp/example-author/reports"')
    expect(html).toContain('role="menuitemradio" aria-checked="false" data-root="/tmp/example-author/Writing" class="fm-item hi"')
    expect(html).toContain('<small>1,882 works</small>')
    expect(html).toContain('<small>~/Documents/WriteFlex</small>')
    expect(html).toContain('aria-label="Switch vault or open a folder"')
    expect(html).toContain('Open folder…')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('already a vault')
  })
})
