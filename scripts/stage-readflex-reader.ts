import { cp, lstat, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve('node_modules/@readflex/reader-embed/vendor')
const destination = resolve('node_modules/.cache/writeflex/readflex-reader')

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, dereference: true })

const readerEntry = await lstat(resolve(destination, 'reader/reader.html'))
if (!readerEntry.isFile() || readerEntry.isSymbolicLink()) {
  throw new Error('The staged ReadFlex reader entry is not a self-contained file.')
}
