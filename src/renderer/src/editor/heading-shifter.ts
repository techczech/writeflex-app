import { type ChangeSpec, type StateCommand } from '@codemirror/state'
import { selectedLines } from './outliner'

const HEADING_REGEX = /^(#{1,6})\s+/

export const increaseHeading: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state)
  const changes: ChangeSpec[] = []

  for (const n of lines) {
    const line = state.doc.line(n)
    const text = line.text
    if (text.trim() === '') continue // Skip blank lines

    const match = text.match(HEADING_REGEX)
    if (match) {
      // It's a heading
      const hashes = match[1]
      if (hashes.length < 6) {
        // Increase level
        changes.push({ from: line.from, to: line.from + hashes.length, insert: hashes + '#' })
      }
      // If already at level 6, do nothing
    } else {
      // Plain text - add H1 marker
      changes.push({ from: line.from, insert: '# ' })
    }
  }

  if (changes.length === 0) return false

  dispatch(state.update({ changes, userEvent: 'input.format' }))
  return true
}

export const decreaseHeading: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state)
  const changes: ChangeSpec[] = []

  for (const n of lines) {
    const line = state.doc.line(n)
    const text = line.text
    if (text.trim() === '') continue // Skip blank lines

    const match = text.match(HEADING_REGEX)
    if (match) {
      // It's a heading
      const hashes = match[1]
      if (hashes.length > 1) {
        // Decrease level by removing one hash
        changes.push({ from: line.from, to: line.from + hashes.length, insert: hashes.slice(0, -1) })
      } else {
        // H1 - remove the entire heading marker (# + space)
        changes.push({ from: line.from, to: line.from + match[0].length })
      }
    }
    // If plain text, do nothing
  }

  if (changes.length === 0) return false

  dispatch(state.update({ changes, userEvent: 'delete.dedent' }))
  return true
}
