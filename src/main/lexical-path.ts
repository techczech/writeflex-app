import { resolve } from 'node:path'

/**
 * Are two paths, as written, the same path? `.`, `..` and a trailing separator are normalised;
 * nothing else is, and the disk is never consulted. Case is preserved: on a case-sensitive volume
 * another case is another folder, and treating it as the same would hide or admit the wrong one.
 * (The accepted cost: on a case-insensitive volume a differently-cased spelling is not matched.)
 *
 * THE one comparison behind the Example collection's place on the start screen (ADR-0043): the
 * pins and recents filter, the refusals in `touchRecent`, `pin` and Locate, and the window guard.
 */
export function sameLexicalPath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}
