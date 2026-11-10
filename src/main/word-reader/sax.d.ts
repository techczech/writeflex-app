// The slice of `sax` (1.6.1, zero dependencies) the reader uses. Kept here so the reader needs no
// separate types package.
declare module 'sax' {
  export interface Tag {
    name: string
    attributes: Record<string, string>
    isSelfClosing: boolean
  }
  export interface SAXParser {
    error: Error | null
    onerror?: (e: Error) => void
    onopentag?: (tag: Tag) => void
    onclosetag?: (name: string) => void
    ontext?: (text: string) => void
    oncdata?: (text: string) => void
    write(chunk: string): SAXParser
    close(): SAXParser
  }
  export function parser(strict: boolean, opt?: Record<string, unknown>): SAXParser
  const sax: { parser: typeof parser }
  export default sax
}
