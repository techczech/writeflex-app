import { expect, test } from 'bun:test'
import { fileNameProblem } from '../../src/shared/file-name-rules'

const characterProblem = 'A name cannot contain : * ? " < > | — OneDrive and Windows cannot store them.'
const endingProblem = 'A name cannot end with a space or a full stop.'

test.each([...':*?"<>|'])('refuses %s in a name', character => {
  expect(fileNameProblem(`Talk${character}part 1`)).toBe(characterProblem)
})

test.each(['Draft ', 'Draft.'])('refuses the ending in %j', name => {
  expect(fileNameProblem(name)).toBe(endingProblem)
})

test.each(['My Morning Note', 'Příprava (2).md', String.raw`a/b\c`])('permits %s for existing name handling', name => {
  expect(fileNameProblem(name)).toBeNull()
})
