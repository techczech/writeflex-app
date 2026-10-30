// The reader page, as the service serves it. Pure: text in, text out.
//
// Layout: the reader page's states `read-only`
// (comments off: text only, the reader bar says so), `folio` (a Folio with its contents list),
// `link-off`, and with comments on the notes states (`selected` … `dark`): an empty notes column the
// page's script fills (reader-runtime*.ts). The page always ends with a small, muted "Made with
// WriteFlex" line linking to writeflex.app, after the text or after a Folio's last part.
//
// The page is rendered once, when the author publishes, and stored as is; a reader's request only
// reads it. The one script is added as the page is served (readerPageResponse). The page carries no
// credential and nothing about the share beyond its text, the author's name and its revision.
//
// Every response a reader can get from the service carries READER_HEADERS:
//   - no script may run but the page's own (pinned by its hash; the author's HTML included), nothing
//     loads from another site, the script talks only to this service, and the page cannot be framed;
//   - no Referer is ever sent, so following a link out of the page never tells the other site the
//     page's secret address;
//   - nothing is cached, so a turned-off link stops at once;
//   - search engines are asked not to index or follow.
import { LAYOUT_STYLES } from './reader-page-layout-styles.ts'
import { NOTES_STYLES } from './reader-page-notes-styles.ts'
import { READER_PAGE_RUNTIME, readerPageCsp } from './reader-runtime.ts'
import type { PublishBody, PublishedPart } from './share-protocol.ts'

export const READER_PATH_PREFIX = '/s/'
export const MADE_WITH_URL = 'https://writeflex.app'

/** The "turned off" page's policy: it runs nothing. */
const PAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/** Images may be opened on their own; an SVG opened that way runs nothing (sandbox). */
const IMAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox"

const READER_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'x-frame-options': 'DENY',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)
}

// lucide 1.31 icon paths (ISC licence), the ones the page draws.
const ICONS: Record<string, string> = {
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  'link-2-off': '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" x2="12" y1="12" y2="12"/><line x1="2" x2="22" y1="2" y2="22"/>',
  'message-square-off': '<path d="M19 19H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.7.7 0 0 1 2 21.286V5a2 2 0 0 1 1.184-1.826"/><path d="m2 2 20 20"/><path d="M8.656 3H20a2 2 0 0 1 2 2v11.344"/>',
}

function icon(name: keyof typeof ICONS, size = 14): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

// The reader-page rules that a read-only page uses, then the export's text rules (src/shared/markdown/export-styles.css, the
// part the export's body markup needs) on the page's colour tokens, then the narrow-screen and
// dark-theme rules.
const STYLES = `*{box-sizing:border-box;min-width:0}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0}
.ic{flex:none;vertical-align:-3px}
.rp{--ink:#18202a;--muted:#607083;--paper:#fbfaf7;--panel:#fff;--line:#dbe2ea;--line-strong:#b9c4d0;--kbd-bg:#f3f5f8;--chip-ink:#41536a;--nav-ink:#34465a;--nav-sub:#657387;--nav-active-bg:#eef5ff;--nav-active-ink:#0b55b7;--code-bg:#f3f2ee;--mark:#fff3c4;
min-height:100vh;position:relative;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;line-height:1.65}
@media (prefers-color-scheme:dark){.rp{--ink:#e4e8ee;--muted:#9aa8b8;--paper:#14181d;--panel:#1c2229;--line:#303945;--line-strong:#4a5666;--kbd-bg:#252c35;--chip-ink:#9aa8b8;--nav-ink:#9aa8b8;--nav-sub:#9aa8b8;--nav-active-bg:#1d2a3a;--nav-active-ink:#8ab8f0;--code-bg:#232a32;--mark:#4d4318}}
.rbar{display:flex;align-items:center;gap:8px 22px;flex-wrap:wrap;padding:10px 28px;background:var(--panel);border-bottom:1px solid var(--line);font-size:13px;line-height:1.3;color:var(--muted)}
.rbar .it{display:inline-flex;align-items:center;gap:6px}
.rbar .by{color:var(--ink);font-weight:600}
.hero{padding:40px 0 24px;border-bottom:1px solid var(--line);margin-bottom:30px}
.hero h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:46px;font-weight:600;letter-spacing:-.025em;line-height:1.04;color:var(--ink)}
.meta-row{display:flex;flex-wrap:wrap;gap:9px;margin-top:20px}
.chip{padding:5px 11px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--chip-ink);font-size:12.5px;line-height:1.4}
.chip strong{color:var(--ink);font-weight:700}
.rbody{position:relative;display:flex;align-items:flex-start;padding:0 0 80px}
.content{flex:none;width:660px;margin-left:auto;margin-right:auto}
.wf-bundle-section-title{margin:0 0 .6em 0;line-height:1.2;font-family:Georgia,"Times New Roman",serif;font-size:32px;font-weight:600}
.wf-bundle-section+.wf-bundle-section{padding-top:2.5em;border-top:1px solid var(--line);margin-top:2.5em}
.plabel{margin:0 0 4px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.part-missing{color:var(--muted);font-style:italic}
.rp.folio .rbody{padding-bottom:0}
.rp.folio .content{width:560px;margin-left:48px;margin-right:auto;padding-bottom:80px}
.rp.folio .hero h1{font-size:44px}
.sidebar{flex:none;width:250px;align-self:stretch;padding:26px 18px;border-right:1px solid var(--line);background:var(--panel)}
.sidebar-inner{position:sticky;top:20px}
.sidebar-title{margin:0 0 18px;font-size:16px;line-height:1.25;color:var(--ink)}
.toc-label{margin:0 8px 8px;color:var(--muted);font-size:11px;font-weight:760;letter-spacing:.09em;text-transform:uppercase}
.nav-link{display:block;margin:2px 0;padding:7px 9px;border-radius:7px;color:var(--nav-ink);font-size:13px;line-height:1.3;text-decoration:none}
.nav-link:hover{background:var(--nav-active-bg);color:var(--nav-active-ink)}
.nav-link.piece-link{font-weight:700}
.nav-link.level-3{padding-left:22px;color:var(--nav-sub);font-size:12.5px}
.made-with{margin:56px 0 0;font-size:12.5px;line-height:1.4;color:var(--muted)}
.made-with a{color:inherit;text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:2px}
.offpage{padding:110px 24px 0 120px;min-height:100vh}
.offpage h1{margin:14px 0 8px;font-family:Georgia,"Times New Roman",serif;font-size:34px;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.offpage p{margin:0;color:var(--muted)}
.content a{color:inherit;text-underline-offset:2px}
.wf-paragraph{margin:0 0 1em 0}
.wf-heading{margin:1.2em 0 .5em 0;line-height:1.25;letter-spacing:-.01em}
h2.wf-heading{font-size:24px;font-weight:700}
h3.wf-heading{font-size:20px;font-weight:700}
.wf-quote{margin:0 0 1em 0;padding:0 0 0 1em;border-left:3px solid var(--line-strong);color:var(--muted)}
.wf-list{margin:0 0 1em 0;padding-left:1.6em}
.wf-item{margin:0 0 .25em 0}
.wf-task-item{margin:0 0 .25em 0;list-style-type:none}
.wf-pre{margin:0 0 1em 0;padding:.75em 1em;background:var(--code-bg);border:1px solid var(--line);border-radius:6px;overflow-x:auto}
.wf-code-in-pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;white-space:pre}
.wf-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--code-bg);padding:.1em .3em;border-radius:3px}
.wf-table{border-collapse:collapse;margin:0 0 1em 0}
.wf-cell,.wf-header-cell{border:1px solid var(--line-strong);padding:6px 10px;vertical-align:top}
.wf-header-cell{background:var(--kbd-bg);font-weight:700}
.wf-rule{border:none;border-top:1px solid var(--line);margin:1.5em 0}
.wf-kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78em;font-style:normal;background:var(--kbd-bg);border-radius:4px;padding:1px 4px;white-space:nowrap}
.wf-mark{background:var(--mark);color:inherit}
.wf-image,.content img{max-width:100%;height:auto}
.wf-figure{margin:0 0 1em 0;max-width:100%;overflow-x:auto}
.wf-footnotes{margin:2em 0 0 0;padding-top:.5em;border-top:1px solid var(--line);font-size:.9em}
.wf-backref{text-decoration:none}
table{border-collapse:collapse}
.table-scroll{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}
@media (max-width:1000px){.rp.folio .rbody{display:block}.sidebar{width:auto;border-right:0;border-bottom:1px solid var(--line)}.sidebar-inner{position:static}.rp.folio .content{width:auto;max-width:660px;margin:0 auto;padding:0 18px 40px}}
@media (max-width:720px){.rp{font-size:17px}.rbar{padding:9px 16px;gap:4px 14px;font-size:12.5px}.rbody{display:block;padding-bottom:40px}.content{width:auto;margin:0 18px}.hero{padding:24px 0 18px;margin-bottom:22px}.hero h1,.rp.folio .hero h1{font-size:34px}h2.wf-heading{font-size:21px}.offpage{padding:72px 20px 0}}`

/** "14 October 2026, 09:12" in the author's time zone (UTC, said so, when none was given). */
export function formatUpdated(savedAt: number, timeZone: string | null): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone ?? 'UTC', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(savedAt))
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const text = `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`
  return timeZone ? text : `${text} UTC`
}

function readerBar(body: PublishBody): string {
  const items: string[] = []
  if (body.sharedBy) items.push(`<span class="it">${icon('link')}<span class="by">Shared by ${escapeHtml(body.sharedBy)}</span></span>`)
  const iso = new Date(body.savedAt).toISOString()
  items.push(`<span class="it">${icon('clock')}<span>Updated <time datetime="${iso}">${escapeHtml(formatUpdated(body.savedAt, body.timeZone))}</time></span></span>`)
  const commentsOff = !body.comments ? `<span class="it comments-off">${icon('message-square-off')}<span>Comments are off for this link.</span></span>` : ''
  const position = body.kind === 'folio' ? `<button class="contents-button" aria-controls="folio-contents" aria-expanded="false">Contents</button><span class="crumb"><b>${escapeHtml(body.title)}</b><span class="sep">/</span><span class="current-section">Cover</span></span>` : ''
  return `<header class="rbar">${position}<div class="bar-meta">${items.join('')}</div>${commentsOff}</header>`
}

function masthead(body: PublishBody): string {
  const chips = body.chips.filter(chip => chip.label.trim().toLowerCase() !== 'parts').map((chip) => `<span class="chip"><strong>${escapeHtml(chip.label)}</strong> · ${escapeHtml(chip.value)}</span>`).join('')
  return `<header class="hero wf-masthead"><h1>${escapeHtml(body.title)}</h1>${chips ? `<div class="meta-row">${chips}</div>` : ''}</header>`
}

function madeWith(): string {
  return `<footer class="made-with"><a href="${MADE_WITH_URL}" rel="noopener noreferrer" referrerpolicy="no-referrer">Made with WriteFlex</a></footer>`
}

/** `coverShown`: the part is the first shown and its title is the Folio's title, which the cover hero already
 *  shows as its h1, so the section does not repeat it. The section keeps its `id="part-N"` anchor. */
function folioSection(part: PublishedPart, index: number, coverShown: boolean): string {
  const number = index + 1
  const text = part.html === null ? '<p class="part-missing">This part is not available.</p>' : part.html
  if (coverShown) return `<section class="wf-bundle-section" id="part-${number}">${text}</section>`
  return `<section class="wf-bundle-section" id="part-${number}" aria-labelledby="part-${number}-title">`
    + `<h1 class="wf-bundle-section-title" id="part-${number}-title">${escapeHtml(part.title)}</h1>${text}</section>`
}

/** Hide legacy empty cover parts without changing any remaining published part anchors. */
function visibleParts(body: PublishBody): { part: PublishedPart; index: number }[] {
  return body.parts.flatMap((part, index) => {
    const empty = part.html !== null && !part.html.replace(/^\s*<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/i, '')
      .replace(/<\/?(?:p|div|br)\b[^>]*>/gi, '').replace(/&nbsp;|&#160;|&#x0*a0;/gi, ' ').trim()
    return body.parts.length > 1 && empty && part.title.trim().toLowerCase() === body.title.trim().toLowerCase() ? [] : [{ part, index }]
  })
}

/** HTML supplies levels; published heading ids and texts remain the source of navigation anchors. */
function folioContents(body: PublishBody, parts: ReturnType<typeof visibleParts>): string {
  const links = parts.map(({ part, index }, at) => {
    const levels = new Map([... (part.html ?? '').matchAll(/<h([1-6])\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi)].map(m => [m[2], Number(m[1])]))
    let sections = '', subs = '', section = ''
    const flush = () => { if (section) sections += `<div class="nav-section">${section}<div class="nav-subsections">${subs}</div></div>`; else sections += subs; subs = ''; section = '' }
    for (const heading of part.headings) {
      const level = levels.get(heading.id)
      if (level !== 2 && level !== 3 && level !== 4) continue
      const link = `<a class="nav-link level-${level}" href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`
      if (level === 2 || level === 3) { flush(); section = link } else subs += link
    }
    flush()
    return `<details class="nav-part"${at === 0 ? ' open' : ''}><summary><a class="nav-link piece-link" href="#part-${index + 1}">${escapeHtml(part.title)}</a></summary><div class="nav-sections">${sections}</div></details>`
  }).join('')
  const author = body.chips.find(chip => chip.label.toLowerCase() === 'author')?.value
  return `<aside class="sidebar" aria-label="Contents" id="folio-contents"><div class="sidebar-inner"><button class="close-contents">Close contents</button><h2 class="sidebar-title">${escapeHtml(body.title)}</h2>`
    + `${author ? `<p class="sidebar-author">${escapeHtml(author)}</p>` : ''}<p class="toc-label">Contents</p><nav>${links}</nav>`
    + `<div class="sidebar-meta">${body.sharedBy ? `<div>Shared by ${escapeHtml(body.sharedBy)}</div>` : ''}<div>Updated ${escapeHtml(formatUpdated(body.savedAt, body.timeZone))}</div></div></div></aside>`
}

const BODY_END = '</body></html>'

function documentShell(lang: string, title: string, inner: string, styles = STYLES): string {
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">'
    + `<title>${escapeHtml(title)}</title><style>${styles}</style></head><body>${inner}${BODY_END}`
}

/**
 * The page's root element. With comments on it carries what the script needs and nothing more:
 * that comments are on, the revision being read (sent with each note) and the name the author
 * shares under (for "only you and <name> see your comments"). The share id is in the address.
 */
function root(body: PublishBody, folio: boolean): string {
  const kind = folio ? ' folio' : ''
  const layout = folio ? ' data-layout="folio"' : ''
  if (!body.comments) return `<div class="rp readonly${kind}"${layout}>`
  const author = body.sharedBy ? ` data-author="${escapeHtml(body.sharedBy)}"` : ''
  return `<div class="rp notes${kind}"${layout} data-view="margin" data-comments="on" data-revision="${body.revision}"${author}>`
}

const NOTES_COLUMN = '<aside class="notes-col" aria-label="Comments"></aside>'

/** The whole reader page for a published share, rendered once at publish time. */
export function renderReaderPage(body: PublishBody): string {
  const styles = `${STYLES}\n${body.comments ? NOTES_STYLES : ''}\n${LAYOUT_STYLES}`
  const notes = body.comments ? NOTES_COLUMN : ''
  if (body.kind === 'folio') {
    const parts = visibleParts(body)
    const sections = parts.map(({ part, index }, at) => folioSection(part, index,
      at === 0 && part.title.trim().toLowerCase() === body.title.trim().toLowerCase())).join('')
    return documentShell(body.lang, body.title,
      `${root(body, true)}${readerBar(body)}<div class="rbody">${folioContents(body, parts)}${masthead(body)}`
      + `<article class="content">${sections}${madeWith()}</article>${notes}</div><button class="contents-scrim" aria-label="Close contents"></button></div>`, styles)
  }
  return documentShell(body.lang, body.title,
    `${root(body, false)}${readerBar(body)}<div class="rbody">`
    + `<article class="content">${masthead(body)}${body.parts[0].html ?? ''}${madeWith()}</article>${notes}</div></div>`, styles)
}

/**
 * The one answer for every reader request that does not reach a published page or image: an
 * address that never existed, a mistyped one, a link turned off, a share with nothing published,
 * an image the share does not use. Built from constants only, so it is the same bytes every time
 * A link turned off and a link that never existed give the same answer.
 */
const LINK_OFF_HTML = documentShell('en', 'This link has been turned off',
  `<div class="rp"><main class="offpage">${icon('link-2-off', 30)}<h1>This link has been turned off</h1>`
  + '<p>If you still need the text, ask the person who sent you the link.</p></main></div>')
const LINK_OFF_BYTES = new TextEncoder().encode(LINK_OFF_HTML)
export const LINK_OFF_STATUS = 404

function readerHeaders(contentType: string, csp: string): Headers {
  const headers = new Headers(READER_HEADERS)
  headers.set('content-type', contentType)
  headers.set('content-security-policy', csp)
  return headers
}

export function linkOffResponse(method = 'GET'): Response {
  const headers = readerHeaders('text/html; charset=utf-8', PAGE_CSP)
  return new Response(method === 'HEAD' ? null : LINK_OFF_BYTES.slice(), { status: LINK_OFF_STATUS, headers })
}

/**
 * A stored page as served: the page's script added before the end of the body, under a policy that
 * lets that script and no other run. A stored page that does not end as renderReaderPage ends it is
 * served without the script.
 */
export async function readerPageResponse(html: string, method = 'GET'): Promise<Response> {
  const page = html.endsWith(BODY_END) ? `${html.slice(0, -BODY_END.length)}<script>${READER_PAGE_RUNTIME}</script>${BODY_END}` : html
  const headers = readerHeaders('text/html; charset=utf-8', await readerPageCsp())
  return new Response(method === 'HEAD' ? null : new TextEncoder().encode(page), { status: 200, headers })
}

export function imageResponse(bytes: Uint8Array, contentType: string, method = 'GET'): Response {
  const headers = readerHeaders(contentType, IMAGE_CSP)
  return new Response(method === 'HEAD' ? null : bytes as Uint8Array<ArrayBuffer>, { status: 200, headers })
}
