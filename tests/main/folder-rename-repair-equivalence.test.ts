import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { planFolderRenameRepair } from '../../src/main/folder-rename-repair'
import { planRenameRepair } from '../../src/main/rename-repair'
import { Workspace } from '../../src/main/workspace'
import { planFolderRenameRepairBeforeLazyRanges } from '../fixtures/folder-rename-repair-before-lazy-ranges'

async function compare(files: Record<string, string>, destinations: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'wf-folder-rename-equivalence-'))
  try {
    for (const [path, source] of Object.entries(files)) {
      const absolute = join(root, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, source)
    }
    const workspace = new Workspace(root)
    const plans = []
    for (const to of destinations) {
      const before = await planFolderRenameRepairBeforeLazyRanges(workspace, 'draft', to)
      const after = await planFolderRenameRepair(workspace, 'draft', to)
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
      plans.push(after)
    }
    return plans
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('folder moves preserve whole plans for code, prose, Folios, and path front matter', async () => {
  const code = [
    '`[[./draft/a]]`',
    '``[[./draft/a]]``',
    '```md\n[[./draft/a]]\n```',
    '~~~\n[[./draft/a]]\n~~~',
    '    [[./draft/a]]',
    '> ```\n> [[./draft/a]]\n> ```',
    '- Example\n\n  ```\n  [[./draft/a]]\n  ```',
    '`example\n[[./draft/a]]`',
  ]
  const [ordinary, encoded] = await compare({
    'draft/a.md': '---\nimage: ../art/cover.png\n---\n# A\n\n[Peer](../peer.md)\n',
    'draft/_draft_INDEX.md': '# Draft Folio\n\n## Running order\n\n1. [[./a]] — a gloss\n',
    'draft/_report-structure.json': '{"schema_version":1,"files":[{"path":"a.md","role":"report-body"}]}',
    'peer.md': '# Peer\n',
    'art/cover.png': 'Synthetic file bytes',
    'reader.md': [
      '---\nexample: "[[./draft/a]]"\n---',
      ...code,
      'See [[ ./draft/a.md#part | a label ]], [[./draft/a]], and [[A]].',
      '| Link |\n| --- |\n| [[./draft/a]] |',
      '<!-- [[./draft/a]] -->',
      '```\n[[./draft/a]]',
    ].join('\n\n'),
    'other/reader.md': 'Cannot climb via [[./../draft/a]].\n',
    'other/draft/a.md': '# Another A\n',
  }, ['archive/draft', 'broken#folder', 'draft', ''])
  const reader = ordinary.writes.find((write) => write.path === 'reader.md')
  expect(reader?.content).toContain('[[ ./archive/draft/a.md#part | a label ]]')
  expect(reader?.content).toContain(code[0])
  expect(ordinary.writes.find((write) => write.path === 'archive/draft/a.md')?.content).toContain('../../art/cover.png')
  expect(encoded.writes.find((write) => write.path === 'reader.md')?.content).toContain('./broken%23folder/a')
})

test('folder plans agree over 48 seeded synthetic vaults and three destinations each', async () => {
  let seed = 20261122
  const choose = (count: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 16) % count
  }
  const links = ['[[./draft/a]]', '[[./draft/b.mdx#section|B]]', '[[./draft/sub/c.markdown]]', '[[A]]', '[[./target/a]]', '[[./draft/nope]]']
  for (let run = 0; run < 48; run += 1) {
    const files: Record<string, string> = {
      'draft/a.md': '# A\n\n[Outside](../other.md)\n',
      'draft/b.mdx': '# B\n',
      'draft/sub/c.markdown': '# C\n',
      'other.md': '# Outside\n',
      'target/a.md': '# Existing destination name\n',
    }
    for (let index = 0; index < 8; index += 1) {
      const link = links[choose(links.length)]
      const text = [`See ${link}.`, `Inline \`${link}\`.`, `~~~\n${link}\n~~~`, `    ${link}`, `> ${link}`][choose(5)]
      files[`${index % 2 ? 'notes/' : ''}note-${index}.md`] = `---\ntitle: Example ${index}\n---\n\n${text}\n\n${links[choose(links.length)]}\n`
    }
    await compare(files, ['archive/draft', 'target', 'brackets]'])
  }
}, 20_000)


// Restore just the three pre-change lines from fa557015, so the old planner can run in the
// same process without a second copy of the planner or a dependency on Git checkout depth.
async function plannerBeforeLineLookupShortcut(scratch: string): Promise<typeof planRenameRepair> {
  const url = new URL('../../src/main/rename-repair.ts', import.meta.url)
  const current = await Bun.file(url).text()
  const fastLookup = [
    '    const line = planLines.get(filePath)',
    '    if (!line) return { found: false, path: null }',
    '    const titleLink = line.get(lineAtOffset(source, link.from))',
  ].join('\n')
  const originalLookup = [
    '    const line = planLines.get(filePath)',
    '    const lineNumber = lineAtOffset(source, link.from)',
    '    const titleLink = line?.get(lineNumber)',
  ].join('\n')
  expect(current.split(fastLookup)).toHaveLength(2)
  const older = current.replace(fastLookup, originalLookup)
    .replace(/(from )'(\.\.?\/[^']+)'/g, (_, from: string, specifier: string) =>
      from + JSON.stringify(new URL(specifier + '.ts', url).href))
  const fixture = join(scratch, 'original-rename-repair.ts')
  await writeFile(fixture, older)
  const legacy = await import(fixture)
  return legacy.planRenameRepair
}

test('the Folio lookup shortcut preserves full document plans with code, front matter and prior batch moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-folio-line-lookup-equivalence-'))
  try {
    const original = await plannerBeforeLineLookupShortcut(root)
    const files = {
      'draft/old.md': '---\nimage: ../art/cover.png\n---\n# Old Part\n\n[Peer](peer.md)\n',
      'draft/_draft_INDEX.md': '# Draft\n\n## Running order\n\n- [[Old Part]] — a gloss\n\n~~~\n[[old]]\n~~~\n',
      'draft/_report-structure.json': '{"schema_version":1,"files":[{"path":"old.md","role":"report-body"}]}',
      'archive/deep/peer.md': '# Peer\n\n[Old](../../draft/old.md#intro)\n',
      'reader.md': '# Reader\n\nSee [[./draft/old]] and [[new]].\n\n' + '~~~\n[[old]] and [[new]]\n~~~\n\n'.repeat(48),
      'art/cover.png': 'Synthetic file bytes',
    }
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, content)
    }
    const workspace = new Workspace(root)
    const from = 'draft/old.md'
    const to = 'archive/deep/new.md'
    const batchMoves = new Map([['draft/peer.md', 'archive/deep/peer.md']])
    const check = async (options: Parameters<typeof planRenameRepair>[3]) => {
      const baseline = await original(workspace, from, to, options)
      const current = await planRenameRepair(workspace, from, to, options)
      expect(JSON.stringify(current)).toBe(JSON.stringify(baseline))
      return current
    }
    const plan = await check({ batchMoves })
    expect(plan.preservedReferences).toHaveLength(1)
    expect(plan.writes.find(({ path }) => path === to)?.content).toContain('../../art/cover.png')
    expect(plan.writes.find(({ path }) => path === 'archive/deep/peer.md')?.content).toContain('[Old](new.md#intro)')
    await check({})
    await check({ batchMoves, outgoingLinksCarried: true })
    await workspace.renameFile(from, to)
    await check({ batchMoves })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
