// The reader page's one script, and the content security policy that lets it run and nothing else.
//
// The script is added to a published page when it is served (readerPageResponse), not when it is
// published, so a page published by an older build gets the script of the build serving it, and
// the policy's hash always matches. The policy names the script by its SHA-256: no other script
// can run, the author's HTML included (it is not sanitised). `connect-src 'self'`
// lets the script reach this service's reader routes and nothing else.
//
// What the script does: reader-runtime-text.ts (anchoring) and reader-runtime-ui.ts (notes). On a
// page with comments off it only removes any <meta name="referrer"> the author's text carries and
// marks every link no-referrer, so a link out never tells another site the page's address.
import { READER_RUNTIME_TEXT } from './reader-runtime-text.ts'
import { READER_RUNTIME_UI } from './reader-runtime-ui.ts'

export const READER_PAGE_RUNTIME = '(function () {\n"use strict";\nvar rp = document.body && document.body.firstElementChild;\n'
  + 'if (!rp || !rp.classList.contains("rp")) return;\n'
  + READER_RUNTIME_TEXT + READER_RUNTIME_UI + '\n})();\n'

let hash: Promise<string> | null = null

/** `'sha256-<base64>'` of the script, as a CSP source. */
export function readerRuntimeHashSource(): Promise<string> {
  hash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(READER_PAGE_RUNTIME)).then((digest) => {
    const bytes = new Uint8Array(digest)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return `'sha256-${btoa(binary)}'`
  })
  return hash
}

/** The page's policy: the one script, this service's reader routes, same-origin images, inline styles. */
export async function readerPageCsp(): Promise<string> {
  return `default-src 'none'; script-src ${await readerRuntimeHashSource()}; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
}
