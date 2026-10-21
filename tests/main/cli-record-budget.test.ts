/**
 * Second-review parcel P10, invariant 3: a move whose finished record would exceed the entry limit
 * changes no file.
 *
 * Schedule: a reduced entry limit, and a move whose first few changes fit within it while the whole
 * does not: the moved document and the first repaired file fit, the later repairs take the record
 * over. Every write step is watched (`beforeWrite`, which runs before each folder, move and rewrite):
 * none may be reached, and the Collection must be byte for byte as it was.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

let fx: WriteFixture
beforeEach(async () => { fx = await writeFixture() })
afterEach(async () => { await fx.dispose() })

/** About 3,000 bytes each; base64 makes each about 4,000 in the record. */
const PADDING = `${'A paragraph that makes this document long enough to matter to the record. '.repeat(40)}\n`
/** Links that each change rewrites: `move` the link to the moved document, `move-folder` the link to the renamed Index Note. */
const LINKS_TO_YORK = (n: number): string => `# Big ${n}\n\nSee [[york]], listed in [[_talks_INDEX]].\n\n${PADDING}`
/** The limit: room for the record (three quarters of it) holds the move and one or two big repairs, not all three. */
const LIMIT = 12_000

async function bigReferrers(f: WriteFixture): Promise<void> {
  await f.write('talks/_talks_INDEX.md', '# Talks\n')
  for (const n of [1, 2, 3]) await f.write(`big-${n}.md`, LINKS_TO_YORK(n))
}

for (const [operation, argv] of [['move', ['move', 'talks/york.md', 'talks/york-2026.md']], ['move-folder', ['move-folder', 'talks', 'events']]] as const) {
  test(`${operation}: a change whose record would be over the limit is refused before its first write, and changes nothing`, async () => {
    await bigReferrers(fx)
    const before = await fx.snapshot()
    const reached: string[] = []
    const refused = await fx.cli([...argv], { write: { maxJournalEntryBytes: LIMIT, seams: { beforeWrite: async (path) => { reached.push(path) } } } })
    expect(refused.code).toBe(1)
    expect(refused.json.error!.message).toContain(`too large for the command line to keep a record to undo it by (the record would be over ${LIMIT} bytes)`)
    // Refused before the first change, not rolled back after some.
    expect(reached).toEqual([])
    expect(await fx.snapshot()).toEqual(before)
    expect(await fx.journalNames()).toEqual([])

    // The same change within the ordinary limit is made, repairing all three: the budget was the only obstacle.
    const made = await fx.cli([...argv])
    expect(made.json.error?.message ?? '').toBe('')
    for (const n of [1, 2, 3]) expect(await fx.read(`big-${n}.md`)).not.toBe(LINKS_TO_YORK(n))
  })
}
