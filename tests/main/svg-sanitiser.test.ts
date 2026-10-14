import { describe, expect, test } from 'bun:test'
import { sanitiseSvg } from '../../src/shared/sanitise-svg'

describe('sanitiseSvg', () => {
  test('keeps a normal self-contained SVG', () => {
    const result = sanitiseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    expect(result).toHaveProperty('svg')
    if ('svg' in result) {
      expect(result.svg).toContain('<svg')
      expect(result.svg).toContain('<rect')
    }
  })

  const attacks = [
    ['script', '<svg><script>globalThis.pwned = true</script><rect/></svg>'],
    ['onload', '<svg onload="globalThis.pwned=true"><rect/></svg>'],
    ['onclick', '<svg><rect onclick="globalThis.pwned=true"/></svg>'],
    ['foreignObject', '<svg><foreignObject><script>globalThis.pwned=true</script></foreignObject></svg>'],
    ['javascript href', '<svg><a href="javascript:globalThis.pwned=true"><text>x</text></a></svg>'],
    ['external image', '<svg><image href="http://example.com/tracker.png"/></svg>'],
    ['external use', '<svg><use href="http://example.com/icons.svg#x"/></svg>'],
    ['XXE', '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg><text>&xxe;</text></svg>'],
  ] as const

  for (const [name, source] of attacks) {
    test(`fails closed for ${name}`, () => {
      const result = sanitiseSvg(source)
      expect(result).toHaveProperty('error')
      expect(JSON.stringify(result)).not.toContain('globalThis.pwned')
    })
  }

  test('accepts local fragment references only', () => {
    const result = sanitiseSvg('<svg><defs><path id="shape" d="M0 0h1v1z"/></defs><use href="#shape"/></svg>')
    expect(result).toHaveProperty('svg')
    if ('svg' in result) expect(result.svg).toContain('href="#shape"')
  })

  test('keeps greater-than characters inside quoted attribute values', () => {
    expect(sanitiseSvg('<svg aria-label="one > zero"><rect/></svg>')).toHaveProperty('svg')
  })

  test('fails closed for malformed or non-SVG roots', () => {
    expect(sanitiseSvg('<svg><rect></svg>')).toHaveProperty('error')
    expect(sanitiseSvg('<div>not svg</div>')).toHaveProperty('error')
  })
})
