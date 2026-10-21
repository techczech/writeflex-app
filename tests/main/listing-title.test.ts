import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileStem, listingTitle } from '../../src/shared/markdown/listing-title'
import { parseMarkdown, parseMarkdownBlocks } from '../../src/shared/markdown/dialect'
import { documentTitle } from '../../src/main/frontmatter'

// listingTitle is a cheaper road to documentTitle's answer. Every case below is checked against
// documentTitle itself, so the fixture states the rule and the comparison proves the agreement.
// The corpus test at the end runs the same comparison over every .md under WRITEFLEX_TITLE_CORPUS.

function same(source: string, expected: string, path = 'notes/piece.md'): void {
  expect(documentTitle(source, path)).toBe(expected)
  expect(listingTitle(source, path)).toBe(expected)
}

test('a piece with no heading is called by its file name, without the Markdown extension', () => {
  same('Just prose.\n\nMore prose.\n', 'piece')
  same('', 'Draft', 'a/b/Draft.markdown')
  same('Some text', 'idea', 'idea.mdx')
  expect(fileStem('x/y/Note.MD')).toBe('Note')
})

test('the first heading of any level wins, ATX or setext; a legacy title key never does', () => {
  same('---\ntitle: Legacy title\n---\n\n# Heading truth\n', 'Heading truth')
  same('Intro.\n\n## Supporting heading\n\n# Buried H1\n', 'Supporting heading')
  same('Underlined\n==========\n\n# Later\n', 'Underlined')
  same('Two lines\nof heading\n---\n', 'Two lines\nof heading')
  same('# Closing hashes ##\n', 'Closing hashes')
  same('# Hash#tag\n', 'Hash#tag')
  same('   ### Indented three\n', 'Indented three')
})

test('lines that only look like headings are not headings', () => {
  same('#NoSpace\n', 'piece')
  same('    # indented code\n', 'piece')
  same('```\n# in a fence\n```\n\n## After the fence\n', 'After the fence')
  same('~~~\n# in a tilde fence\n```\n# still fenced\n~~~\n# Out\n', 'Out')
  same('Para\n--\n', 'piece') // the dialect hides `-` and `--` from setext
  same('Para\n-\n', 'piece')
  same('***\n# After a rule\n', 'After a rule')
  same('<div>\n# inside an HTML block\n</div>\n\n# Outside\n', 'Outside')
  same('<!--\n# in a comment block\n-->\n# After the comment\n', 'After the comment')
})

test('a heading inside a list or a quote is not the piece title; one that closes them is', () => {
  same('- item\n  # nested heading\n', 'piece')
  same('> # quoted heading\n', 'piece')
  same('> quoted\n# After the quote\n', 'After the quote')
  same('- item\n# After the list\n', 'After the list')
  same('- item\nlazy line\n===\n', 'piece')
})

test('line endings, a byte-order mark, comments and footnote definitions are read as the model reads them', () => {
  same('\uFEFF# With a BOM\r\n\r\nBody\r\n', 'With a BOM')
  same('Title line\r\n===\r\n', 'Title line')
  same('// a post-it comment\n# After the comment line\n', 'After the comment line')
  same('```\n// kept in code\n```\nSetext\n===\n', 'Setext')
  same('[^1]: a note\n# Folded into the note\n\n## Real heading\n', 'Real heading')
  same('Text.\n\n[^1]: a note\n', 'piece')
})

test('the heading text loses its markup exactly as the model drops it', () => {
  same('# **Bold** and *em* and `code`\n', 'Bold and em and code')
  same('# ![](pic.png)Update\n', 'Update')
  same('# The [Drupal](http://drupal.org) choice\n', 'The Drupal choice')
  same('# Entrepreneurship and \\#EdStartup\n', 'Entrepreneurship and #EdStartup')
  same('# Fish &amp; chips\n', 'Fish & chips')
  same('# See [[Target|the label]] and [[Other]]\n', 'See the label and Other')
  same('# <span>tag</span> text\n', 'tag text')
  same('# ==marked== ~~struck~~\n', 'marked struck')
  same('#\n\n## Second\n', 'piece') // an empty first heading names nothing; it does not fall through
  same('# ![](only-a-picture.png)\n', 'piece')
})

test('a bracket in the heading resolves against definitions anywhere in the document', () => {
  same('# See [the spec]\n\nBody.\n\n[the spec]: https://example.org\n', 'See the spec')
  same('# See [the spec]\n\nBody.\n', 'See [the spec]')
  same('# Claim[^1]\n\nBody.\n\n[^1]: The source.\n', 'Claim')
  same('# Claim[^1]\n\nBody.\n', 'Claim[^1]')
})

test('the block layer has the dialect\'s blocks and no inline nodes', () => {
  const source = '# **Bold** `code` [l](u) ==m== ~~s~~ [^1] ^[n] <b>x</b> &amp; \\* https://x.org\n\n| a | b |\n|---|---|\n| c | d |\n\n- [ ] task\n\na. alpha\n\nPara\n===\n'
  const nodes = (tree: ReturnType<typeof parseMarkdown>): string[] => {
    const out: string[] = []
    const cursor = tree.cursor()
    do out.push(`${cursor.name}@${cursor.from}-${cursor.to}`)
    while (cursor.next())
    return out
  }
  const inline = /^(Emphasis|StrongEmphasis|InlineCode|Link|Image|Highlight|Strikethrough|FootnoteReference|FootnoteInline|HTMLTag|Entity|Escape|URL|Autolink)@/
  const block = /^(Document|ATXHeading\d|SetextHeading\d|Paragraph|Blockquote|BulletList|OrderedList|FancyList|ListItem|FencedCode|CodeBlock|HorizontalRule|HTMLBlock|CommentBlock|Table|TableHeader|TableRow|TableCell|LinkReference|Task)@/
  const blocks = nodes(parseMarkdownBlocks(source))
  expect(blocks.filter((node) => inline.test(node))).toEqual([])
  expect(blocks.filter((node) => block.test(node))).toEqual(nodes(parseMarkdown(source)).filter((node) => block.test(node)))
})

const corpus = process.env.WRITEFLEX_TITLE_CORPUS

test.skipIf(!corpus)('equivalence over WRITEFLEX_TITLE_CORPUS: every .md file gets documentTitle\'s answer', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.md')) files.push(path)
    }
  }
  walk(corpus as string)
  const mismatches: string[] = []
  let cheap = 0
  let full = 0
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    let started = performance.now()
    const listed = listingTitle(content, file)
    cheap += performance.now() - started
    started = performance.now()
    const titled = documentTitle(content, file)
    full += performance.now() - started
    if (listed !== titled) mismatches.push(`${file}\n  documentTitle: ${JSON.stringify(titled)}\n  listingTitle:  ${JSON.stringify(listed)}`)
  }
  console.log(`listing-title corpus: ${files.length} files, ${mismatches.length} mismatches; listingTitle ${cheap.toFixed(0)} ms, documentTitle ${full.toFixed(0)} ms`)
  if (mismatches.length) console.log(mismatches.join('\n'))
  expect(files.length).toBeGreaterThan(0)
  expect(mismatches).toEqual([])
}, 120_000)
