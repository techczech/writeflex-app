export type ReleaseNoteGroup = {
  title: 'Added' | 'Changed' | 'Fixed'
  items: ReleaseNoteItem[]
}

export type ReleaseNoteItem = {
  lead: string | null
  body: string
}

export type ReleaseNoteRelease = {
  version: string
  date: string | null
  groups: ReleaseNoteGroup[]
}

export type ParsedReleaseNotes = {
  releases: ReleaseNoteRelease[]
  currentRelease: ReleaseNoteRelease | null
  hasEarlierReleases: boolean
}

const RELEASE_HEADING = /^##\s+\[([^\]]+)\](?:\s+—\s*(.*))?\s*$/
const GROUP_HEADING = /^###\s+(Added|Changed|Fixed)\s*$/
const BULLET = /^-\s+(.*)$/
const BOLD_LEAD = /^\*\*(.+?)\*\*\s*(.*)$/

function cleanInlineMarkdown(value: string): string {
  return value.replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
}

function parseItem(source: string): ReleaseNoteItem {
  const cleaned = cleanInlineMarkdown(source)
  const boldLead = cleaned.match(BOLD_LEAD)
  if (!boldLead) return { lead: null, body: cleaned }
  return { lead: cleanInlineMarkdown(boldLead[1]), body: cleanInlineMarkdown(boldLead[2]) }
}

/** Parse the user-facing release sections in CHANGELOG.md without rendering Markdown syntax. */
export function parseReleaseNotes(source: string, currentVersion: string | null, limit = 20): ParsedReleaseNotes {
  const parsed: ReleaseNoteRelease[] = []
  let release: ReleaseNoteRelease | null = null
  let group: ReleaseNoteGroup | null = null

  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(RELEASE_HEADING)
    if (heading) {
      release = { version: heading[1], date: heading[2]?.trim() || null, groups: [] }
      parsed.push(release)
      group = null
      continue
    }
    if (!release) continue
    const groupHeading = line.match(GROUP_HEADING)
    if (groupHeading) {
      group = { title: groupHeading[1] as ReleaseNoteGroup['title'], items: [] }
      release.groups.push(group)
      continue
    }
    const bullet = line.match(BULLET)
    if (bullet && group) group.items.push(parseItem(bullet[1]))
  }

  const safeLimit = Math.max(0, Math.floor(limit))
  const releases = parsed.slice(0, safeLimit)
  const currentRelease = currentVersion ? releases.find((entry) => entry.version === currentVersion) ?? null : null
  return { releases, currentRelease, hasEarlierReleases: parsed.length > releases.length }
}
