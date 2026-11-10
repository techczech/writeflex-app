import { feedRequest, isSiteLink, parseVersion, type UpdateFeedLatest } from '@app-patterns/updates'

export const UPDATE_IDENTITY = {
  appName: 'WriteFlex',
  feedUrl: 'https://writeflex.app/updates.json',
  storeName: 'Microsoft Store',
  storeUrl: 'https://apps.microsoft.com/search?query=WriteFlex',
}
export const FEED_URL = UPDATE_IDENTITY.feedUrl
export const FEED_REQUEST = feedRequest(UPDATE_IDENTITY)
export const STORE_LINK = UPDATE_IDENTITY.storeUrl

// Older bundled notes remain reachable even when the feed describes a newer release.
export function notesLinkFor(latest: UpdateFeedLatest | undefined, version: string): string | null {
  if (!parseVersion(version)) return null
  return latest?.version === version && isSiteLink(latest.notes, FEED_URL)
    ? latest.notes : `https://writeflex.app/whats-new#${version}`
}
