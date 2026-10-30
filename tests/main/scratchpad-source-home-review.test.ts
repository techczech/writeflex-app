import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { scratchpadSourceHome } from '../../src/main/scratchpad-source-home'

// Parent privacy-boundary probe. It asks only for the chosen path, never reads source data.
test('an e2e run with no explicit source home fails closed instead of selecting the real home', () => {
  let selected: string
  try { selected = scratchpadSourceHome({ WRITEFLEX_E2E: '1' }) }
  catch { return } // refusal is safe; source discovery cannot proceed
  expect(selected).not.toBe(homedir())
})
