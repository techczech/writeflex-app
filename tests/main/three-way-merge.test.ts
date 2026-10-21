import { expect, test } from 'bun:test'
import { mergeCounts, mergedText, threeWayMerge, type ConflictPick } from '../../src/shared/three-way-merge'

const doc = (...paras: string[]): string => `${paras.join('\n\n')}\n`

/** Every chunk joined back, taking one side throughout: must give that side exactly (nothing lost). */
function side(merge: ReturnType<typeof threeWayMerge>, which: 'mine' | 'theirs' | 'base'): string {
  const out: string[] = []
  for (const chunk of merge.chunks) {
    if (chunk.kind === 'same') out.push(...chunk.lines)
    else if (chunk.kind === 'conflict') out.push(...chunk[which])
    else if (which === 'base') out.push(...chunk.base)
    else if (chunk.kind === 'both' || chunk.kind === which) out.push(...chunk.lines)
    else out.push(...chunk.base)
  }
  return out.join('\n')
}

test('clean merge: changes in different paragraphs combine on their own', () => {
  const base = doc('# Title', 'First paragraph.', 'Second paragraph.', 'Third paragraph.')
  const mine = doc('# Title', 'First paragraph, edited by me.', 'Second paragraph.', 'Third paragraph.')
  const theirs = doc('# Title', 'First paragraph.', 'Second paragraph.', 'Third paragraph, edited on disk.')
  const merge = threeWayMerge(base, mine, theirs)
  expect(merge.conflicts).toBe(0)
  expect(mergeCounts(merge)).toEqual({ fromDisk: 1, fromMine: 1, same: 0, conflicts: 0 })
  expect(mergedText(merge, [])).toBe(doc('# Title', 'First paragraph, edited by me.', 'Second paragraph.', 'Third paragraph, edited on disk.'))
})

test('insertions, deletions and an identical change on both sides: only what differs is asked', () => {
  const base = doc('A.', 'B.', 'C.', 'D.')
  const mine = doc('A.', 'New after A.', 'B.', 'C.', 'D!')
  const theirs = doc('A.', 'B.', 'D!')
  const merge = threeWayMerge(base, mine, theirs)
  // The disk's deletion of C runs into its change of D, which mine changed too: the one choice left is
  // C itself (kept by mine, deleted on disk); the change both made to D stands once.
  expect(merge.conflicts).toBe(1)
  expect(merge.chunks.find((chunk) => chunk.kind === 'conflict')).toMatchObject({ mine: ['C.', ''], theirs: [] })
  expect(mergedText(merge, ['theirs'])).toBe(doc('A.', 'New after A.', 'B.', 'D!'))
  expect(mergedText(merge, ['mine'])).toBe(doc('A.', 'New after A.', 'B.', 'C.', 'D!'))
  expect(merge.chunks.some((chunk) => chunk.kind === 'both')).toBe(true)
})

test('overlapping hunk: the same paragraph changed differently is a conflict, resolved per pick', () => {
  const base = doc('Intro.', 'The cat sat on the mat.', 'Outro.')
  const mine = doc('Intro.', 'The cat sat on the red mat.', 'Outro.')
  const theirs = doc('Intro.', 'The dog sat on the mat.', 'Outro, changed on disk.')
  const merge = threeWayMerge(base, mine, theirs)
  expect(merge.conflicts).toBe(1)
  const conflict = merge.chunks.find((chunk) => chunk.kind === 'conflict')
  expect(conflict).toEqual({ kind: 'conflict', index: 0, base: ['The cat sat on the mat.'], mine: ['The cat sat on the red mat.'], theirs: ['The dog sat on the mat.'] })
  expect(mergedText(merge, [])).toBeNull() // nothing from a half-made merge
  const pick = (p: ConflictPick): string | null => mergedText(merge, [p])
  expect(pick('mine')).toBe(doc('Intro.', 'The cat sat on the red mat.', 'Outro, changed on disk.'))
  expect(pick('theirs')).toBe(doc('Intro.', 'The dog sat on the mat.', 'Outro, changed on disk.'))
  // Keep both: mine first, then the disk's, a blank line between so the two paragraphs stay two.
  expect(pick('both')).toBe('Intro.\n\nThe cat sat on the red mat.\n\nThe dog sat on the mat.\n\nOutro, changed on disk.\n')
})

test('changes of neighbouring lines combine; an insertion touching a change is a conflict', () => {
  const base = 'a\nb\nc\nd'
  const neighbours = threeWayMerge(base, 'a\nB\nc\nd', 'a\nb\nC\nd')
  expect(neighbours.conflicts).toBe(0)
  expect(mergedText(neighbours, [])).toBe('a\nB\nC\nd')
  const touching = threeWayMerge(base, 'a\nB\nc\nd', 'a\nb\nnew\nc\nd')
  expect(touching.conflicts).toBe(1)
  expect(mergedText(touching, ['mine'])).toBe('a\nB\nc\nd')
  expect(mergedText(touching, ['theirs'])).toBe('a\nb\nnew\nc\nd')
})

test('two insertions at the same place are a conflict; both keeps mine first', () => {
  const merge = threeWayMerge('a\nz', 'a\nmine\nz', 'a\ntheirs\nz')
  expect(merge.conflicts).toBe(1)
  expect(mergedText(merge, ['both'])).toBe('a\nmine\n\ntheirs\nz')
})

test('Keep both separates two prose blocks by one blank line, and nothing else', () => {
  const both = (base: string, mine: string, theirs: string): string | null => {
    const merge = threeWayMerge(base, mine, theirs)
    expect(merge.conflicts).toBe(1)
    return mergedText(merge, ['both'])
  }
  // Prose and prose: one blank line between.
  expect(both('Intro.\n\nOld.\n', 'Intro.\n\nMy paragraph.\n', 'Intro.\n\nDisk paragraph.\n'))
    .toBe('Intro.\n\nMy paragraph.\n\nDisk paragraph.\n')
  // List items stay one list; table rows one table; headings and quotes are left as they are.
  expect(both('- a\n- b\n', '- a\n- mine\n', '- a\n- disk\n')).toBe('- a\n- mine\n- disk\n')
  expect(both('1. a\n2. b\n', '1. a\n2. mine\n', '1. a\n2. disk\n')).toBe('1. a\n2. mine\n2. disk\n')
  expect(both('| a |\n| b |\n', '| a |\n| mine |\n', '| a |\n| disk |\n')).toBe('| a |\n| mine |\n| disk |\n')
  expect(both('# T\nx\n', '# Mine\nx\n', '# Disk\nx\n')).toBe('# Mine\n# Disk\nx\n')
  expect(both('> a\n', '> mine\n', '> disk\n')).toBe('> mine\n> disk\n')
  // Prose next to a list item is not two prose blocks.
  expect(both('a\nb\n', 'a\nMine prose.\n', 'a\n- disk item\n')).toBe('a\nMine prose.\n- disk item\n')
  // Inside a code fence the lines are code, never separated.
  expect(both('```\nx = 1\n```\n', '```\nx = 2\n```\n', '```\nx = 3\n```\n')).toBe('```\nx = 2\nx = 3\n```\n')
  // A four-backtick block holding a literal ``` line is still open after it (CommonMark: the closing fence
  // is the same character, at least as long, with nothing after it), so its lines stay code.
  expect(both('````\n```\nold\n````\n', '````\n```\nmine\n````\n', '````\n```\ndisk\n````\n')).toBe('````\n```\nmine\ndisk\n````\n')
  // The same with tildes: ~~~ inside ~~~~, and a ``` line inside a ~~~ block.
  expect(both('~~~~\n~~~\nold\n~~~~\n', '~~~~\n~~~\nmine\n~~~~\n', '~~~~\n~~~\ndisk\n~~~~\n')).toBe('~~~~\n~~~\nmine\ndisk\n~~~~\n')
  expect(both('~~~\n```\nold\n~~~\n', '~~~\n```\nmine\n~~~\n', '~~~\n```\ndisk\n~~~\n')).toBe('~~~\n```\nmine\ndisk\n~~~\n')
  // A fence line with text after it does not close the block; one with only spaces after it does.
  expect(both('```\n``` x\nold\n```\n', '```\n``` x\nmine\n```\n', '```\n``` x\ndisk\n```\n')).toBe('```\n``` x\nmine\ndisk\n```\n')
  expect(both('```\ncode\n```  \nold\n', '```\ncode\n```  \nMine.\n', '```\ncode\n```  \nDisk.\n')).toBe('```\ncode\n```  \nMine.\n\nDisk.\n')
  // Indented code too.
  expect(both('    a\n', '    mine\n', '    disk\n')).toBe('    mine\n    disk\n')
  // Mine kept nothing (a deletion): nothing to separate.
  expect(both('Keep.\n\nOld.\n\nTail.\n', 'Keep.\n\nTail.\n', 'Keep.\n\nOld, better.\n\nTail.\n')).toBe('Keep.\n\nOld, better.\n\nTail.\n')
  // Mine and theirs picked alone are never changed.
  const merge = threeWayMerge('Old.\n', 'Mine.\n', 'Disk.\n')
  expect(mergedText(merge, ['mine'])).toBe('Mine.\n')
  expect(mergedText(merge, ['theirs'])).toBe('Disk.\n')
})

test('deletion vs edit: deleting a paragraph the disk edited is a conflict', () => {
  const base = doc('Keep.', 'Doomed paragraph.', 'Tail.')
  const mine = doc('Keep.', 'Tail.')
  const theirs = doc('Keep.', 'Doomed paragraph, improved on disk.', 'Tail.')
  const merge = threeWayMerge(base, mine, theirs)
  expect(merge.conflicts).toBe(1)
  expect(mergedText(merge, ['mine'])).toBe(mine)
  expect(mergedText(merge, ['theirs'])).toBe(theirs)
  // Both: mine (the deletion) contributes nothing, so the edited paragraph stays.
  expect(mergedText(merge, ['both'])).toBe(theirs)
})

test('edit vs deletion on disk is a conflict the other way round', () => {
  const base = doc('Keep.', 'Doomed.', 'Tail.')
  const merge = threeWayMerge(base, doc('Keep.', 'Doomed, but I edited it.', 'Tail.'), doc('Keep.', 'Tail.'))
  expect(merge.conflicts).toBe(1)
  expect(mergedText(merge, ['theirs'])).toBe(doc('Keep.', 'Tail.'))
})

test('both deleting the same paragraph is no conflict', () => {
  const base = doc('A.', 'B.', 'C.')
  const merge = threeWayMerge(base, doc('A.', 'C.'), doc('A.', 'C.'))
  expect(merge.conflicts).toBe(0)
  expect(mergedText(merge, [])).toBe(doc('A.', 'C.'))
})

test('CRLF on disk: line endings are not differences, the merge is in the editor form', () => {
  const base = 'One.\r\n\r\nTwo.\r\n\r\nThree.\r\n'
  const mine = 'One, mine.\n\nTwo.\n\nThree.\n' // the editor holds LF
  const theirs = 'One.\r\n\r\nTwo.\r\n\r\nThree, theirs.\r\n'
  const merge = threeWayMerge(base, mine, theirs)
  expect(merge.conflicts).toBe(0)
  expect(mergedText(merge, [])).toBe('One, mine.\n\nTwo.\n\nThree, theirs.\n')
})

test('a disk version that differs only in line endings or BOM changes nothing', () => {
  const base = 'a\nb\n'
  const merge = threeWayMerge(base, 'a\nb edited\n', '﻿a\r\nb\r\n')
  expect(merge.conflicts).toBe(0)
  expect(mergedText(merge, [])).toBe('a\nb edited\n')
})

test('a BOM in the buffer is kept in the merged text', () => {
  const merge = threeWayMerge('﻿a\nb', '﻿a\nb\nc', 'A\nb')
  expect(mergedText(merge, [])).toBe('﻿A\nb\nc')
})

test('Unicode: accents, emoji and other scripts merge line by line', () => {
  const base = doc('Příliš žluťoučký kůň.', 'Emoji 🎉 here.', '日本語のテキスト。')
  const mine = doc('Příliš žluťoučký kůň úpěl ďábelské ódy.', 'Emoji 🎉 here.', '日本語のテキスト。')
  const theirs = doc('Příliš žluťoučký kůň.', 'Emoji 🎉🎊 here.', '日本語のテキスト。')
  const merge = threeWayMerge(base, mine, theirs)
  expect(merge.conflicts).toBe(0)
  expect(mergedText(merge, [])).toBe(doc('Příliš žluťoučký kůň úpěl ďábelské ódy.', 'Emoji 🎉🎊 here.', '日本語のテキスト。'))
})

test('Unicode: composed and decomposed forms are different text, never silently equated', () => {
  const composed = 'caf\u00e9'
  const decomposed = 'cafe\u0301'
  const merge = threeWayMerge(`${composed}\n`, `${composed} mine\n`, `${decomposed}\n`)
  expect(merge.conflicts).toBe(1)
})

test('empty base: a buffer never read from disk against a file that appeared', () => {
  const merge = threeWayMerge(undefined, 'mine\n', 'theirs\n')
  expect(merge.conflicts).toBe(1)
  expect(mergedText(merge, ['both'])).toBe('mine\n\ntheirs\n')
  const same = threeWayMerge('', 'x', 'x')
  expect(same.conflicts).toBe(0)
  expect(mergedText(same, [])).toBe('x')
})

test('only the disk changed: the merge is the disk version; only mine: the merge is mine', () => {
  const base = doc('A.', 'B.')
  expect(mergedText(threeWayMerge(base, base, doc('A.', 'B on disk.')), [])).toBe(doc('A.', 'B on disk.'))
  expect(mergedText(threeWayMerge(base, doc('A mine.', 'B.'), base), [])).toBe(doc('A mine.', 'B.'))
})

test('nothing is lost: the chunks give back base, mine and theirs exactly', () => {
  // mulberry32: 32-bit integer arithmetic only (Math.imul, >>> 0), so every step is exact and the draws
  // cover every fragment (review round 1: the old linear generator overflowed and only drew two words).
  let seed = 7
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const drawn = new Set<string>()
  const rand = (n: number): number => Math.floor(next() * n)
  const words = ['alpha', 'beta', 'gamma', '', 'delta', 'ε', '🎉', 'zeta', '   ', '日本語', 'cafe\u0301', '- item']
  const word = (): string => { const w = words[rand(words.length)]; drawn.add(w); return w }
  const mutate = (lines: string[]): string[] => {
    const out = [...lines]
    for (let i = 0; i < 4; i += 1) {
      const at = rand(out.length + 1)
      const op = rand(3)
      if (op === 0) out.splice(at, 0, word())
      else if (op === 1 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1)
      else if (out.length > 0) out[Math.min(at, out.length - 1)] = word()
    }
    return out
  }
  const triples = new Set<string>()
  let conflicted = 0
  for (let round = 0; round < 500; round += 1) {
    const base = Array.from({ length: rand(12) }, word)
    const mine = mutate(base)
    const theirs = mutate(base)
    const text = (lines: string[]): string => lines.join('\n')
    const merge = threeWayMerge(text(base), text(mine), text(theirs))
    const norm = (lines: string[]): string => text(lines) === '' ? '' : text(lines)
    expect(side(merge, 'base')).toBe(norm(base))
    expect(side(merge, 'mine')).toBe(norm(mine))
    expect(side(merge, 'theirs')).toBe(norm(theirs))
    // With no conflicts, every pick list gives the same text, holding every change of both sides.
    if (merge.conflicts === 0) expect(mergedText(merge, [])).not.toBeNull()
    else {
      conflicted += 1
      // A full pick list always gives a text.
      expect(mergedText(merge, Array.from({ length: merge.conflicts }, () => 'both' as const))).not.toBeNull()
    }
    triples.add(JSON.stringify([base, mine, theirs]))
  }
  // The generator really covers the space: every fragment, many distinct inputs, conflicts and clean merges.
  expect([...drawn].sort()).toEqual([...words].sort())
  expect(triples.size).toBeGreaterThan(450)
  expect(conflicted).toBeGreaterThan(50)
})

test('a long document diffs quickly', () => {
  const base = Array.from({ length: 6000 }, (_, i) => `Paragraph ${i}.`)
  const mine = [...base]
  const theirs = [...base]
  for (let i = 0; i < 6000; i += 50) mine[i] = `Mine ${i}.`
  for (let i = 25; i < 6000; i += 50) theirs[i] = `Theirs ${i}.`
  const started = performance.now()
  const merge = threeWayMerge(base.join('\n'), mine.join('\n'), theirs.join('\n'))
  expect(performance.now() - started).toBeLessThan(1500)
  expect(merge.conflicts).toBe(0)
  const out = mergedText(merge, [])!.split('\n')
  expect(out[0]).toBe('Mine 0.')
  expect(out[25]).toBe('Theirs 25.')
  expect(out[26]).toBe('Paragraph 26.')
})
