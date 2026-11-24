import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { planRenameRepair, type RenameRepairPlanOptions } from '../../src/main/rename-repair'
import { Workspace } from '../../src/main/workspace'

// Before this change the planner sent every listed folder (and the root) through the same disk probe.
class UnfilteredManifestWorkspace extends Workspace {
  override listFolders(visit?: Parameters<Workspace['listFolders']>[0]): Promise<string[]> {
    return super.listFolders((directory) => visit?.(directory, [{ name: MANIFEST_NAME }]))
  }
}

function manifest(paths: string[], contentRoot = ''): string {
  return JSON.stringify({
    schema_version: 1,
    content_root: contentRoot,
    files: paths.map((path, index) => ({ path, role: index === 0 ? 'front-matter' : 'report-body' })),
  }, null, 2)
}

async function inSyntheticVault(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wf-manifest-discovery-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
}

async function compare(root: string, from: string, to: string, options: RenameRepairPlanOptions = {}) {
  const actual = await planRenameRepair(new Workspace(root), from, to, options)
  expect(actual).toEqual(await planRenameRepair(new UnfilteredManifestWorkspace(root), from, to, options))
  return actual
}

test('manifest discovery avoids disk probes in definitely empty folders', () => inSyntheticVault(async (root) => {
  await write(root, { 'note.md': '# Note\n' })
  await mkdir(join(root, 'empty'))
  const workspace = new Workspace(root)
  const paths: string[] = []
  const absolute = workspace.absolute.bind(workspace)
  workspace.absolute = (path) => {
    if (path === `empty/${MANIFEST_NAME}`) paths.push(path)
    return absolute(path)
  }
  await planRenameRepair(workspace, 'note.md', 'renamed.md')
  expect(paths).toEqual([])
}))

test('root and nested Folios, front matter, batch moves and ignored manifests produce identical plans', () =>
  inSyntheticVault(async (root) => {
    const from = 'report/pages/preface.md'
    const to = 'report/pages/foreword.md'
    const alreadyMoved = 'report/pages/chapter.md'
    const ignored = `broken/${MANIFEST_NAME}`
    await write(root, {
      [from]: '---\nimage: ../../art/cover.png\n---\n# Preface\n\nSee [chapter](../../drafts/chapter.md).\n',
      'art/cover.png': 'synthetic cover',
      'archive/keep.md': '# Archive\n',
      [alreadyMoved]: '# Chapter\n\nSee [preface](preface.md).\n',
      'reference.md': 'Compare [[./report/pages/preface]].\n',
      [MANIFEST_NAME]: manifest([from, alreadyMoved]),
      [`report/${MANIFEST_NAME}`]: manifest(['preface.md', 'chapter.md'], 'pages'),
      [`report/pages/${MANIFEST_NAME}`]: manifest(['preface.md', 'chapter.md']),
      [`report/.hidden/${MANIFEST_NAME}`]: 'not JSON',
      [`empty-folio/${MANIFEST_NAME}`]: manifest([]),
      [ignored]: 'not JSON',
    })
    const batchMoves = new Map([['drafts/chapter.md', alreadyMoved]])
    const before = await compare(root, from, to, { batchMoves })
    expect(before.writes.filter(({ kind }) => kind === 'manifest').map(({ path }) => path))
      .toEqual([MANIFEST_NAME, `report/${MANIFEST_NAME}`, `report/pages/${MANIFEST_NAME}`])
    expect(before.unrepairedReferences).toContain(`${ignored}: Cannot repair references in an unreadable Folio manifest.`)
    expect(before.unrepairedReferences.some((issue) => issue.includes('.hidden'))).toBe(false)
    const afterIgnoring = await compare(root, from, to, {
      batchMoves, outgoingLinksCarried: true, ignore: (path) => path === ignored,
    })
    expect(afterIgnoring.unrepairedReferences.some((issue) => issue.startsWith(ignored))).toBe(false)
    const outsideReport = 'archive/foreword.md'
    const moved = await compare(root, from, outsideReport, { batchMoves })
    const movedContent = moved.writes.find(({ path }) => path === outsideReport)?.content
    expect(movedContent).toContain('image: "../art/cover.png"')
    expect(movedContent).toContain('[chapter](../report/pages/chapter.md)')
    await new Workspace(root).renameFile(from, to)
    await compare(root, from, to, { batchMoves })
  }))

test('manifest aliases, broken symlinks and non-file entries follow the original disk probe', () =>
  inSyntheticVault(async (scratch) => {
    const root = join(scratch, 'vault')
    const from = 'source.md'
    const to = 'renamed.md'
    await write(scratch, { 'outside.json': manifest([from]) })
    await write(root, {
      [from]: '# Source\n',
      'case/_REPORT-STRUCTURE.JSON': '{}',
      'unicode/_report-ſtructure.json': '{}',
      'target.json': 'not JSON',
    })
    for (const dir of ['link', 'dangling', 'outside', 'folder-entry']) await mkdir(join(root, dir))
    await symlink('../target.json', join(root, 'link', MANIFEST_NAME))
    await symlink('../missing.json', join(root, 'dangling', MANIFEST_NAME))
    await symlink('../../outside.json', join(root, 'outside', MANIFEST_NAME))
    const plan = await compare(root, from, to)
    expect(plan.unrepairedReferences).toContain(`link/${MANIFEST_NAME}: Cannot repair references in an unreadable Folio manifest.`)
    expect(plan.unrepairedReferences.some((issue) => /^(?:outside|dangling)\//.test(issue))).toBe(false)

    await mkdir(join(root, 'folder-entry', MANIFEST_NAME))
    for (const workspace of [new Workspace(root), new UnfilteredManifestWorkspace(root)]) {
      await expect(planRenameRepair(workspace, from, to)).rejects.toMatchObject({ code: 'EISDIR' })
    }
  }))

test('complete plans match before and after moves in 24 seeded vaults', () =>
  inSyntheticVault(async (scratch) => {
    let seed = 0x6f6c696f
    const sample = (count: number): number => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
      return Math.floor(seed / 0x100000000 * count)
    }
    const folders = ['', 'report', 'report/pages', 'report/pages/nested', 'notes', 'notes/drafts']
    const from = 'report/pages/subject.md'
    const destinations = ['report/pages/renamed.md', 'notes/drafts/renamed.md', 'report/pages/_private.md']
    for (let vault = 0; vault < 24; vault++) {
      const root = join(scratch, `generated-${vault}`)
      const to = destinations[vault % destinations.length]
      const files: Record<string, string> = { [from]: '# Subject\n' }
      for (const dir of folders) {
        const prefix = dir ? `${dir}/` : ''
        const stem = sample(2) ? 'subject' : 'other'
        files[`${prefix}note-${vault}.md`] = `# Note\n\n[[${stem}]]` + ' and `[[subject]]`\n'
        if (sample(3)) {
          const path = from.startsWith(prefix) ? from.slice(prefix.length) : 'missing.md'
          files[`${prefix}${MANIFEST_NAME}`] = manifest([path, 'missing.md', 'note.md'])
        }
      }
      await write(root, files)
      await compare(root, from, to)
      await new Workspace(root).renameFile(from, to)
      await compare(root, from, to)
    }
  }), 20_000)
