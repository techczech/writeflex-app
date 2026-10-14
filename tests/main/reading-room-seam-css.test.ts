import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('the seam thickens only its inner hairline and gives keyboard focus a distinct ring', () => {
  const css = readFileSync(
    join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src', 'styles', 'app.css'),
    'utf8',
  )

  expect(css).toMatch(/\.reading-room-resize\{[^}]*width:10px[^}]*margin:0 -5px[^}]*\}/)
  expect(css).toMatch(/\.reading-room-resize:hover::after\{[^}]*width:3px[^}]*\}/)
  expect(css).toMatch(/\.reading-room-resize:focus-visible::after\{[^}]*width:3px[^}]*box-shadow:[^}]*\}/)
  expect(css).not.toMatch(/\.reading-room-resize:hover\{[^}]*width:/)
  expect(css).not.toMatch(/\.reading-room-resize:focus-visible\{[^}]*width:/)
})
