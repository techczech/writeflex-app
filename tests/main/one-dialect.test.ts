import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The "one dialect" rule (Round B Task 1) is a claim about the CODEBASE, not about one module: the
// editor and every emitter must parse Markdown with the same configuration, or an export drifts
// from what the writer sees. It was not true — inline-changes.ts still built its own GFM-only state,
// with no `==mark==` and no footnotes (finding 5) — and nothing would have caught the next one.
//
// So the rule is asserted structurally, over the source tree. A new Markdown configuration cannot
// be added anywhere in the app without either routing through markdownDialect() or failing here.

const SOURCE_ROOT = join(import.meta.dir, '../../src')
/** The one file allowed to name the raw building blocks: it IS the dialect. */
const DIALECT = 'shared/markdown/dialect.ts'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

const FILES = sourceFiles(SOURCE_ROOT).map((path) => ({
  relative: path.slice(SOURCE_ROOT.length + 1),
  text: readFileSync(path, 'utf8'),
}))

test('every Markdown parser configuration in the app is markdownDialect()', () => {
  const offenders = FILES.flatMap(({ relative, text }) =>
    [...text.matchAll(/markdown\(\{[^}]*\}/g)]
      .filter((call) => !call[0].includes('markdownDialect()'))
      .map((call) => `${relative}: ${call[0]}`))
  expect(offenders).toEqual([])
})

test('only the dialect itself names GFM or defines a MarkdownConfig', () => {
  const offenders = FILES
    .filter(({ relative }) => relative !== DIALECT)
    .filter(({ text }) => /\bGFM\b/.test(text.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '')) || /:\s*MarkdownConfig\b/.test(text))
    .map(({ relative }) => relative)
  expect(offenders).toEqual([])
})

test('nothing else reaches for the bare @lezer/markdown parser', () => {
  // Importing `parser` directly is the quiet way to end up with a second configuration: it is
  // CommonMark alone — no GFM, no `==mark==`, no footnotes. parseMarkdown() is the app's entry.
  const offenders = FILES
    .filter(({ relative }) => relative !== DIALECT)
    .filter(({ text }) => /import\s*\{[^}]*\bparser\b[^}]*\}\s*from\s*'@lezer\/markdown'/.test(text))
    .map(({ relative }) => relative)
  expect(offenders).toEqual([])
})
