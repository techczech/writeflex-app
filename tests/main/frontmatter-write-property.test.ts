import { expect, test } from 'bun:test'
import { removeFrontmatterKeys, setFrontmatterKeys } from '../../src/main/capabilities'
import { frontmatterBlock } from '../../src/shared/markdown/frontmatter'
import { parseFrontmatterEntries } from '../../src/shared/object-markup'

type Fixture = {
  name: string
  inner: string
  outcome: 'write' | 'refuse'
  removeOutcome?: 'write' | 'refuse'
  offender?: string
}

const fixtures: Fixture[] = [
  {
    name: 'simple scalars',
    inner: 'date: 2026-08-01\nstatus: idea\npurpose: essay',
    outcome: 'write',
  },
  {
    name: 'unindented simple list',
    inner: 'tags:\n- alpha\n- beta\nstatus: idea',
    outcome: 'write',
  },
  {
    name: 'tab-indented simple list',
    inner: 'related:\n\t- Alpha\n\t- Beta\nstatus: idea',
    outcome: 'write',
  },
  {
    name: 'blank lines and full-line comments',
    inner: '# metadata note\n\nstatus: idea\npurpose: essay\n  # indented note',
    outcome: 'write',
  },
  {
    name: 'same-line closed double quote followed by real keys',
    inner: 'description: "A # and : stay quoted"\nstatus: idea\npurpose: essay',
    outcome: 'write',
  },
  {
    name: 'single-quoted scalar with doubled-quote escapes',
    inner: "description: 'Morgan''s draft'\nstatus: idea",
    outcome: 'write',
  },
  {
    name: 'inline list remains an untouched single-line value',
    inner: 'related: [One, Two]\nstatus: idea',
    outcome: 'write',
  },
  {
    name: 'empty scalar tail followed immediately by a real key',
    inner: 'purpose:\nstatus: idea',
    outcome: 'write',
  },
  {
    name: 'quoted bystander key',
    inner: '"another one": original\nstatus: idea',
    outcome: 'write',
    removeOutcome: 'refuse',
    offender: 'another one',
  },
  {
    name: 'spaced bystander key',
    inner: 'another one: original\nstatus: idea',
    outcome: 'write',
    removeOutcome: 'refuse',
    offender: 'another one',
  },
  {
    name: 'dotted bystander key',
    inner: 'my.key: original\nstatus: idea',
    outcome: 'write',
    removeOutcome: 'refuse',
    offender: 'my.key',
  },
  {
    name: 'Unicode bystander key',
    inner: 'název: původní\nstatus: idea',
    outcome: 'write',
  },
  {
    name: 'leading-indented bystander key',
    inner: '  another one: original\nstatus: idea',
    outcome: 'refuse',
    offender: 'another one',
  },
  {
    name: 'all-space bystander key',
    inner: '   : original\nstatus: idea',
    outcome: 'refuse',
    offender: ': original',
  },
  {
    name: 'all-dot bystander key',
    inner: '...: original\nstatus: idea',
    outcome: 'refuse',
    offender: '...: original',
  },
  {
    name: 'trailing-space bystander key',
    inner: 'goal : 500\nstatus: idea',
    outcome: 'refuse',
    offender: 'goal : 500',
  },
  {
    name: 'nested map list',
    inner: 'authors:\n  - name: Ada\n    role: editor\nstatus: idea',
    outcome: 'refuse',
    offender: '- name: Ada',
  },
  {
    name: 'blank-line-wrapped scalar',
    inner: 'description: opening words\n\n  closing words\nstatus: idea',
    outcome: 'refuse',
    offender: 'closing words',
  },
  {
    name: 'wrapped status continuation',
    inner: 'status: idea and\n  more words',
    outcome: 'refuse',
    offender: 'status',
  },
  {
    name: 'blank-line-wrapped status continuation',
    inner: 'status: idea and\n\n  more words',
    outcome: 'refuse',
    offender: 'more words',
  },
  {
    name: 'blank line inside list',
    inner: 'tags:\n  - alpha\n\n  - beta\nstatus: idea',
    outcome: 'refuse',
    offender: '- beta',
  },
  {
    name: 'leading blank before list',
    inner: 'tags:\n\n  - alpha\nstatus: idea',
    outcome: 'refuse',
    offender: '- alpha',
  },
  {
    name: 'colon key with quoted multiline value',
    inner: '"key:with:colon": "opening\nstatus: embedded\nclosing"\nstatus: idea',
    outcome: 'refuse',
    offender: 'key:with:colon',
  },
  {
    name: 'plain colon-bearing key with empty value',
    inner: 'key:with:\nstatus: idea',
    outcome: 'refuse',
    offender: 'key:with:',
  },
  {
    name: 'anchor and alias',
    inner: 'status: &stage idea\nprevious: *stage',
    outcome: 'refuse',
    offender: 'status',
  },
  {
    name: 'anchor hidden behind extra list-item spacing',
    inner: 'stages:\n  -   &stage idea\nstatus: idea',
    outcome: 'refuse',
    offender: '-   &stage idea',
  },
  {
    name: 'unterminated quote hidden behind extra list-item spacing',
    inner: 'stages:\n  -   "still open\nstatus: idea',
    outcome: 'refuse',
    offender: '-   "still open',
  },
  {
    name: 'alias value',
    inner: 'status: idea\nprevious: *stage',
    outcome: 'refuse',
    offender: 'previous',
  },
  {
    name: 'anchor inside an inline list',
    inner: 'related: [One, &source Two]\nstatus: idea',
    outcome: 'refuse',
    offender: 'related',
  },
  {
    name: 'alias inside an inline list',
    inner: 'related: [One, *source]\nstatus: idea',
    outcome: 'refuse',
    offender: 'related',
  },
  {
    name: 'unterminated double quote at closing fence',
    inner: 'description: "still open\nstatus: embedded',
    outcome: 'refuse',
    offender: 'description',
  },
  {
    name: 'unterminated single quote at closing fence',
    inner: "description: 'still open\nstatus: embedded",
    outcome: 'refuse',
    offender: 'description',
  },
  {
    name: 'single quote escape without a distinct closing quote',
    inner: "description: '''\nstatus: idea",
    outcome: 'refuse',
    offender: 'description',
  },
  {
    name: 'block scalar',
    inner: 'description: |\n  several words\nstatus: idea',
    outcome: 'refuse',
    offender: 'description',
  },
  {
    name: 'tagged scalar',
    inner: 'status: !stage idea',
    outcome: 'refuse',
    offender: 'status',
  },
  {
    name: 'directive',
    inner: '%YAML 1.2\nstatus: idea',
    outcome: 'refuse',
    offender: '%YAML 1.2',
  },
  {
    name: 'duplicate key',
    inner: 'status: idea\npurpose: essay\nstatus: ready',
    outcome: 'refuse',
    offender: 'status',
  },
  {
    name: 'orphan list item',
    inner: '- alpha\nstatus: idea',
    outcome: 'refuse',
    offender: '- alpha',
  },
  {
    name: 'empty key then blank then list',
    inner: 'tags:\n\n- alpha\nstatus: idea',
    outcome: 'refuse',
    offender: '- alpha',
  },
  {
    name: 'plain scalar with mapping-colon ambiguity',
    inner: 'description: label: value\nstatus: idea',
    outcome: 'refuse',
    offender: 'description',
  },
  {
    name: 'plain scalar with YAML comment ambiguity',
    inner: 'description: essay # working note\nstatus: idea',
    outcome: 'refuse',
    offender: 'description',
  },
  {
    name: 'quoted key',
    inner: '"status": idea\npurpose: essay',
    outcome: 'refuse',
    offender: '"status"',
  },
]

function documentFor(inner: string, eol: '\n' | '\r\n'): string {
  return `---\n${inner}\n---\n\n# Body\n\nBody stays.\n`.replaceAll('\n', eol)
}

function exactFrontmatterEntries(document: string): Map<string, string> {
  const bomless = document.startsWith('﻿') ? document.slice(1) : document
  const block = frontmatterBlock(bomless)
  if (!block) throw new Error('fixture has no frontmatter')
  const region = bomless.slice(0, block.end)
  const exact = [...region.matchAll(/([^\n]*)(\n|$)/g)]
    .filter((match) => match[0] !== '')
    .map((match) => ({ content: match[1].replace(/\r$/, ''), raw: match[0] }))
  exact.shift()
  exact.pop()
  const entries = new Map<string, string>()
  for (let index = 0; index < exact.length; index += 1) {
    const key = /^([A-Za-z0-9_-]+):/.exec(exact[index].content)?.[1]
    if (!key) continue
    let raw = exact[index].raw
    while (index + 1 < exact.length && /^[ \t]*- /.test(exact[index + 1].content)) {
      index += 1
      raw += exact[index].raw
    }
    entries.set(key, raw)
  }
  return entries
}

function frontmatterWithoutKeys(document: string, omitted: Set<string>): string {
  const bomless = document.startsWith('﻿') ? document.slice(1) : document
  const block = frontmatterBlock(bomless)
  if (!block) throw new Error('fixture has no frontmatter')
  const region = bomless.slice(0, block.end)
  const exact = [...region.matchAll(/([^\n]*)(\n|$)/g)]
    .filter((match) => match[0] !== '')
    .map((match) => ({ content: match[1].replace(/\r$/, ''), raw: match[0] }))
  exact.shift()
  exact.pop()
  let kept = ''
  for (let index = 0; index < exact.length; index += 1) {
    const key = /^([A-Za-z0-9_-]+):/.exec(exact[index].content)?.[1]
    if (!key || !omitted.has(key)) {
      kept += exact[index].raw
      continue
    }
    while (index + 1 < exact.length && /^[ \t]*- /.test(exact[index + 1].content)) index += 1
  }
  return kept
}

function parsedRequestedValues(document: string): { status?: string; review_lanes?: string[] } {
  const bomless = document.startsWith('﻿') ? document.slice(1) : document
  const block = frontmatterBlock(bomless)
  if (!block) throw new Error('written result has no frontmatter')
  const parsed = parseFrontmatterEntries(block.lines.join('\n'))
  const status = parsed.find((entry) => entry.kind === 'scalar' && entry.key === 'status')
  const lanes = parsed.find((entry) => entry.kind === 'list' && entry.key === 'review_lanes')
  return {
    ...(status?.kind === 'scalar' ? { status: status.value } : {}),
    ...(lanes?.kind === 'list' ? { review_lanes: lanes.values } : {}),
  }
}

for (const fixture of fixtures) {
  for (const eol of ['\n', '\r\n'] as const) {
    test(`whole-block write property: ${fixture.name} (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
      const input = documentFor(fixture.inner, eol)
      const originalEntries = exactFrontmatterEntries(input)
      let output = input
      let refusal: unknown

      try {
        output = setFrontmatterKeys(input, {
          status: 'ready',
          review_lanes: ['copy', 'content'],
        }, `${fixture.name}.md`)
      } catch (error) {
        refusal = error
      }

      if (fixture.outcome === 'refuse') {
        expect(refusal).toBeInstanceOf(Error)
        expect((refusal as Error).message).toContain(`${fixture.name}.md`)
        expect((refusal as Error).message).toContain(fixture.offender!)
        expect(output).toBe(input)
        return
      }

      expect(refusal).toBeUndefined()
      expect(parsedRequestedValues(output)).toEqual({ status: 'ready', review_lanes: ['copy', 'content'] })
      const outputEntries = exactFrontmatterEntries(output)
      for (const [key, lines] of originalEntries) {
        if (key === 'status' || key === 'review_lanes') continue
        expect(outputEntries.get(key)).toBe(lines)
      }
      expect(frontmatterWithoutKeys(output, new Set(['status', 'review_lanes'])))
        .toBe(frontmatterWithoutKeys(input, new Set(['status', 'review_lanes'])))
      const inputBody = input.slice(frontmatterBlock(input)!.end)
      const outputBody = output.slice(frontmatterBlock(output)!.end)
      expect(outputBody).toBe(inputBody)
    })
  }
}

test('removeFrontmatterKeys applies the same whole-block gate before removing anything', () => {
  for (const fixture of fixtures) {
    for (const eol of ['\n', '\r\n'] as const) {
      const input = documentFor(fixture.inner, eol)
      if ((fixture.removeOutcome ?? fixture.outcome) === 'refuse') {
        expect(() => removeFrontmatterKeys(input, ['status'], `${fixture.name}.md`)).toThrow()
        expect(input).toBe(documentFor(fixture.inner, eol))
      } else {
        const output = removeFrontmatterKeys(input, ['status'], `${fixture.name}.md`)
        expect(output).toBe(input.replace(`status: idea${eol}`, ''))
      }
    }
  }
})

for (const key of ['název', 'my.key', 'another one', '"another one"']) {
  test(`an exotic target key is refused: ${key}`, () => {
    const input = documentFor(`${key}: original\nstatus: idea`, '\n')
    expect(() => setFrontmatterKeys(input, { [key]: 'edited' }, 'exotic-target.md')).toThrow()
    expect(() => removeFrontmatterKeys(input, [key], 'exotic-target.md')).toThrow()
    expect(input).toBe(documentFor(`${key}: original\nstatus: idea`, '\n'))
  })
}

test('a quoted spelling of a plain target is refused as the offending line', () => {
  const input = documentFor('"status": idea\npurpose: essay', '\n')
  expect(() => setFrontmatterKeys(input, { status: 'ready' }, 'quoted-target.md'))
    .toThrow(/cannot safely rewrite this block: line 2 reads .*"status": idea/)
})

test('an unsafe bystander refusal names the offending line as context', () => {
  const input = documentFor('key:with: value\nstatus: idea', '\n')
  expect(() => setFrontmatterKeys(input, { status: 'ready' }, 'colon-bystander.md'))
    .toThrow(/cannot safely rewrite this block: line 2 reads .*key:with: value/)
})

const scalarRoundTrips = [
  '~', 'no', 'null', 'yes', 'on', 'off', 'true', 'false',
  'a: b', '- lead', '# hash', "Morgan's draft", 'He said "revise"',
  'Reading *Ulysses*', 'Tom &Jerry', 'ordinary ! mark', '50% done',
  'name @ home', 'code `span`', 'left | right', 'left > right', 'why? yes',
]

for (const value of scalarRoundTrips) {
  for (const eol of ['\n', '\r\n'] as const) {
    test(`serialised scalar passes the write gate and round-trips exactly: ${JSON.stringify(value)} (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
      const body = `# Body${eol}${eol}Body stays.${eol}`
      const first = setFrontmatterKeys(body, { description: value }, 'round-trip.md')
      const output = setFrontmatterKeys(first, { status: 'ready' }, 'round-trip.md')
      const firstBlock = frontmatterBlock(first)
      const block = frontmatterBlock(output)
      expect(firstBlock).not.toBeNull()
      expect(block).not.toBeNull()
      const description = parseFrontmatterEntries(block!.lines.join('\n'))
        .find((entry) => entry.kind === 'scalar' && entry.key === 'description')
      expect(description).toEqual({ kind: 'scalar', key: 'description', value })
      expect(output.slice(block!.end)).toBe(first.slice(firstBlock!.end))
    })
  }
}

for (const eol of ['\n', '\r\n'] as const) {
  test(`removing the last key refuses to strand a comment-only frontmatter block (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const body = `# Body${eol}${eol}Body stays.${eol}`
    const input = `---${eol}goal: 500${eol}# keep this note${eol}---${eol}${eol}${body}`
    expect(() => removeFrontmatterKeys(input, ['goal'], 'comment.md'))
      .toThrow(/comment\.md.*line 3 reads .*keep this note/)
    expect(input).toBe(`---${eol}goal: 500${eol}# keep this note${eol}---${eol}${eol}${body}`)
  })

  test(`removing the only key drops a blank-only block and its separator (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const body = `# Body${eol}${eol}Body stays.${eol}`
    const input = `---${eol}goal: 500${eol}${eol}---${eol}${eol}${body}`
    expect(removeFrontmatterKeys(input, ['goal'], 'plain.md')).toBe(body)
  })

  test(`removing one of two keys preserves the other key line byte-for-byte (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const body = `# Body${eol}${eol}Body stays.${eol}`
    const input = `---${eol}goal: 500${eol}status:\tidea${eol}---${eol}${eol}${body}`
    expect(removeFrontmatterKeys(input, ['goal'], 'two-keys.md'))
      .toBe(`---${eol}status:\tidea${eol}---${eol}${eol}${body}`)
  })

  test(`removing a goal beside a Unicode-keyed remainder succeeds (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const input = documentFor('název: Ahoj\ngoal: 500', eol)
    expect(removeFrontmatterKeys(input, ['goal'], 'unicode-remainder.md'))
      .toBe(documentFor('název: Ahoj', eol))
  })

  for (const [name, bystander] of [
    ['double-quoted bystander', '"title": Ahoj'],
    ['spaced quoted bystander', '"another one": Ahoj'],
  ] as const) {
    test(`removing the last plain key refuses to strand a ${name} (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
      const input = documentFor(`${bystander}\ngoal: 500`, eol)
      expect(() => removeFrontmatterKeys(input, ['goal'], 'stranded.md'))
        .toThrow(/stranded\.md.*line 2 reads/)
      expect(input).toBe(documentFor(`${bystander}\ngoal: 500`, eol))
    })
  }

  test(`removing a missing key preserves an empty block byte-for-byte (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const input = `---${eol}${eol}---${eol}${eol}# Body${eol}`
    expect(removeFrontmatterKeys(input, ['goal'], 'empty.md')).toBe(input)
  })

  test(`remove refuses duplicate keys without changing bytes (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
    const input = documentFor('goal: 500\nstatus: idea\ngoal: 900', eol)
    expect(() => removeFrontmatterKeys(input, ['goal'], 'duplicate-remove.md'))
      .toThrow(/duplicate-remove\.md.*goal/)
    expect(input).toBe(documentFor('goal: 500\nstatus: idea\ngoal: 900', eol))
  })
}
