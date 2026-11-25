import { expect, test } from 'bun:test'
import {
  createNameVersionChooser, type NameVersionQuestion, type NameVersionSubject,
} from '../../src/renderer/src/app/name-version-chooser'
import { createSaveGate, type SaveChoice } from '../../src/renderer/src/app/folio-version-save'

const partA = 'paper-a/a.md'
const partB = 'paper-b/b.md'
const subject = (path: string, dir: string): NameVersionSubject => ({
  part: path, basis: { kind: 'collection', path: dir },
})

function setup() {
  const chooser = createNameVersionChooser()
  const gate = createSaveGate()
  const questions: NameVersionQuestion[] = []
  const preferences: SaveChoice[] = []
  const partSheets: (string | null)[] = []
  const folioSheets: string[] = []
  let currentSubject = subject(partA, 'paper-a')
  const host: Parameters<typeof chooser.request>[0] = {
    currentSubject: () => currentSubject,
    busy: () => gate.held() !== null,
    readDir: async (basis) => basis.path,
    readLastChoice: async () => 'part',
    readFacts: async () => ({ parts: 2, partList: [{ path: partA, title: 'First part', order: 1 }] }),
    openPartSheet: (path) => { partSheets.push(path) },
    showQuestion: (question) => { questions.push(question) },
  }
  const answer = (question: NameVersionQuestion, choice: SaveChoice): void => {
    const target = chooser.take(question, choice)
    if (!target) return
    preferences.push(target.scope)
    if (target.scope === 'part') host.openPartSheet(target.path)
    else folioSheets.push(target.dir)
  }

  return {
    chooser, gate, host, questions, preferences, partSheets, folioSheets, answer,
    navigate: (next: NameVersionSubject) => { currentSubject = next },
    directFolioSheet: (dir: string) => {
      chooser.cancel()
      const token = gate.begin('opening')!
      folioSheets.push(dir)
      return token
    },
  }
}

test('a delayed Name Version request cannot replace the newer question', async () => {
  const { chooser, host, questions, navigate, preferences, partSheets, answer } = setup()
  const firstDir = Promise.withResolvers<string | null>()
  const first = chooser.request({ ...host, readDir: () => firstDir.promise })
  navigate(subject(partB, 'paper-b'))
  await chooser.request(host)
  firstDir.resolve('paper-a')
  await first

  expect(questions.map((question) => question.dir)).toEqual(['paper-b'])
  answer(questions[0]!, 'part')
  expect(partSheets).toEqual([partB])
  expect(preferences).toEqual(['part'])
})

test('a repeated shortcut supersedes a quiet facts read within the same navigation', async () => {
  const { chooser, host, questions, preferences, folioSheets, answer } = setup()
  const enteredFacts = Promise.withResolvers<void>()
  const firstFacts = Promise.withResolvers<Awaited<ReturnType<typeof host.readFacts>>>()
  const first = chooser.request({
    ...host,
    readFacts: () => { enteredFacts.resolve(); return firstFacts.promise },
  })
  await enteredFacts.promise
  await chooser.request(host)
  firstFacts.resolve({ parts: 1, partList: [] })
  await first

  expect(questions.map((question) => question.parts)).toEqual([2])
  answer(questions[0]!, 'folio')
  expect(folioSheets).toEqual(['paper-a'])
  expect(preferences).toEqual(['folio'])
})

test('returning to the same part and Collection cannot revive a delayed request', async () => {
  const { chooser, host, questions, navigate, preferences, partSheets, folioSheets } = setup()
  const firstDir = Promise.withResolvers<string | null>()
  const first = chooser.request({ ...host, readDir: () => firstDir.promise })
  navigate(subject(partB, 'paper-b'))
  navigate(subject(partA, 'paper-a'))
  firstDir.resolve('paper-a')
  await first

  expect({ questions, preferences, partSheets, folioSheets }).toEqual({
    questions: [], preferences: [], partSheets: [], folioSheets: [],
  })
})

test('Escape during a rejected directory read suppresses the plain-part fallback', async () => {
  const { chooser, host, preferences, questions, partSheets, folioSheets } = setup()
  const dir = Promise.withResolvers<string | null>()
  const pending = chooser.request({ ...host, readDir: () => dir.promise })
  chooser.cancelPreparation()
  dir.reject(new Error('Folio read failed'))
  await pending

  expect({ questions, preferences, partSheets, folioSheets }).toEqual({
    questions: [], preferences: [], partSheets: [], folioSheets: [],
  })
})

test('a direct Folio sheet retires the pending shortcut without releasing its gate', async () => {
  const { chooser, gate, host, questions, preferences, partSheets, folioSheets, directFolioSheet } = setup()
  const dir = Promise.withResolvers<string | null>()
  const pending = chooser.request({ ...host, readDir: () => dir.promise })
  const token = directFolioSheet('paper-a')
  dir.resolve(null)
  await pending

  expect(gate.held()).toBe('opening')
  gate.end(token)
  expect({ questions, preferences, partSheets, folioSheets }).toEqual({
    questions: [], preferences: [], partSheets: [], folioSheets: ['paper-a'],
  })
})

test('a live missing or rejected Folio directory opens the requested part without recording a scope', async () => {
  const { chooser, host, navigate, questions, preferences, partSheets } = setup()
  navigate({ part: 'plain.md', basis: { kind: 'part', path: 'plain.md' } })
  await chooser.request({
    ...host,
    readDir: async (basis) => {
      expect(basis).toEqual({ kind: 'part', path: 'plain.md' })
      return null
    },
  })
  await chooser.request({ ...host, readDir: async () => { throw new Error('Folio read failed') } })

  expect(partSheets).toEqual(['plain.md', 'plain.md'])
  expect(questions).toEqual([])
  expect(preferences).toEqual([])
})

test('the root Folio gets a quiet choice and its empty directory survives the handoff', async () => {
  const { chooser, host, navigate, questions, preferences, partSheets, folioSheets, answer } = setup()
  navigate(subject('root.md', ''))
  await chooser.request({
    ...host,
    readLastChoice: async () => { throw new Error('Preference read failed') },
    readFacts: async (dir) => {
      expect(dir).toBe('')
      throw new Error('Facts read failed')
    },
  })
  expect(questions).toEqual([{ dir: '', last: 'folio', partName: '', parts: null }])

  answer(questions[0]!, 'folio')
  answer(questions[0]!, 'part')
  expect(folioSheets).toEqual([''])
  expect(partSheets).toEqual([])
  expect(preferences).toEqual(['folio'])
})

test('a visible question cannot save or remember an answer after navigating to another part', async () => {
  const { chooser, host, questions, navigate, partSheets, folioSheets, preferences, answer } = setup()
  await chooser.request(host)
  expect(questions[0]).toMatchObject({ last: 'part', partName: '1 First part', parts: 2 })
  navigate(subject('paper-a/other.md', 'paper-a'))

  answer(questions[0]!, 'part')
  answer(questions[0]!, 'folio')
  expect({ preferences, partSheets, folioSheets }).toEqual({
    preferences: [], partSheets: [], folioSheets: [],
  })
})

test('a callback from a dismissed question cannot consume its replacement', async () => {
  const { chooser, host, questions, preferences, partSheets, folioSheets, answer } = setup()
  await chooser.request(host)
  await chooser.request(host)
  chooser.cancelQuestion(questions[0]!)

  answer(questions[0]!, 'folio')
  answer(questions[1]!, 'part')
  answer(questions[1]!, 'part')
  expect({ preferences, partSheets, folioSheets }).toEqual({
    preferences: ['part'], partSheets: [partA], folioSheets: [],
  })
})
