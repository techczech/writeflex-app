import { validPersonEmail } from '../../sharing-service/person-email'
// Main builds a draft only from the service's person and the app's current address.
export function invitationDraft(person: { name: string; email: string }, title: string, address: string): string | null {
  if (!validPersonEmail(person.email)) return null
  const firstName = person.name.trim().split(/\s+/)[0]
  const subject = `${title}: your link to read and comment`
  const body = `Hi ${firstName},\n\nHere is your own link to the ${title}. Open it in any browser to read and leave comments in the margin. The link is yours, so please don't pass it on.\n\n${address}\n\nDominik`
  return `mailto:${encodeURIComponent(person.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
