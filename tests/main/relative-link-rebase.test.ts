/**
 * Relative links carried along when documents move (src/main/relative-link-rebase.ts): what is rewritten, what is
 * left alone (web addresses, anchors, code), and how a destination is written (encoded, or in angle brackets).
 */
import { describe, expect, test } from 'bun:test'
import { posix } from 'node:path'
import { rebaseRelativeLinks, relativeFrom } from '../../src/main/relative-link-rebase'
import { parseMarkdown } from '../../src/shared/markdown/dialect'

const moves = new Map([['notes/planning.md', 'notes/Pack/planning.md']])
const where = (path: string): string => moves.get(path) ?? path

describe('rebaseRelativeLinks', () => {
  test('a moved document: links, images, reference definitions and embed lines are written from its new folder', () => {
    const source = '[p](planning.md#top) ![i](img/a%20b.png "t") [w](https://x.y) [s](#here) [m](mailto:a@b.c)\n\n[r]: <reading list.md>\n\n[Simulation: visualisations/w/widget.html]\n'
    expect(rebaseRelativeLinks(source, 'notes/c.md', 'notes/Pack/c.md', where).text).toBe(
      '[p](planning.md#top) ![i](../img/a%20b.png "t") [w](https://x.y) [s](#here) [m](mailto:a@b.c)\n\n[r]: <../reading list.md>\n\n[Simulation: ../visualisations/w/widget.html]\n',
    )
  })

  test('code is never touched: inline code, fenced and indented blocks, and an embed line inside a fence', () => {
    const source = '`[x](planning.md)`\n\n```\n[x](planning.md)\n[Simulation: w.html]\n```\n\n    [x](planning.md)\n'
    expect(rebaseRelativeLinks(source, 'notes/c.md', 'notes/Pack/c.md', where)).toEqual({ text: source, rewritten: 0 })
  })

  test('a document that stays: only links to moved files change, spaces encoded', () => {
    const source = '[p](planning.md) [q](./other.md) [r](../top.md)\n'
    expect(rebaseRelativeLinks(source, 'notes/o.md', 'notes/o.md', (path) => (path === 'notes/planning.md' ? 'notes/My Pack/planning.md' : path)).text).toBe('[p](My%20Pack/planning.md) [q](./other.md) [r](../top.md)\n')
  })

  test('a link that leaves the Workspace is left as it is', () => {
    expect(rebaseRelativeLinks('[x](../../out.md)\n', 'notes/c.md', 'notes/Pack/c.md', where).text).toBe('[x](../../out.md)\n')
  })

  test('relativeFrom: from the Workspace folder, a sibling folder and the same folder', () => {
    expect(relativeFrom('', 'a/b.md')).toBe('a/b.md')
    expect(relativeFrom('a/c', 'a/b.md')).toBe('../b.md')
    expect(relativeFrom('a', 'a')).toBe('.')
  })
})

/** The links of `text` as the app's Markdown parser finds them, each resolved the CommonMark way from `dir`
 *  (independently of the module): the angle brackets off, backslash escapes read, the path cut at the first `#`
 *  or `?`, its percent-escapes decoded. */
function resolvedLinks(text: string, dir: string): Array<{ path: string; suffix: string }> {
  const out: Array<{ path: string; suffix: string }> = []
  const cursor = parseMarkdown(text).cursor()
  do {
    if (cursor.name !== 'URL' || cursor.node.parent?.name !== 'Link') continue
    let raw = text.slice(cursor.from, cursor.to)
    if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1)
    const unescaped = raw.replace(/\\([!-/:-@[-`{-~])/g, '$1')
    const cut = unescaped.search(/[#?]/)
    const path = cut < 0 ? unescaped : unescaped.slice(0, cut)
    out.push({ path: posix.normalize(posix.join(dir || '.', decodeURIComponent(path))), suffix: cut < 0 ? '' : unescaped.slice(cut) })
  } while (cursor.next())
  return out
}

describe('destinations keep naming the same file (review r1, P1 link rewriting)', () => {
  test('a folder name with # stays part of the path: [a](a.md) into "Notes #2"', () => {
    const out = rebaseRelativeLinks('[a](a.md)\n', 'n/o.md', 'n/o.md', (path) => (path === 'n/a.md' ? 'n/Notes #2/a.md' : path)).text
    expect(out).toBe('[a](Notes%20%232/a.md)\n')
    expect(resolvedLinks(out, 'n')).toEqual([{ path: 'n/Notes #2/a.md', suffix: '' }])
  })

  test('an encoded # in a file name stays encoded: [a](a%23b.md) from a moved document', () => {
    const out = rebaseRelativeLinks('[a](a%23b.md)\n', 'n/c.md', 'n/P/c.md', (path) => path).text
    expect(out).toBe('[a](../a%23b.md)\n')
    expect(resolvedLinks(out, 'n/P')).toEqual([{ path: 'n/a#b.md', suffix: '' }])
  })

  test('an angle-bracket destination is decoded too: [a](<a%20b.md>) follows "a b.md" and keeps its brackets', () => {
    const out = rebaseRelativeLinks('[a](<a%20b.md>)\n', 'n/o.md', 'n/o.md', (path) => (path === 'n/a b.md' ? 'n/P/a b.md' : path)).text
    expect(out).toBe('[a](<P/a%20b.md>)\n')
    expect(resolvedLinks(out, 'n')).toEqual([{ path: 'n/P/a b.md', suffix: '' }])
  })

  test('escaped parentheses are kept as they were written, and new ones are encoded', () => {
    expect(rebaseRelativeLinks('[a](a\\(1\\).md)\n', 'n/c.md', 'n/P/c.md', (path) => path).text).toBe('[a](../a\\(1\\).md)\n')
    const out = rebaseRelativeLinks('[a](a.md#x)\n', 'n/o.md', 'n/o.md', (path) => (path === 'n/a.md' ? 'n/P (1)?/a.md' : path)).text
    expect(out).toBe('[a](P%20%281%29%3F/a.md#x)\n')
    expect(resolvedLinks(out, 'n')).toEqual([{ path: 'n/P (1)?/a.md', suffix: '#x' }])
  })

  test('a % that starts no escape is a %; written again, it is encoded so it stays one', () => {
    const out = rebaseRelativeLinks('[a](<100%.md>)\n', 'n/o.md', 'n/o.md', (path) => (path === 'n/100%.md' ? 'n/50% off/100%.md' : path)).text
    expect(out).toBe('[a](<50%25 off/100%.md>)\n')
  })
})

describe('round trip: any file name, either form, moved document or one that stays', () => {
  // A small seeded generator, so a failure names a case that can be run again.
  let seed = 0x2f6b
  const random = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32 }
  const ALPHABET = ['a', 'b', 'Z', '1', ' ', ' ', '#', '?', '%', '(', ')', '<', '>', '\\', '&', 'é', '-', '.', '_', '[', ']', '!', '*', "'"]
  const name = (): string => {
    for (;;) {
      const length = 1 + Math.floor(random() * 8)
      let out = ''
      for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(random() * ALPHABET.length)]
      if (out.trim() !== out || out === '.' || out === '..' || out.startsWith('.')) continue
      return out
    }
  }
  /** A destination for `path`, written as an author might: fully encoded, with escaped parentheses, or in brackets. */
  const write = (path: string): string => {
    const style = Math.floor(random() * 3)
    if (style === 2) return `<${path.split('/').map((segment) => segment.replace(/[%#?<>\\]/g, (c) => encodeURIComponent(c).replace('%5C', '%5C'))).join('/')}>`
    const encoded = path.split('/').map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
    return style === 1 ? encoded.replace(/%28/g, '\\(').replace(/%29/g, '\\)') : encoded
  }

  test('300 cases: every link still resolves to the same file, keeps its fragment, and stays one link', () => {
    for (let i = 0; i < 300; i += 1) {
      const file = `${name()}.md`
      const folder = name()
      const fragment = random() < 0.3 ? '#part' : ''
      const link = (path: string): string => { const dest = write(path); return `See [the file](${dest.startsWith('<') ? `${dest.slice(0, -1)}${fragment}>` : `${dest}${fragment}`}) here.\n` }
      const where = new Map<string, string>()
      let text: string
      let from: string
      let to: string
      let expected: string
      if (random() < 0.5) {
        // The document moves into the new folder; the file it links to stays.
        text = link(file)
        from = 'n/doc.md'
        to = `n/${folder}/doc.md`
        expected = `n/${file}`
      } else {
        // The file moves; the document that links to it stays.
        text = link(file)
        from = 'n/doc.md'
        to = from
        where.set(`n/${file}`, `n/${folder}/${file}`)
        expected = `n/${folder}/${file}`
      }
      const out = rebaseRelativeLinks(text, from, to, (path) => where.get(path) ?? path).text
      const links = resolvedLinks(out, posix.dirname(to))
      const context = `case ${i}: ${JSON.stringify({ text, from, to, out })}`
      expect(links, context).toEqual([{ path: expected, suffix: fragment }])
      expect(out.startsWith('See [the file](') && out.endsWith(') here.\n'), context).toBe(true)
      // The original form is kept: angle brackets stay angle brackets, and a plain destination stays plain.
      expect(out.includes('](<'), context).toBe(text.includes('](<'))
    }
  })
})
