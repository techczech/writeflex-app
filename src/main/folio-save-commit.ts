/**
 * The commit boundary of a Folio save (ADR-0052; Folio versions ticket 03).
 *
 * A Folio save writes several append-only lines (one per-file version per changed file) and then ONE
 * Folio version record, then one commit line in a journal of its own. Nothing is deleted if the save stops
 * part-way. Every per-file version a save writes carries `folioSave: <the save's id>`, the id the Folio
 * version record will have, and such a version counts only once the save is COMPLETE, which either
 * journal can say:
 *   - the Folio journal (`.writeflex/folio-versions.jsonl`) holds a Folio version with that id, or
 *   - the commit journal (`.writeflex/folio-save-commits.jsonl`) holds `{kind: 'folio-save-committed', id}`.
 * The commit line is NOT written to `.writeflex/versions.jsonl`: the backup helper of 0.28.0-alpha.9 rejects a
 * line of an unknown `kind` in that journal, so one Folio save would stop the backup of every Mac that runs
 * it, ordinary writing included (ADR-0052 § Compatibility). Nothing that predates this file reads it.
 * Both journals are needed. The Folio record alone is not enough: a backup may leave a Folio version out (a member
 * outside backup scope), and the restored copy then has the per-file versions without the record. The
 * commit line alone is not enough: a crash between the two appends leaves the Folio record without it.
 * Without either, the per-file version is an ORPHAN: left in the journal, ignored by reuse, hidden from
 * per-file history (VersionStore.list), and carried unchanged by the backup projection.
 *
 * Reads only, apart from the one commit-line text. Electron-free.
 */
import { FOLIO_SAVE_COMMITTED, folioSaveOf, parseFolioJournalLine, parseFolioSaveCommit } from '../shared/folio-version-records'
import { readStoreFile } from './checked-store-write'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { FOLIO_VERSIONS_JOURNAL_REL } from './folio-versions'
import type { Version } from './versions'

/** The commit journal: append-only, one JSON line per completed save id, written through the checked append like the other journals. */
export const FOLIO_SAVE_COMMITS_JOURNAL_REL = '.writeflex/folio-save-commits.jsonl'

/** The line a finished Folio save appends to the commit journal. */
export const folioSaveCommitLine = (id: string, ts: number): string => `${JSON.stringify({ kind: FOLIO_SAVE_COMMITTED, id, ts })}\n`

/** Read the primary journal and ordinary copies sync made. Copies are data, never rewritten. */
async function journalBytes(root: string, rel: string, what: string): Promise<Buffer[]> {
  const primary = await readStoreFile(root, rel)
  if (primary.state === 'refused') throw new Error(`WriteFlex could not read ${what}: ${primary.message}`)
  const result = primary.state === 'absent' ? [] : [primary.bytes]
  const stem = basename(rel, '.jsonl')
  const names = await readdir(join(root, dirname(rel))).catch(() => [] as string[])
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl') || !(name.startsWith(`${stem}-`) || name.startsWith(`${stem} `))) continue
    const copy = await readStoreFile(root, `${dirname(rel)}/${name}`)
    // A refused copy (including a link) cannot supply completion authority.
    if (copy.state !== 'absent' && copy.state !== 'refused') result.push(copy.bytes)
  }
  return result
}

/** The ids of the saves that finished, as either journal or its synced copies says it. */
export async function completedFolioSaveIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const bytes of await journalBytes(root, FOLIO_VERSIONS_JOURNAL_REL, 'the Folio version history')) {
    for (const line of bytes.toString('utf8').split('\n')) {
      const record = parseFolioJournalLine(line)
      if (record?.kind === 'folio-version') ids.add(record.id)
    }
  }
  for (const bytes of await journalBytes(root, FOLIO_SAVE_COMMITS_JOURNAL_REL, 'the record of finished Folio saves')) {
    for (const line of bytes.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      const commit = parseFolioSaveCommit(parsed)
      if (commit) ids.add(commit.id)
    }
  }
  return ids
}

/**
 * `versions` without the orphans of unfinished Folio saves. `including` is a save still under way, whose
 * own per-file versions count already. The journals are read only when some version carries a marker.
 */
export async function withoutUnfinishedFolioSaves<T extends Version>(root: string, versions: T[], including?: string): Promise<T[]> {
  if (!versions.some((version) => folioSaveOf(version) !== undefined)) return versions
  const done = await completedFolioSaveIds(root)
  return versions.filter((version) => {
    const save = folioSaveOf(version)
    return save === undefined || save === including || done.has(save)
  })
}
