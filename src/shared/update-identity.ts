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

/**
 * Updating in place (ADR-0054): who this app is to the update engine. The engine (src/main/update-engine.ts) imports
 * nothing of WriteFlex; it is handed this object. Update files live only under the public repository's releases.
 */
export const UPDATE_INSTALL_IDENTITY = {
  appName: 'WriteFlex',
  /** The download's only header besides Accept and Cache-Control. */
  userAgent: 'WriteFlex',
  /** CFBundleIdentifier of the published Mac app (package.json build.appId). */
  bundleId: 'net.dominiklukes.writeflex',
  /** Every update file is `<prefix>v<version>/<file>.zip`. */
  releaseAssetPrefix: 'https://github.com/techczech/writeflex-app/releases/download/',
  /** The download cache folder under the computer's cache folder (`~/Library/Caches/writeflex-updater`). */
  cacheDirName: 'writeflex-updater',
} as const
