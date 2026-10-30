import { expect, test } from 'bun:test'
import { MarkdownParser } from '@lezer/markdown'
import { stripComments, footnoteDefinitions } from '../../src/shared/markdown/dialect'
import { readDocument } from '../../src/shared/markdown/model'

// Pure synchronous instrumentation; restore even on failed assertions and preserve
// whether parse was inherited, so no parser state leaks into another test.
function counted<T>(run: () => T): { value: T; inputs: unknown[] } {
  const prototype = MarkdownParser.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'parse')
  const original = prototype.parse
  const inputs: unknown[] = []
  Object.defineProperty(prototype, 'parse', {
    configurable: true, writable: true,
    value: function (this: MarkdownParser, ...args: Parameters<typeof original>) {
      inputs.push(args[0])
      return original.apply(this, args)
    },
  })
  try { return { value: run(), inputs } }
  finally {
    if (descriptor) Object.defineProperty(prototype, 'parse', descriptor)
    else Reflect.deleteProperty(prototype, 'parse')
  }
}

test('cleaners skip code-range parsing without actual candidates and retain their distinct newline normalisation', () => {
  const text = 'start // inline text\n[^reference]\n\n\n\nend \t\n\n'
  const comments = counted(() => stripComments(text))
  expect(comments.value).toBe(text)
  const notes = counted(() => footnoteDefinitions(text))
  expect(notes.value).toEqual({ body: 'start // inline text\n[^reference]\n\nend', definitions: [] })
  expect({ commentInputs: comments.inputs, footnoteInputs: notes.inputs }).toEqual({ commentInputs: [], footnoteInputs: [] })
  expect(counted(() => stripComments('')).inputs).toEqual([])
  expect(counted(() => footnoteDefinitions('')).value).toEqual({ body: '', definitions: [] })
})

test('multiple comments share one code-range parse even when its ranges are empty; each call owns its cache', () => {
  const text = 'before\n// first\nkept\n// second\n'
  const result = counted(() => stripComments(text))
  expect(result.value).toBe('before\nkept\n')
  expect(result.inputs).toEqual([text])
  expect(counted(() => { stripComments(text); stripComments(text) }).inputs).toEqual([text, text])
})

test('multiple definitions and continuation lines share one code-range parse even when its ranges are empty', () => {
  const text = 'body\n\n[^one]: first\ncontinuation\n\n[^two]: second\n\n'
  const result = counted(() => footnoteDefinitions(text))
  expect(result.value).toEqual({ body: 'body', definitions: [{ label: 'one', text: 'first continuation' }, { label: 'two', text: 'second' }] })
  expect(result.inputs).toEqual([text])
  expect(counted(() => { footnoteDefinitions(text); footnoteDefinitions(text) }).inputs).toEqual([text, text])
})

test('comment candidates use original offsets: real comments leave, identical fenced and indented code stays', () => {
  const text = '// same\n\n```md\n// same\n```\n\n    // same\n\n// same\n\nend\n\n'
  const result = counted(() => stripComments(text))
  expect(result.value).toBe('\n```md\n// same\n```\n\n    // same\n\n\nend\n\n')
  expect(result.inputs).toEqual([text])
})

test('footnote candidates use original offsets: real notes lift, fenced and indented examples stay with normalisation', () => {
  const text = '[^same]: note\n\n```md\n[^same]: note\n```\n\n    [^same]: note\n\n[^last]: final\ncontinued\n\nTail \n\n'
  const result = counted(() => footnoteDefinitions(text))
  expect(result.value).toEqual({
    body: '\n```md\n[^same]: note\n```\n\n    [^same]: note\n\nTail',
    definitions: [{ label: 'same', text: 'note' }, { label: 'last', text: 'final continued' }],
  })
  expect(result.inputs).toEqual([text])
})

test('a modest comment-free and footnote-free table model needs only its final dialect parse', () => {
  const text = '| a | b |\n|---|---|\n| c | d |\n\n'.repeat(8)
  const result = counted(() => readDocument(text))
  expect(result.value.blocks.filter(block => block.kind === 'table')).toHaveLength(8)
  expect(result.inputs).toEqual([text.trimEnd()])
})
