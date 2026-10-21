// What the Sharing page shows for a link, decided from its view (sharing ticket 03). Pure, so the
// states and sentences are tested without a window.
import { linkLabel, type ShareLinkView } from '../../../../shared/sharing-links'
import { shortTime } from './sharing-view-model'

export type LinkState = { kind: 'off' | 'not-found' | 'not-published' | 'publishing' | 'published' | 'part-missing' | 'nothing'; label: string; tone: 'ok' | 'warn' | 'off' | 'live' }

export function linkState(link: ShareLinkView): LinkState {
  if (!link.on) return { kind: 'off', label: 'Off', tone: 'off' }
  // Ticket 04 (ruling R-B): the piece is not where the share has it; nothing is published until the writer decides.
  if (link.lost) return { kind: 'not-found', label: 'Piece not found', tone: 'warn' }
  if (link.problem) return { kind: 'not-published', label: 'Not published', tone: 'warn' }
  if (link.publishing && link.publishedAt === null) return { kind: 'publishing', label: 'Publishing…', tone: 'live' }
  // A Folio link (ticket 09, frame `folio`): published, with a part readers see as "not available".
  if (link.publishedAt !== null && (link.missingParts ?? 0) > 0) return { kind: 'part-missing', label: 'Part missing', tone: 'warn' }
  if (link.publishedAt !== null) return { kind: 'published', label: 'Published', tone: 'ok' }
  return { kind: 'nothing', label: 'Nothing published', tone: 'off' }
}

/** The right-column "Not published" row (frame `problems`): what happened and what readers see. */
export function notPublishedText(link: ShareLinkView, now = Date.now()): string {
  const reason = link.problem?.reason ?? ''
  if (link.publishedAt === null) return `${reason} Nothing has been published on this link yet, so readers see the link-off page. Your saves are published when it works again.`
  const when = shortTime(link.publishedAt, now)
  // Ticket 04 (frame `problems`): a save waiting is kept on this Mac, through a restart, and sent once publishing works.
  const saves = link.queued ? 'Saves since then are kept on this Mac and sent when publishing works.' : 'Saves since then are published when it works again.'
  return `${reason} The last copy went out at ${when}. Readers see that version, labelled with its time. ${saves}`
}

/** "Updated 14 October 2026, 14:02", as the reader page writes it. */
export function updatedLabel(savedAt: number | null): string {
  if (savedAt === null) return 'Not published yet'
  const date = new Date(savedAt)
  return `Updated ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/** The address without its scheme, as the drawn field shows it. */
export const bareAddress = (address: string): string => address.replace(/^https:\/\//, '')

/**
 * Ticket 05, own address lapsed: the piece's links that are on, again on the address Cloudflare gives
 * the account, to send again. One link: its address alone; several: one line each, with its name.
 */
export function copyAgainText(links: readonly ShareLinkView[]): string {
  const on = links.filter((link) => link.on)
  const address = (link: ShareLinkView): string => link.cloudflareAddress ?? link.address
  if (on.length === 1) return address(on[0])
  return on.map((link) => `${linkLabel(link)}: ${address(link)}`).join('\n')
}
