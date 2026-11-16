import { basename, dirname, sep } from 'node:path'

/** Show the folder name, adding the shortest parent suffix that distinguishes namesakes. */
export function recentMenuLabels(roots: readonly string[]): Map<string, string> {
  const unique = [...new Set(roots)]
  return new Map(unique.map(root => {
    const name = basename(root) || root
    const peers = unique.filter(other => other !== root && (basename(other) || other) === name)
    if (!peers.length) return [root, name]
    const parents = dirname(root).split(sep).filter(Boolean)
    for (let depth = 1; depth <= parents.length; depth++) {
      const suffix = parents.slice(-depth).join(sep)
      if (peers.every(other => dirname(other).split(sep).filter(Boolean).slice(-depth).join(sep) !== suffix)) return [root, `${name} — ${suffix}`]
    }
    return [root, `${name} — ${dirname(root)}`]
  }))
}
