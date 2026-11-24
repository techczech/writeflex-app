import { parseMarkdown } from '../shared/markdown/dialect'
import {
  buildWikilinkCandidateIndex, candidateFromMarkdown, extractWikilinks, type Candidate, type CandidateIndex,
} from './wikilinks'

export type MarkdownCodeRange = { from: number; to: number }

/** CommonMark code ranges, including container-aware blocks and paragraph-bounded inline spans. */
export function scanMarkdownCodeRanges(source: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = []
  const cursor = parseMarkdown(source).cursor()
  const visit = (): void => {
    if (cursor.name === 'CodeBlock' || cursor.name === 'FencedCode' || cursor.name === 'InlineCode') {
      ranges.push({ from: cursor.from, to: cursor.to })
      return
    }
    if (!cursor.firstChild()) return
    do visit()
    while (cursor.nextSibling())
    cursor.parent()
  }
  visit()
  return ranges
}

type MarkdownFacts = {
  source: string
  candidate?: Candidate
  links?: ReturnType<typeof extractWikilinks>
  codeRanges?: MarkdownCodeRange[]
}

const MAX_FILES = 10_000
const MAX_SOURCE_LENGTH = 8 * 1024 * 1024

/** Memoise syntax only after a fresh read matches the exact text at this path. */
export class RenameRepairMarkdownCache {
  #files = new Map<string, MarkdownFacts>()
  #sourceLength = 0
  #indexes = new Map<'before' | 'after', { candidates: Candidate[]; index: CandidateIndex }>()

  forFile(path: string, source: string): MarkdownFacts {
    const previous = this.#files.get(path)
    if (previous?.source === source) return previous
    const facts: MarkdownFacts = { source }
    if (previous) {
      this.#files.delete(path)
      this.#sourceLength -= previous.source.length
    }
    if (this.#files.size < MAX_FILES && this.#sourceLength + source.length <= MAX_SOURCE_LENGTH) {
      this.#files.set(path, facts)
      this.#sourceLength += source.length
    }
    return facts
  }

  candidateIndex(view: 'before' | 'after', files: ReadonlyArray<{ file: { path: string }; content: string }>): CandidateIndex {
    // The planner's overlay reads the last entry for a path. A preview may name an occupied destination.
    const sources = new Map(files.map(({ file, content }) => [file.path, content]))
    const candidates = files.map(({ file }) => {
      const source = sources.get(file.path)!
      const facts = this.forFile(file.path, source)
      return facts.candidate ??= candidateFromMarkdown(file.path, source)
    })
    const previous = this.#indexes.get(view)
    if (previous?.candidates.length === candidates.length && candidates.every((candidate, i) => candidate === previous.candidates[i])) {
      return previous.index
    }
    const index = buildWikilinkCandidateIndex(candidates)
    if (candidates.every((candidate) => this.#files.get(candidate.path)?.candidate === candidate)) {
      this.#indexes.set(view, { candidates, index })
    } else {
      this.#indexes.delete(view)
    }
    return index
  }
}
