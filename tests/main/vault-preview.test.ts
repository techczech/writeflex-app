import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { VaultIndexService } from '../../src/main/vault-index-service'
import { DEFAULT_SUPPORT_FOLDERS, detectVaultWorks, markdownFactsFrom } from '../../src/main/vault-works'
import { DEFAULT_VAULT_HIDDEN, INDEX_NOTE_RULE } from '../../src/shared/vault'
import {
  canMakeVault, draftToCreateInput, HIDE_GROUPS, hiddenForGroups, humaniseFolderName, initialDraft, normaliseSupportName, PREVIEW_HIDDEN,
  reconcileSteps, refreshedPreview, type VaultPreview,
} from '../../src/shared/vault-preview'
import { previewSettingsFrom } from '../../src/main/vault-preview'
import { HIDE_RULE_LIMITS } from '../../src/main/vault-works'

/**
 * Vaults ticket 03. Two seams: the draft model (proposals in, vault.json content out, pure) and the
 * preview main reports for a plain folder, which must write nothing anywhere.
 */
function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wf-vault-preview-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}
function snapshotTree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const info = statSync(path)
      out.push(`${relative(root, path)}:${entry.isDirectory() ? 'dir' : `${info.size}:${info.mtimeMs}`}`)
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(root)
  return out.sort()
}

const PREVIEW: VaultPreview = {
  folderName: 'reports-and-proposals',
  works: 3, withStatus: 2, files: 9,
  hideCounts: { template: 1, readme: 2 },
  supportCounts: { source: 4 },
  statuses: [{ raw: 'review', works: 1 }, { raw: 'draft', works: 1 }],
  noStatusWorks: 1,
}

describe('the draft model', () => {
  test('the folder name is humanised and the draft opens with every group on and every picker at No step', () => {
    expect(humaniseFolderName('reports-and-proposals_draft')).toBe('Reports and proposals draft')
    const draft = initialDraft(PREVIEW)
    expect(draft.name).toBe('Reports and proposals')
    expect(draft.hideOn).toEqual(HIDE_GROUPS.map((group) => group.id))
    expect(draft.supportFolders).toEqual([...DEFAULT_SUPPORT_FOLDERS])
    expect(draft.steps).toEqual({ review: '', draft: '' })
  })

  test('the untouched draft stands for: every on group pattern, default support folders, empty status map', () => {
    const input = draftToCreateInput(initialDraft(PREVIEW))
    expect(input.name).toBe('Reports and proposals')
    expect(input.hidden).toContain('_TEMPLATE/')
    expect(input.hidden).toContain('README.md')
    expect(input.supportFolders).toEqual([...DEFAULT_SUPPORT_FOLDERS])
    expect(input.statusMap).toEqual({})
  })

  test('a switched-off group contributes no pattern; chosen steps are kept and No step is left out; an added folder is listed once', () => {
    const draft = initialDraft(PREVIEW)
    draft.hideOn = draft.hideOn.filter((id) => id !== 'readme')
    draft.steps = { review: 'In review', draft: '' }
    draft.name = '  My vault '
    const added = normaliseSupportName(' drafts/ ', draft.supportFolders)
    expect(added).toBe('drafts')
    draft.supportFolders = [...draft.supportFolders, added!]
    expect(normaliseSupportName('DRAFTS', draft.supportFolders)).toBeNull()
    expect(normaliseSupportName('a/b', draft.supportFolders)).toBeNull()
    const input = draftToCreateInput(draft)
    expect(input.hidden).not.toContain('README.md')
    expect(input.statusMap).toEqual({ review: 'In review' })
    expect(input.supportFolders).toContain('drafts')
    expect(input.name).toBe('My vault')
  })
})

describe('VaultIndexService.preview', () => {
  test('counts works, statuses, hide groups and support files for a plain folder and writes nothing', async () => {
    const root = folder({
      'README.md': '# Readme',
      'AGENTS.md': '# Agents',
      'essay.md': '---\nstatus: draft\n---\n# Essay',
      'essay (1).md': '# Essay copy',
      'note.md': '---\nstatus: review\n---\n# Note',
      'other.md': '# Other',
      'report/_report-structure.json': JSON.stringify({ files: [{ path: '01-a.md' }] }),
      'report/README.md': '---\nstatus: review\n---\n# The report',
      'report/01-a.md': '# A',
      'report/source/s1.md': '# S1',
      'report/source/s2.md': '# S2',
      '_TEMPLATE/t.md': '# T',
      'void/placeholder.txt': 'x',
    })
    mkdirSync(join(root, 'empty-dir'))
    const before = snapshotTree(root)
    const cacheDir = mkdtempSync(join(tmpdir(), 'wf-vault-preview-cache-'))
    const ws = new Workspace(root)
    const service = new VaultIndexService({ cacheDir })
    const preview = await service.preview(ws, { hidden: [...PREVIEW_HIDDEN], supportFolders: [...DEFAULT_SUPPORT_FOLDERS, 'void'] })

    expect(preview.works).toBe(4) // essay, note, other, report
    expect(preview.withStatus).toBe(3)
    expect(preview.noStatusWorks).toBe(1)
    expect(preview.statuses).toEqual([{ raw: 'review', works: 2 }, { raw: 'draft', works: 1 }])
    expect(preview.hideCounts.template).toBe(1)
    expect(preview.hideCounts.readme).toBe(1)
    expect(preview.hideCounts.agents).toBe(1)
    expect(preview.hideCounts.conflicts).toBe(1)
    expect(preview.supportCounts.source).toBe(2)
    expect(preview.supportCounts.void).toBe(0)
    expect(preview.files).toBe(11)
    expect(preview.folderName).toBe(root.split('/').pop())

    expect(snapshotTree(root)).toEqual(before)
    expect(existsSync(join(root, '.writeflex'))).toBe(false)
    expect(readdirSync(cacheDir)).toEqual([])
    expect(service.known(root)).toBe(false)
  })
})

describe('hide switches write the complete rule list (ticket 02 fix round)', () => {
  test('every built-in rule belongs to exactly one group; the index-notes rule is the one entry beyond it', () => {
    for (const rule of DEFAULT_VAULT_HIDDEN) {
      expect(HIDE_GROUPS.filter((group) => group.patterns.includes(rule)).map((group) => group.id)).toHaveLength(1)
    }
    const beyond = HIDE_GROUPS.flatMap((group) => group.patterns).filter((rule) => !DEFAULT_VAULT_HIDDEN.includes(rule))
    expect(beyond).toEqual([INDEX_NOTE_RULE])
  })

  test('the untouched draft is the built-in list plus index notes; a switch off removes its entries, reserved ones included', () => {
    expect(draftToCreateInput(initialDraft(PREVIEW)).hidden).toEqual([...DEFAULT_VAULT_HIDDEN, INDEX_NOTE_RULE])
    const draft = initialDraft(PREVIEW)
    draft.hideOn = draft.hideOn.filter((id) => !['conflicts', 'empty', 'cache', 'index-notes'].includes(id))
    const hidden = draftToCreateInput(draft).hidden!
    expect(hidden).toEqual(DEFAULT_VAULT_HIDDEN.filter((rule) => ![':conflict-copies', ':empty-folders', 'cache/', '_sources/', 'tools/', '__pycache__/'].includes(rule)))
  })

  test('a vault made with switches off detects without those rules', () => {
    const draft = initialDraft(PREVIEW)
    draft.hideOn = draft.hideOn.filter((id) => id !== 'readme' && id !== 'conflicts')
    const settings = { hidden: draftToCreateInput(draft).hidden!, supportFolders: [...DEFAULT_SUPPORT_FOLDERS] }
    const files = ['README.md', 'essay.md', 'essay (1).md', 'AGENTS.md']
    const index = detectVaultWorks({ rootName: 'v', files, folders: [], manifests: [] }, settings, {
      declaration: () => ({ isFolio: false, manifest: false, runningOrder: false, repairNeeded: false }),
      markdown: (path) => markdownFactsFrom('# T', path, 'T'),
      manifest: () => null,
    })
    expect(index.works.map((w) => w.path).sort()).toEqual(['README.md', 'essay (1).md', 'essay.md'])
    expect(index.hidden.paths).toEqual(['AGENTS.md'])
  })

  test('preview counts each hidden entry under the group whose rule hid it', async () => {
    const root = folder({
      'tools/build.md': '# Tool notes',
      '__pycache__/x.md': '# x',
      'topic/_topic_INDEX.md': '# Topic',
      'topic/a.md': '# A',
      'topic/b.md': '# B',
      'essay.md': '# Essay',
    })
    const preview = await new VaultIndexService({ cacheDir: null }).preview(new Workspace(root), { hidden: [...PREVIEW_HIDDEN], supportFolders: [] })
    expect(preview.hideCounts.cache).toBe(2)
    expect(preview.hideCounts.conflicts).toBe(0)
    expect(preview.hideCounts['index-notes']).toBe(1)
  })
})

describe('hide switches refresh the preview (ticket 02 fix round 2)', () => {
  test('step choices: kept for values still found, dropped for values gone, new values at No step', () => {
    const steps = reconcileSteps({ draft: 'Drafting', review: 'In review', gone: 'Done' }, [
      { raw: 'final' }, { raw: 'draft' }, { raw: 'review' },
    ])
    expect(steps).toEqual({ final: '', draft: 'Drafting', review: 'In review' })
    expect(Object.keys(steps)).toEqual(['final', 'draft', 'review'])
    expect(reconcileSteps({ draft: '' }, [])).toEqual({})
  })

  test('a refreshed preview takes the fresh counts but keeps the count of a switched-off group', () => {
    const next: VaultPreview = { ...PREVIEW, works: 4, hideCounts: { template: 1, readme: 0 }, statuses: [{ raw: 'final', works: 1 }, ...PREVIEW.statuses] }
    const shown = refreshedPreview(PREVIEW, next, HIDE_GROUPS.map((group) => group.id).filter((id) => id !== 'readme'))
    expect(shown.works).toBe(4)
    expect(shown.statuses.map((status) => status.raw)).toEqual(['final', 'review', 'draft'])
    expect(shown.hideCounts).toEqual({ template: 1, readme: 2 })
  })

  test('the preview request is bounded: non-strings dropped, caps and budget enforced, no root taken from it', () => {
    expect(previewSettingsFrom(undefined)).toEqual({ hidden: [...PREVIEW_HIDDEN], supportFolders: [...DEFAULT_SUPPORT_FOLDERS] })
    const settings = previewSettingsFrom({
      root: '/etc',
      hidden: ['README.md', 7, { x: 1 }, 'x'.repeat(201), `${'*a'.repeat(20)}`, ...Array.from({ length: 300 }, (_, i) => `n${i}.md`)],
      supportFolders: ['drafts', 3, 'y'.repeat(201), ...Array.from({ length: 300 }, (_, i) => `s${i}`)],
    })
    expect(Object.keys(settings).sort()).toEqual(['hidden', 'supportFolders'])
    expect(settings.hidden[0]).toBe('README.md')
    expect(settings.hidden.length).toBe(HIDE_RULE_LIMITS.entries - 4) // the first 200 read, 4 of them rejected
    expect(settings.hidden.every((entry) => typeof entry === 'string' && entry.length <= HIDE_RULE_LIMITS.length)).toBe(true)
    expect(settings.hidden).not.toContain(`${'*a'.repeat(20)}`)
    expect(settings.supportFolders[0]).toBe('drafts')
    expect(settings.supportFolders.length).toBe(HIDE_RULE_LIMITS.entries - 2)
    expect(previewSettingsFrom({ hidden: [] }).hidden).toEqual([])
  })

  test("the preview honours the draft's hide list: README off makes it a work and offers its status; nothing is written", async () => {
    const root = folder({
      'README.md': '---\nstatus: final\n---\n# Readme',
      'essay.md': '---\nstatus: draft\n---\n# Essay',
    })
    const before = snapshotTree(root)
    const cacheDir = mkdtempSync(join(tmpdir(), 'wf-vault-preview-cache-'))
    const service = new VaultIndexService({ cacheDir })
    const ws = new Workspace(root)
    const opening = await service.preview(ws, previewSettingsFrom({ supportFolders: [] }))
    expect(opening.works).toBe(1)
    expect(opening.statuses).toEqual([{ raw: 'draft', works: 1 }])

    const draft = initialDraft(opening)
    draft.steps = { draft: 'Drafting' }
    draft.hideOn = draft.hideOn.filter((id) => id !== 'readme')
    const refreshed = await service.preview(ws, previewSettingsFrom({ hidden: hiddenForGroups(draft.hideOn), supportFolders: [] }))
    expect(refreshed.works).toBe(2)
    expect(refreshed.statuses.map((status) => status.raw).sort()).toEqual(['draft', 'final'])
    expect(reconcileSteps(draft.steps, refreshed.statuses)).toEqual({ draft: 'Drafting', final: '' })
    // What the sheet now shows is what Make vault creates.
    expect(previewSettingsFrom({ hidden: draftToCreateInput(draft).hidden }).hidden).toEqual(hiddenForGroups(draft.hideOn))

    expect(snapshotTree(root)).toEqual(before)
    expect(existsSync(join(root, '.writeflex'))).toBe(false)
    expect(readdirSync(cacheDir)).toEqual([])
    expect(service.known(root)).toBe(false)
  })
})

describe('Make vault gating (preview re-read fix)', () => {
  const idle = { busy: false, previewPending: false, previewFailed: false, name: 'Reports' }
  test('Make vault is open only when nothing is in flight, the preview is current, and there is a name', () => {
    expect(canMakeVault(idle)).toBe(true)
    expect(canMakeVault({ ...idle, busy: true })).toBe(false)
    expect(canMakeVault({ ...idle, previewPending: true })).toBe(false)
    expect(canMakeVault({ ...idle, previewFailed: true })).toBe(false)
    expect(canMakeVault({ ...idle, name: '   ' })).toBe(false)
  })
})
