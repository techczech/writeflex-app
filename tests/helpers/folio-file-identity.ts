/** Expected legacy Index bytes after the author-open or structural-write migration. Bindings are fixture constants. */
export function pinnedIndex(source: string, bindings: Record<string, string>): string {
  return source.replace(/\[\[([^\]\n]+)\]\]/g, (whole, target: string) => bindings[target] ? `[[${bindings[target]}]]` : whole)
}

export const pinPangram = (source: string): string => pinnedIndex(source, { Summary: './contents/01-summary.md|Summary', Details: './contents/02-report.md|Details' })
export const pinMixed = (source: string): string => pinnedIndex(source, { 'Title page': './title-page.md|Title page', Intro: './intro.md|Intro', Method: './method.md|Method', Costs: './costs.md|Costs' })
export const pinIndexOnly = (source: string): string => pinnedIndex(source, { One: './one.md|One', Two: './two.md|Two' })
/** Expected pre/post file listing: only the named Index Note changes; all other bytes/mtimes still compare exactly. */
export function openedFolioListing(before: string[], after: string[], indexName: string, pin: (source: string) => string): string[] {
  const prefix = `/${indexName} `
  const original = before.find(line => line.startsWith(prefix))!
  const written = after.find(line => line.startsWith(prefix))!
  const expectedBytes = Buffer.from(pin(Buffer.from(original.split(' ').at(-1)!, 'base64').toString('utf8'))).toString('base64')
  // Index size and mtime necessarily change. Its bytes are asserted independently of those metadata fields.
  const metadata = written.slice(0, written.lastIndexOf(' '))
  return before.map(line => line.startsWith(prefix) ? `${metadata} ${expectedBytes}` : line)
}
