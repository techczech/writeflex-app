import { CollectionWriteTurn } from './collection-write-turn'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { posix } from 'node:path'
import { SavedButNotReadBack, type Workspace } from './workspace'
import { assertCollectionWritable } from './collection-write-gate'

/** @internal Test seam: runs inside `removeAtOrigin` after its read, before its guarded write. */
export const scrapStoreSeams: { afterRemoveAtOriginRead?: () => Promise<void> | void } = {}

/**
 * A cutting the writer set aside (ADR-0008). Lives on disk in a `scraps/` subfolder BESIDE its origin
 * document (`a/b/notes.md` → `a/b/scraps/notes-SCRAPS.md`) as a `## <id> <flags>` section whose body
 * is the scrap text verbatim. `origin` is the FULL workspace-relative path of the document it was cut
 * from — so `a/notes.md` and `b/notes.md` never collide — while the pane displays the basename group
 * label. `colour` is a CSS colour the tile's dot paints; `expandTrigger` — when present — is the
 * `{trigger}` a writer types (+ space) in the editor to expand this scrap's body in place.
 */
export type Scrap = { id: string; origin: string; text: string; done: boolean; colour?: string; expandTrigger?: string }

const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i
const SCRAPS_SUFFIX = /-SCRAPS\.md$/i
/** The per-origin subfolder name; a `<stem>-SCRAPS.md` directly inside one is a store file. */
const SCRAPS_DIR = 'scraps'
/**
 * RESERVED STORE NAMESPACE. Store-owned scrap ids are namespaced `## s_…` so a scrap heading can never
 * be confused with a foreign `## Heading` a writer (or the agent, Task 24) adds to the file — foreign
 * runs are preserved byte-for-byte. Two consequences are deliberate and ledgered:
 *  - A hand-written `## s_xxx` heading in a SCRAPS.md is ADOPTED as a scrap (parsed, listed, editable);
 *    authoring one by hand is the supported way to seed a scrap or an expandable.
 *  - A scrap BODY line that itself matches `## s_…` is split off into its own section on the next parse.
 *    This is a known edge (a writer pasting store-shaped text into a cutting); acceptable because bodies
 *    are cuttings, not authored markdown, and it is documented here rather than defended in code.
 */
const SCRAP_ID = /^s_[0-9a-z]+$/

/** A parsed scrap section: the heading fields plus its body/section lines verbatim (`lines[0]` is the
 *  heading line). `dirty` marks a section whose HEADING was edited, so serialise re-renders only that
 *  one line and leaves every other section byte-identical (edits rewrite only the owned section). */
type ScrapBlock = {
  kind: 'scrap'
  id: string
  done: boolean
  colour?: string
  trigger?: string
  lines: string[]
  dirty: boolean
}
/** Any run of lines that is not a scrap section (preamble notes, foreign headings): preserved raw. */
type ForeignBlock = { kind: 'foreign'; lines: string[] }
type Block = ScrapBlock | ForeignBlock

/** Parse a `## <id> <flags>` heading line, or null if the line is not a store-owned scrap heading
 *  (a foreign `## Heading`, a malformed flag, or a non-namespaced id all read as foreign content). */
function matchScrapHeading(line: string): { id: string; done: boolean; colour?: string; trigger?: string } | null {
  if (!line.startsWith('## ')) return null
  const rest = line.slice(3)
  const firstSpace = rest.indexOf(' ')
  const id = firstSpace === -1 ? rest : rest.slice(0, firstSpace)
  if (!SCRAP_ID.test(id)) return null
  const flagStr = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim()
  const tokens = flagStr === '' ? [] : flagStr.split(/\s+/)
  let done = false
  let colour: string | undefined
  let trigger: string | undefined
  for (const token of tokens) {
    if (token === '[x]') done = true
    else if (token.length >= 2 && token[0] === '{' && token.endsWith('}')) trigger = token.slice(1, -1)
    else if (token.length >= 2 && token[0] === '(' && token.endsWith(')')) colour = token.slice(1, -1)
    else return null // an unrecognised token means this is not a scrap heading — leave the section foreign
  }
  return { id, done, colour, trigger }
}

/** Render a scrap heading in canonical flag order: `[x]` done, `{trigger}` expandable, `(colour)` mark. */
function renderHeading(block: ScrapBlock): string {
  let heading = `## ${block.id}`
  if (block.done) heading += ' [x]'
  if (block.trigger !== undefined) heading += ` {${block.trigger}}`
  if (block.colour) heading += ` (${block.colour})`
  return heading
}

/** Split a SCRAPS.md file into ordered blocks. Line-based so serialise∘parse is byte-exact: each
 *  block owns a contiguous run of `\n`-split lines, and every line lands in exactly one block. */
export function parseScrapsFile(content: string): Block[] {
  if (content === '') return []
  const blocks: Block[] = []
  let current: Block | null = null
  for (const line of content.split('\n')) {
    const meta = matchScrapHeading(line)
    if (meta) {
      current = { kind: 'scrap', ...meta, lines: [line], dirty: false }
      blocks.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      current = { kind: 'foreign', lines: [line] }
      blocks.push(current)
    }
  }
  return blocks
}

/** Re-emit blocks. Unedited/foreign blocks re-use their raw lines (byte-exact round-trip); a `dirty`
 *  scrap re-renders only its heading line, so its body and all sibling sections stay byte-identical. */
export function serializeBlocks(blocks: Block[]): string {
  return blocks
    .flatMap((block) => (block.kind === 'scrap' && block.dirty ? [renderHeading(block), ...block.lines.slice(1)] : block.lines))
    .join('\n')
}

/** The scrap body is every line after the heading; the projected `text` trims the structural blank
 *  lines (the inter-section separator) while preserving inner blank lines and spacing. */
function bodyText(block: ScrapBlock): string {
  return block.lines.slice(1).join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

function toScrap(block: ScrapBlock, origin: string): Scrap {
  return {
    id: block.id,
    origin,
    text: bodyText(block),
    done: block.done,
    ...(block.colour ? { colour: block.colour } : {}),
    ...(block.trigger !== undefined ? { expandTrigger: block.trigger } : {}),
  }
}

/** The scraps a SCRAPS.md file's content holds, in file order — the pure read the Board's per-piece
 *  material uses on bytes the Collection query has already read (no second disk read). */
export function scrapsInContent(content: string): Array<{ id: string; text: string; done: boolean }> {
  return parseScrapsFile(content).flatMap((block) => (block.kind === 'scrap' ? [{ id: block.id, text: bodyText(block), done: block.done }] : []))
}

/**
 * A scrap taken out of a SCRAPS.md file's content: the pure half of `ScrapStore.remove`, for callers
 * that write the file themselves under one restore point (the Board's offcut-to-idea and
 * add-to-end-of-piece). `next` is null when nothing is left, meaning the file is deleted, as remove does.
 * Every other section stays byte-identical. Throws when the file holds no scrap with that id.
 */
export function removeScrapFromContent(content: string, id: string): { next: string | null; scrap: { id: string; text: string } } {
  const blocks = parseScrapsFile(content)
  const index = blocks.findIndex((b) => b.kind === 'scrap' && b.id === id)
  if (index === -1) throw new Error(`No scrap with id ${id}.`)
  const block = blocks[index] as ScrapBlock
  blocks.splice(index, 1)
  const next = serializeBlocks(blocks)
  return { next: next === '' ? null : next, scrap: { id: block.id, text: bodyText(block) } }
}

/**
 * The workspace-relative SCRAPS.md path for an origin document. Per the locked design (ADR-0008,
 * "every folder can have a scraps/ subfolder") scraps live BESIDE their origin: `a/b/notes.md` →
 * `a/b/scraps/notes-SCRAPS.md`; a root-level `notes.md` → `scraps/notes-SCRAPS.md`. Keeping scraps in
 * the origin's own folder makes basename collisions (`a/notes.md` vs `b/notes.md`) structurally
 * impossible — each lands in a distinct `scraps/` directory.
 */
export function scrapsPathFor(origin: string): string {
  const dir = posix.dirname(origin)
  const stem = posix.basename(origin).replace(MARKDOWN_EXTENSION, '')
  const folder = dir === '.' ? SCRAPS_DIR : `${dir}/${SCRAPS_DIR}`
  return `${folder}/${stem}-SCRAPS.md`
}

/** Inverse of scrapsPathFor: the origin a SCRAPS.md belongs to. `a/b/scraps/notes-SCRAPS.md` →
 *  `a/b/notes.md`; `scraps/notes-SCRAPS.md` → `notes.md`. */
export function originForScrapsPath(rel: string): string {
  const parent = posix.dirname(posix.dirname(rel)) // strip the file, then the `scraps/` dir
  const stem = posix.basename(rel).replace(SCRAPS_SUFFIX, '')
  return parent === '.' ? `${stem}.md` : `${parent}/${stem}.md`
}

/** True for a store-shaped scraps container: a `*-SCRAPS.md` sitting DIRECTLY inside a `scraps/`
 *  folder. A stray `foo-SCRAPS.md` elsewhere is neither a scraps file nor (since list() walks only
 *  these) mistaken for an origin. */
export function isScrapsPath(rel: string): boolean {
  return SCRAPS_SUFFIX.test(rel) && posix.basename(posix.dirname(rel)) === SCRAPS_DIR
}

let idCounter = 0
/** A store-namespaced, monotonically-unique id (time + counter + entropy); regenerated on the
 *  vanishingly rare in-file collision. */
function generateId(taken: Set<string>): string {
  let id = ''
  do {
    id = `s_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`
  } while (taken.has(id))
  return id
}

/**
 * What adding a scrap appends to a scraps file holding `existing` ('' for a new file): the bytes to
 * append and the new scrap's id and text. Pure, so a writer with its own write discipline (the command
 * line) appends exactly what the store does. Append-only: a single blank line separates the new
 * section from whatever is already there, and no existing byte is touched (foreign content and
 * earlier scraps are preserved exactly).
 */
export function scrapAddition(existing: string, text: string): { addition: string; id: string; text: string } {
  const taken = new Set(parseScrapsFile(existing).flatMap((b) => (b.kind === 'scrap' ? [b.id] : [])))
  const id = generateId(taken)
  const bodyLines = text.replace(/\n+$/, '').split('\n')
  const section = `${[`## ${id}`, ...bodyLines].join('\n')}\n`
  const separator = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return { addition: separator + section, id, text: bodyLines.join('\n').replace(/^\n+/, '') }
}

/**
 * File-native Scraps store (ADR-0008). One `## <id> <flags>` section per scrap in a `scraps/`
 * subfolder beside its origin (`a/b/notes.md` → `a/b/scraps/notes-SCRAPS.md`); bodies are verbatim,
 * foreign content is preserved, and every edit rewrites only its owned heading line. All writes go
 * through the Workspace guard, are atomic (temp-file + rename), and the `scraps/` directory is created
 * on the first add (a user-initiated write, so sanctioned).
 *
 * Every operation is SERIALISED through one promise chain (`#run`). add/#edit/remove each do a
 * read-modify-write of a contract file; unguarded concurrent calls — fire-and-forget pane actions
 * today, agent writes tomorrow — race and silently drop scraps or flags, and a lost cut is
 * IRRECOVERABLE writing. list() rides the same chain so a read never observes a half-applied mutation.
 */
export class ScrapStore {
  /** The serialisation chain: one op after another, and one failed op (e.g. remove of a missing id)
   *  never poisons the ops queued behind it. It is the same chain as the Collection's write turn
   *  (collection-write-turn.ts), so code running inside one of its ops that asks for the queue again
   *  runs at once: a decision on a Change holds the queue and then runs a capability that asks for it. */
  readonly #queue = new CollectionWriteTurn()

  constructor(private readonly ws: Workspace) {}

  /** Queue `op` after everything already in flight, returning ITS result/rejection to the caller while
   *  leaving the shared chain settled-successfully for the next op. */
  #run<T>(op: () => Promise<T>): Promise<T> {
    return this.#queue.run(op)
  }

  /**
   * A write of a scraps file: on the store's chain and then, from its read to its write, one turn of
   * the Collection's write turn (collection-write-turn.ts), since a scraps file is a file of the
   * Collection like any document. Queue first, turn second: the one order (collection-write-order.ts).
   */
  #write<T>(op: () => Promise<T>): Promise<T> {
    return this.#run(() => this.ws.exclusiveAll(op))
  }

  /** Every store-shaped SCRAPS.md across the workspace, workspace-relative and sorted. Discovered via
   *  the Workspace file walk (so per-folder `scraps/` dirs anywhere are found) and filtered to the
   *  store's path shape — the origin documents themselves are never included. */
  private async scrapFiles(): Promise<string[]> {
    return (await this.ws.listFiles()).map((f) => f.path).filter(isScrapsPath).sort()
  }

  /** Atomic SCRAPS.md write: stage to a sibling temp file, then rename over the target. A SCRAPS.md is
   *  a contract file (round-trips byte-exact), and rename is atomic on one filesystem, so a crash
   *  mid-write can never leave a truncated or half-written scraps file. The temp name is not
   *  `*-SCRAPS.md`, so a stranded temp is never picked up as a scraps file.
   *  Why this needs no checked append (checked-store-append.ts): `rename` replaces whatever stands at
   *  the target, a link included, instead of following it, and the staged name is random, so no file
   *  planted at either name is ever written through. */
  async #writeAtomic(abs: string, content: string): Promise<void> {
    assertCollectionWritable(this.ws.root)
    const tmp = `${abs}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, abs)
  }

  /** How many ops are waiting for the queue. @internal For tests: a handshake in place of a pause. */
  get waiting(): number {
    return this.#queue.waiting
  }

  /** Run `op` on the store's serialisation chain, so a caller that rewrites a scraps file itself (under
   *  its own restore point) can never interleave with a pane or agent scrap write. */
  exclusive<T>(op: () => Promise<T>): Promise<T> {
    return this.#run(op)
  }

  async list(scope?: { origin?: string }): Promise<Scrap[]> {
    return this.#run(async () => {
      const wanted = scope?.origin ? scrapsPathFor(scope.origin) : null
      const out: Scrap[] = []
      for (const rel of await this.scrapFiles()) {
        if (wanted !== null && rel !== wanted) continue
        const origin = originForScrapsPath(rel)
        const content = await readFile(this.ws.absolute(rel), 'utf8')
        for (const block of parseScrapsFile(content)) if (block.kind === 'scrap') out.push(toScrap(block, origin))
      }
      return out
    })
  }

  async add(origin: string, text: string): Promise<Scrap> {
    return this.#write(async () => {
      const rel = scrapsPathFor(origin)
      assertCollectionWritable(this.ws.root)
      await mkdir(this.ws.absolute(posix.dirname(rel)), { recursive: true })
      const abs = this.ws.absolute(rel)
      const existing = existsSync(abs) ? await readFile(abs, 'utf8') : ''
      const { addition, id, text: body } = scrapAddition(existing, text)
      await this.#writeAtomic(abs, existing + addition)
      return { id, origin: originForScrapsPath(rel), text: body, done: false }
    })
  }

  async toggleDone(id: string): Promise<void> {
    await this.#edit(id, (block) => {
      block.done = !block.done
      block.dirty = true
    })
  }

  async setColour(id: string, colour: string | null): Promise<void> {
    // The colour rides in the heading as `(colour)`, tokenised on whitespace; a value containing a
    // space, newline, or paren would re-break the heading on the next parse and silently orphan the
    // scrap (matchScrapHeading rejects the malformed token → the whole section reads as foreign). The
    // dot palette is simple tokens (`#e8a`, `rose`), so require one — reject anything that could break
    // the heading. Clear with null, not an empty string.
    if (colour !== null && !/^[^\s()]+$/.test(colour)) {
      throw new Error('A scrap colour must be a single token with no spaces or parentheses.')
    }
    await this.#edit(id, (block) => {
      block.colour = colour ?? undefined
      block.dirty = true
    })
  }

  /** Remove a scrap, returning it so the caller can paste it back (drag-into-document, undo). */
  async remove(id: string): Promise<Scrap> {
    return this.#write(async () => {
      for (const rel of await this.scrapFiles()) {
        const abs = this.ws.absolute(rel)
        const blocks = parseScrapsFile(await readFile(abs, 'utf8'))
        const index = blocks.findIndex((b) => b.kind === 'scrap' && b.id === id)
        if (index === -1) continue
        const removed = toScrap(blocks[index] as ScrapBlock, originForScrapsPath(rel))
        blocks.splice(index, 1)
        const next = serializeBlocks(blocks)
        // Nothing left (no foreign preamble either): drop the now-empty file rather than leave a husk.
        assertCollectionWritable(this.ws.root)
        if (next === '') await unlink(abs)
        else await this.#writeAtomic(abs, next)
        return removed
      }
      throw new Error(`No scrap with id ${id}.`)
    })
  }

  /**
   * Remove ONE scrap section from the scraps file of ONE named origin — the origin-qualified removal
   * the Scratchpad's Delete forever uses. Unlike `remove(id)` (the long-standing global-id API, kept
   * unchanged for its callers), this never looks in another origin's file, so copied legacy files
   * that share an `s_…` id cannot lose the wrong section. The file is derived from `origin` alone
   * (`scrapsPathFor`), must stand inside the Workspace as an ordinary file (a link at that name is
   * refused, never followed or replaced), and is written through the Workspace's guarded writer
   * ONLY over the exact text read here (`saveFileOverRead`: checked before the write and again in
   * the rename tick — the writer's documented final-syscall limit). A sibling section or foreign
   * run changed in the meantime therefore refuses whole, and every other byte stays as it was.
   * `expectedBodySha256`, when given, is the digest of the section body the caller showed for
   * confirmation: a body edited since refuses. `expected.beforeCommit`, when given, is the caller's
   * synchronous dependent-authority check (the Scratchpad's checked index version): it is carried
   * to the guarded writer's `beforeCommit`, so it runs in the tick of the rename that commits this
   * removal, after staging, and a refusal there leaves the scraps file untouched. It does not make
   * the two files one transaction — the writer's final-syscall limit stands. An emptied owned file
   * is left standing empty rather than unlinked here.
   */
  async removeAtOrigin(origin: string, id: string, expected?: { bodySha256: string; beforeCommit?: () => void }): Promise<Scrap> {
    if (!SCRAP_ID.test(id)) throw new Error(`No scrap with id ${id}.`)
    const rel = scrapsPathFor(origin)
    if (!isScrapsPath(rel)) throw new Error(`No scrap with id ${id}.`)
    return this.#write(async () => {
      const abs = this.ws.absolute(rel)
      let entry
      try { entry = lstatSync(abs) } catch { throw new Error(`No scrap with id ${id}.`) }
      if (!entry.isFile()) throw new Error(`${rel} is not an ordinary file (a link or something else stands at that name), so nothing was removed.`)
      const content = await readFile(abs, 'utf8')
      const blocks = parseScrapsFile(content)
      const index = blocks.findIndex((b) => b.kind === 'scrap' && b.id === id)
      if (index === -1) throw new Error(`No scrap with id ${id}.`)
      const block = blocks[index] as ScrapBlock
      if (expected && createHash('sha256').update(bodyText(block), 'utf8').digest('hex') !== expected.bodySha256) {
        throw new Error('That scrap changed since it was shown, so it was kept.')
      }
      const removed = toScrap(block, originForScrapsPath(rel))
      blocks.splice(index, 1)
      const next = serializeBlocks(blocks)
      await scrapStoreSeams.afterRemoveAtOriginRead?.()
      try {
        await this.ws.saveFileOverRead(rel, next, content, { allowExplicitEmpty: true, ...(expected?.beforeCommit ? { beforeCommit: expected.beforeCommit } : {}) })
      } catch (error) {
        // Committed and not read back: removed.
        if (!(error instanceof SavedButNotReadBack)) throw error
      }
      return removed
    })
  }

  /** Locate the file holding `id`, apply `mutate` to its block, and write the section back — serialised
   *  on the shared chain so a concurrent edit of a sibling scrap can never clobber this one. */
  async #edit(id: string, mutate: (block: ScrapBlock) => void): Promise<void> {
    return this.#write(async () => {
      for (const rel of await this.scrapFiles()) {
        const abs = this.ws.absolute(rel)
        const blocks = parseScrapsFile(await readFile(abs, 'utf8'))
        const block = blocks.find((b) => b.kind === 'scrap' && b.id === id) as ScrapBlock | undefined
        if (!block) continue
        mutate(block)
        await this.#writeAtomic(abs, serializeBlocks(blocks))
        return
      }
      throw new Error(`No scrap with id ${id}.`)
    })
  }
}
