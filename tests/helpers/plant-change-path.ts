/**
 * The app refuses to record a Change at a path inside a hidden folder (or one that climbs out with `..`):
 * `ChangeStore.add` throws (changes.ts `assertChangeTargetsADocument`). Such a record can still reach the
 * journal by a hand edit or another program. A test of what the app then does with it records the Change at a
 * visible path and rewrites that one field in the journal, as such an edit would.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { changeJournalPath, type Change, type ChangeStore, type NewChange } from '../../src/main/changes'

export async function plantChangeAt(root: string, store: ChangeStore, input: NewChange, path: string): Promise<Change> {
  const recorded = await store.add({ ...input, path: 'planted-in-the-journal.md' })
  const journal = join(root, changeJournalPath())
  const lines = (await readFile(journal, 'utf8')).split('\n').map((line) => {
    if (line.trim() === '') return line
    const record = JSON.parse(line) as Record<string, unknown>
    return record.id === recorded.id ? JSON.stringify({ ...record, path }) : line
  })
  await writeFile(journal, lines.join('\n'))
  const planted = await store.get(recorded.id)
  if (!planted || planted.path !== path) throw new Error(`The planted record does not read back at ${path}.`)
  return planted
}
