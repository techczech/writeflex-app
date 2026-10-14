import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** `line` (1-based) is present only when the link carries a valid `line=N`; the file then opens at it. */
export type WriteflexUrlResult = { path: string; line?: number } | { error: string }
export type OpenPathKind = 'folder' | 'file'

export function isMarkdownPath(candidate: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(candidate)
}

export function parseWriteflexUrl(rawUrl: string): WriteflexUrlResult {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { error: 'The link is not a valid URL.' }
  }
  if (url.protocol !== 'writeflex:') return { error: 'The link does not use the writeflex scheme.' }

  let encodedPath: string
  let line: number | undefined
  if (url.hostname === 'open' && (url.pathname === '' || url.pathname === '/')) {
    const match = url.search.match(/(?:^\?|&)path=([^&]*)/)
    if (!match?.[1]) return { error: 'The link does not contain a path.' }
    encodedPath = match[1]
    line = parseLine(url.search)
  } else if (url.hostname === '' && url.pathname.startsWith('/')) {
    encodedPath = url.pathname
  } else {
    return { error: 'The link action is not supported.' }
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(encodedPath.replace(/\+/g, ' '))
  } catch {
    return { error: 'The link path is not valid.' }
  }
  if (!decodedPath) return { error: 'The link does not contain a path.' }
  if (!isAbsolute(decodedPath)) return { error: 'The link path must be absolute.' }
  return line === undefined ? { path: resolve(decodedPath) } : { path: resolve(decodedPath), line }
}

/** `line=N` as a positive integer; anything else (absent, 0, negative, fractional, junk) is ignored
 *  and the file simply opens, as it did before the parameter was read. */
function parseLine(search: string): number | undefined {
  const match = search.match(/(?:^\?|&)line=([^&]*)/)
  if (!match?.[1] || !/^\d{1,9}$/.test(match[1])) return undefined
  const line = Number(match[1])
  return line >= 1 ? line : undefined
}

export function classifyOpenPath(candidate: string): OpenPathKind | null {
  if (!existsSync(candidate)) return null
  try {
    const stat = statSync(candidate)
    if (stat.isDirectory()) return 'folder'
    if (stat.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}
