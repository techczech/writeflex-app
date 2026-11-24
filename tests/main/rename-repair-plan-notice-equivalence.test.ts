import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { planRenameRepair } from '../../src/main/rename-repair'
import { Workspace } from '../../src/main/workspace'

// The original discovery function from b92ae7d3. Run it with the same planner and disk view.
const originalDiscovery = `async function planLinesToPreserve(workspace: Workspace, folders: string[], fromPath: string, toPath: string): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
  for (const dir of ['', ...folders]) {
    const indexPath = indexNotePath(workspace, dir)
    if (fromPath === indexPath || !(await workspacePathExists(workspace, indexPath))) continue
    const fromRelative = pathInside(dir, fromPath)
    if (!fromRelative) continue
    const toRelative = pathInside(dir, toPath)
    if (!toRelative) paths.set(indexPath, 'the renamed file left this report')
    else if (excludedPlanDestination(toPath)) paths.set(indexPath, 'the destination is excluded from this report')
  }
  return paths
}`

async function loadOriginalPlanner(scratch: string): Promise<typeof planRenameRepair> {
  const url = new URL('../../src/main/rename-repair.ts', import.meta.url)
  const source = await Bun.file(url).text()
  const discovery = /async function planLinesToPreserve\([\s\S]*?\n}/
  expect(source.match(discovery)).not.toBeNull()
  const legacySource = source.replace(discovery, originalDiscovery)
    .replace(/(from )'(\.\.?\/[^']+)'/g, (_, from: string, specifier: string) =>
      from + JSON.stringify(new URL(specifier + '.ts', url).href))
  const fixture = join(scratch, 'original-rename-repair.ts')
  await writeFile(fixture, legacySource)
  return (await import(fixture)).planRenameRepair
}

test('narrow Index Note discovery preserves whole plans over synthetic vaults', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'wf-plan-notice-equivalence-'))
  try {
    const original = await loadOriginalPlanner(scratch)
    const destinations = [
      'report/nested/renamed.md',
      'report/other/renamed.md',
      'report-copy/nested/renamed.md',
      'report/nested/_private.md',
      'report/Agent-Notes/renamed.md',
    ]
    const from = 'report/nested/part.md'
    for (const kind of ['authored', 'manifest', 'missing-index', 'root-source-index'] as const) {
      for (const [index, destination] of destinations.entries()) {
        const root = join(scratch, kind, `vault-${index}`)
        const rootIndex = `_${basename(root)}_INDEX.md`
        const source = kind === 'root-source-index' ? rootIndex : from
        const runningOrder = '# Sample vault\n\n## Running order\n\n- [[part]] — gloss\n\nSee [[part]].\n'
        const files: Record<string, string> = {
          [rootIndex]: runningOrder,
          'report/_report_INDEX.md': runningOrder,
          'report-copy/_report-copy_INDEX.md': runningOrder,
          [from]: '# Part\n',
          'report/nested/_nested_INDEX.md': runningOrder,
          'notes/reference.md': 'Compare [[part]].\n',
        }
        if (kind === 'missing-index') delete files['report/nested/_nested_INDEX.md']
        if (kind === 'manifest') {
          files['report/_report-structure.json'] = JSON.stringify({ schema_version: 1, files: [{ path: 'nested/part.md', role: 'report-body' }] })
        }
        for (let index = 0; index < 12; index += 1) {
          files[`other/folder-${index}/deep/note.md`] = '# Unrelated note\n'
        }
        for (const [path, content] of Object.entries(files)) {
          const absolute = join(root, path)
          await mkdir(dirname(absolute), { recursive: true })
          await writeFile(absolute, content)
        }
        await mkdir(dirname(join(root, destination)), { recursive: true })
        const workspace = new Workspace(root)
        const before = await planRenameRepair(workspace, source, destination)
        expect(before).toEqual(await original(workspace, source, destination))
        if (kind === 'authored' && destination === destinations[1]) {
          expect(before.preservedReferences).toEqual([
            'report/nested/_nested_INDEX.md: [[part]] was left unchanged because the renamed file left this report.',
          ])
        }
        if (kind === 'authored' && destination === destinations[3]) {
          expect(before.preservedReferences).toHaveLength(3)
        }
        await workspace.renameFile(source, destination)
        const after = await planRenameRepair(workspace, source, destination)
        expect(after).toEqual(await original(workspace, source, destination))
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 20_000)
