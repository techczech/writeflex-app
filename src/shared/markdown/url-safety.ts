/**
 * ONE url-safety rule for every flavour that writes a destination (Round B, findings 2 and 3).
 *
 * An exported file is opened by other people, and a pasted document is opened inside someone else's
 * application. So a destination that came out of a writer's document — or out of a document an agent
 * wrote into their folder — is not trusted. It lives here rather than in an emitter because the two
 * emitters that write destinations diverged the moment they were written separately: the HTML one
 * carried a denylist, the RTF one carried nothing at all.
 *
 * Two rules, in this order, both of which a denylist gets wrong:
 *
 * 1. CLEAN FIRST. Per WHATWG URL parsing a browser removes every ASCII tab, CR and LF from a URL
 *    ANYWHERE in the string before it looks at the scheme, so `java<TAB>script:alert(1)` — which
 *    CommonMark happily accepts inside an angle-bracket destination — runs when the file is opened.
 *    A filter that reads the scheme off the raw bytes sees `java<TAB>script:` and lets it through.
 *    The other C0 controls and DEL go too: no destination needs them, and they exist in one only to
 *    break a filter apart.
 * 2. THEN ALLOW, never deny. A denylist has to guess the whole set of schemes that can execute
 *    (`javascript:`, `vbscript:`, `data:text/html`, `blob:`, `filesystem:`, whatever ships next);
 *    an allowlist only has to name the four a piece of writing legitimately points at.
 *
 * Anything not allowed returns null, and each emitter renders the label as ordinary text — a
 * refused link is never a dead anchor and never a silent deletion of the writer's words.
 */

/** Where the destination is going. Images may additionally carry a `data:` picture, which is how a
 *  standalone export embeds a file it read from disk; a link may not — `data:text/html` is a page. */
export type UrlUse = 'link' | 'image'

const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])
const IMAGE_SCHEMES = new Set(['http', 'https', 'data'])

/** A scheme as the URL standard defines one: a letter, then letters, digits, `+`, `-`, `.`, then `:`. */
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
/** `data:` restricted to a picture. An `image/svg+xml` picture is included deliberately: scripts in
 *  an SVG do not run when it is the source of an `<img>`, which is the only place this reaches. */
const DATA_IMAGE = /^data:image\/[a-zA-Z0-9.+-]+[;,]/

/** Everything a browser drops before parsing (tab, CR, LF) plus the rest of C0 and DEL. A SPACE is
 *  deliberately not in the class: `[a](<my file.png>)` is a legitimate destination. */
const NEVER_IN_A_URL = /[\u0000-\u001f\u007f]/g

/**
 * The destination as it may safely be written, or null when it may not be written at all.
 *
 * The returned string is the cleaned URL in plain characters: each emitter escapes it in its own
 * alphabet (HTML attribute escaping, RTF control-character escaping), because escaping is a
 * flavour's business and safety is not.
 */
export function safeUrl(url: string, use: UrlUse = 'link'): string | null {
  const cleaned = url.replace(NEVER_IN_A_URL, '').trim()
  if (cleaned === '') return null
  const scheme = SCHEME.exec(cleaned)
  // No scheme at all: a relative path, a `#fragment` or a `//host` protocol-relative URL. There is
  // nothing here that can execute, and refusing them would break every ordinary local image.
  if (!scheme) return cleaned
  const name = scheme[1].toLowerCase()
  if (use === 'image') {
    if (!IMAGE_SCHEMES.has(name)) return null
    return name === 'data' && !DATA_IMAGE.test(cleaned) ? null : cleaned
  }
  return LINK_SCHEMES.has(name) ? cleaned : null
}
