import { expect, test } from 'bun:test'
import { rewriteJsonArrayByKey, rewriteJsonObjectStringProperty } from '../../src/main/json-array-layout'

function files(source: string): Array<Record<string, unknown>> {
  return (JSON.parse(source) as { files: Array<Record<string, unknown>> }).files
}

test('S4: a single-line JSON document keeps its outer layout while entries are reordered and added', () => {
  const source = '{"schema":1,"files":[{"path":"a.md","keep":true}],"tail":{"exact":true}}'
  const next = rewriteJsonArrayByKey(source, 'files', 'path', [
    { path: 'b.md' },
    { path: 'a.md' },
  ])

  expect(files(next)).toEqual([{ path: 'b.md' }, { path: 'a.md', keep: true }])
  expect(next.startsWith('{"schema":1,"files":[')).toBe(true)
  expect(next.endsWith('],"tail":{"exact":true}}')).toBe(true)
})

test('S4: tab-indented entries retain their raw bytes through a round trip', () => {
  const source = '{\n\t"files": [\n\t\t{ "path": "a.md", "custom": [1, 2] },\n\t\t{\n\t\t\t"path": "b.md",\n\t\t\t"nested": {"quoted": "] }"}\n\t\t}\n\t],\n\t"tail": true\n}\n'
  const next = rewriteJsonArrayByKey(source, 'files', 'path', [
    { path: 'b.md' },
    { path: 'a.md' },
  ])

  expect(files(next)).toEqual([
    { path: 'b.md', nested: { quoted: '] }' } },
    { path: 'a.md', custom: [1, 2] },
  ])
  expect(next).toContain('\t\t{ "path": "a.md", "custom": [1, 2] }')
  expect(next).toContain('\t\t\t"nested": {"quoted": "] }"}')
})

test('S4: an empty files array accepts a first entry without changing surrounding whitespace', () => {
  const source = '{\n  "before" : true,\n  "files" : [  ],\n  "after"  : false\n}\n'
  const next = rewriteJsonArrayByKey(source, 'files', 'path', [{ path: 'first.md', id: 'first' }])

  expect(files(next)).toEqual([{ path: 'first.md', id: 'first' }])
  expect(next).toContain('"before" : true')
  expect(next).toContain('"after"  : false')
})

test('S4: unusual legal whitespace and escaped strings still locate the exact files array', () => {
  const source = ' \n { "note" : "files: [not the key]", \r\n "files"\t:\t[ {"path":"one.md","text":"\\\"[,]\\\""} ] , "z":0 } \n'
  const next = rewriteJsonArrayByKey(source, 'files', 'path', [{ path: 'one.md' }, { path: 'two.md' }])

  expect(files(next)).toEqual([
    { path: 'one.md', text: '"[,]"' },
    { path: 'two.md' },
  ])
  expect(next.startsWith(' \n { "note"')).toBe(true)
  expect(next.endsWith(' , "z":0 } \n')).toBe(true)
})

test('a surgical string-property rewrite refuses duplicate keys instead of changing the wrong occurrence', () => {
  const source = '{"path":"stale.md","path":"part.md","role":"section"}'

  expect(() => rewriteJsonObjectStringProperty(source, 'path', 'renamed.md')).toThrow(
    'Cannot surgically update JSON with duplicate path properties.',
  )
})

test('the layout writer refuses an invalid whole JSON document', () => {
  const source = '{"files":[{"path":"a.md"},]}'

  expect(() => rewriteJsonArrayByKey(source, 'files', 'path', [{ path: 'a.md' }])).toThrow()
})
