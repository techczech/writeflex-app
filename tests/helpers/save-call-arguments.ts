// Shared by the save-caller tests: the TypeScript files under a folder, and the top-level arguments of a call.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** The top-level arguments of the call whose `(` is at `open`. */
export function callArguments(source: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = open + 1
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) {
        const last = source.slice(start, i).trim()
        if (last) args.push(last)
        return args
      }
    } else if (ch === ',' && depth === 1) {
      args.push(source.slice(start, i).trim())
      start = i + 1
    }
  }
  throw new Error('unbalanced call')
}
