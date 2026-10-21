import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MakeVaultSheet } from '../../src/renderer/src/components/MakeVaultSheet'
import { HIDE_GROUPS, type VaultPreview } from '../../src/shared/vault-preview'

/** Vaults ticket 03: the sheet as drawn (render seam: a preview already read). */
const PREVIEW: VaultPreview = {
  folderName: 'reports-and-proposals',
  works: 3, withStatus: 2, files: 9,
  hideCounts: { template: 1, readme: 2 },
  supportCounts: { source: 4 },
  statuses: [{ raw: 'review', works: 1 }, { raw: 'draft', works: 1 }],
  noStatusWorks: 1,
}

describe('the sheet', () => {
  test('draws the locked frame: found counts, every group with a switch, support chips, status rows at No step, no suggestion banner', () => {
    const html = renderToStaticMarkup(<MakeVaultSheet rootPath={'/' + ['Users', 'example', 'writing', 'reports-and-proposals'].join('/')} initialPreview={PREVIEW} onClose={() => {}} onMade={() => {}} />)
    expect(html).toContain('Make this folder a vault')
    expect(html).toContain('~/writing/reports-and-proposals')
    expect(html).toContain('value="Reports and proposals"')
    expect(html).toContain('What WriteFlex found')
    expect(html).toContain('With a status')
    for (const group of HIDE_GROUPS) expect(html).toContain(`data-group="${group.id}"`)
    expect(html).toContain('none found')
    expect(html).toContain('4 files')
    expect(html).toContain('data-status="review"')
    expect(html).toContain('(no status)')
    expect(html).toContain('No step, shown grey')
    expect(html).toContain('.writeflex/vault.json')
    expect(html).toContain('Nothing is saved until you choose Make vault.')
    expect(html).not.toContain('suggested')
    expect(html).not.toContain('Suggesting')
  })
})
