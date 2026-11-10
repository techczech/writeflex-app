import { dirname, join } from 'node:path'

/** Packaged host location. The normal development main build substitutes its validated generation. */
export function readerHostDirectory(entryFile: string): string {
  return join(dirname(entryFile), '..', 'renderer')
}
