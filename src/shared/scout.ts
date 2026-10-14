/**
 * Typed IPC shapes for archive search.
 *
 * The main process invokes an external search provider and maps its JSON output into
 * these types. Quoted source text is preserved unchanged.
 */

/** The corpora the panel's scope chips name; `all` omits `--in` so every indexed corpus is used. */
export type ArchiveScope = 'all' | 'writing' | 'tweets' | 'highlights'

export const ARCHIVE_SCOPES: readonly ArchiveScope[] = ['all', 'writing', 'tweets', 'highlights']

/** One document the engine ranked, carrying its best-scoring passage. */
export type ArchiveResult = {
  corpus: string
  title: string
  author: string | null
  /** The raw date (`2016`, `2016-06-23`, a tweet's UTC timestamp), or null when unknown. */
  date: string | null
  /** British display date ("23 June 2016"), or null. */
  dateDisplay: string | null
  genre: string | null
  /** The source system for tweets and highlights (`x`, `readwise`, `zotero`). */
  source: string | null
  publicUrl: string | null
  /** The best hit: its passage id is what `scout cite` takes. */
  passageId: string
  line: number
  /** The hit sentence (or passage) as ORIGINAL source text. */
  quote: string
  /** `writeflex://open?path=…&line=N` for writing and tweets; a `file://` URL for highlights. */
  link: string
  /** The CLI's own Markdown citation: `> quote`, a blank line, then the `— …` citation line. */
  citationMarkdown: string
}

export type ArchiveSearchResponse =
  | { status: 'ok'; query: string; corpora: string[]; totalDocuments: number; totalPassages: number; results: ArchiveResult[] }
  /** No `scout` binary on PATH or at ~/.cargo/bin/scout. */
  | { status: 'missing' }
  /** The binary ran but has no registry or index (exit 3), or refused the input (exit 2). */
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string }

/** The passage around a hit, for the "Passage" preview. `before`/`after` are the neighbouring prose
 *  lines of a writing piece (null for tweets, highlights, headings or a stale index). */
export type ArchivePassageResponse =
  | { status: 'ok'; passage: string; before: string | null; after: string | null }
  | { status: 'missing' }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string }

export type ArchiveSearchRequest = { query: string; scope?: ArchiveScope; limit?: number }
