// Version order for the built-in agent skill: "a lower version never overwrites a higher one".
// Dotted numbers with an optional pre-release tail (0.42.0-alpha.18), semver order: a pre-release is
// below its release, tags compare as dotted identifiers (numbers numerically, words as text).
// Pure; erasable TypeScript only; no app specifics.

interface Parsed { core: number[]; pre: string[] }

function parse(version: string): Parsed | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version).trim())
  if (!m) return null
  return { core: m[1].split('.').map(Number), pre: m[2] ? m[2].split('.') : [] }
}

/** -1, 0 or 1; null when either side is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  const n = Math.max(x.core.length, y.core.length)
  for (let i = 0; i < n; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1
  const m = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < m; i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) { const d = Number(p) - Number(q); if (d !== 0) return d < 0 ? -1 : 1 } else if (pn !== qn) return pn ? -1 : 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}
