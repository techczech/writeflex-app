/** Coarse human recency for quiet lists; dates follow the app's British-English register. */
export function relativeTime(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Sync receipts retain precise local calendar times after the first hour. */
export function calendarTime(ts: number): string {
  if (Date.now() - ts < 60 * 60000) return relativeTime(ts)
  const date = new Date(ts), today = new Date(), yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === today.toDateString()) return `today ${time}`
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${time}`
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
