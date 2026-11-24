import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

export const VAULT_SEED = 20261121

/** Exactly count Markdown files. Every 20 files add one Folio and its manifest. */
export async function generateSyntheticVault(root: string, count: number): Promise<void> {
  let seed = VAULT_SEED
  const choose = (length: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % length
  }
  const topics = ['botany', 'ceramics', 'harbours', 'weather', 'printing', 'gardens', 'geometry', 'maps', 'glass', 'hills', 'orchards']
  const put = async (path: string, content: string): Promise<void> => {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  const paths = ['edit.md', 'rename-me.md', 'move-me.md', 'rename-folder/inside.md', 'references.md']
  const groups = Math.floor(count / 20)
  const folios = Array.from({ length: groups }, (_, group) => `research/area-${group % 12}/series-${group % 23}/folio-${group}`)
  for (const folio of folios) paths.push(`${folio}/README.md`, `${folio}/chapter.md`)
  while (paths.length < count) {
    const i = paths.length
    paths.push(`notes/area-${i % 20}/subject-${i % 47}/year-${2024 + (i % 3)}/note-${i}.md`)
  }
  await put('.writeflex/vault.json', JSON.stringify({ name: 'Synthetic speed vault' }))
  await mkdir(join(root, 'destination'))
  for (const folio of folios) {
    await put(`${folio}/_report-structure.json`, JSON.stringify({
      schema_version: 1, report_id: posix.basename(folio), files: [{ path: 'chapter.md', role: 'report-body' }],
    }))
  }

  for (const [i, path] of paths.entries()) {
    const topic = topics[choose(topics.length)]
    const target = paths[(i + 1 + choose(paths.length - 1)) % paths.length]
    const relative = posix.relative(posix.dirname(path), target)
    const link = relative.startsWith('.') ? relative : `./${relative}`
    const paragraph = `These are invented field notes on ${topic}. The sample describes the setting, records several observations, and leaves a question to follow up in a later entry.\n\n`
    const body = paragraph.repeat(i % 997 === 0 ? Math.ceil(200_000 / paragraph.length) : 1 + choose(7))
    const extra = i === 4
      ? '\nSee [[rename-me]], [[./move-me]] and [[./rename-folder/inside]]. Benchneedle.\n'
      : ''
    const heading = path === 'rename-me.md' ? 'A note about renaming'
      : path.endsWith('/README.md') ? posix.basename(posix.dirname(path)) : posix.basename(path, '.md')
    await put(path, `---\ntags: [synthetic, ${topic}]\nstatus: draft\n---\n# ${heading}\n\n${body}See [[${target.slice(0, -3)}]] and [another note](${link}).\n${extra}`)
  }
}
