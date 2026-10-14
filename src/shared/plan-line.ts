export const PLAN_ROLES = ['section', 'vignette', 'appendix', 'summary'] as const

export type PlanLineMarker = '-' | '*' | `${number}.`

export type PlanLine = {
  marker: PlanLineMarker
  title: string
  gloss: string | null
  role: string
  tags: string[]
}

export type PlanLineInput = {
  title: string
  gloss?: string | null
  role?: string
  tags?: string[]
}

const ROLE_NAMES = new Set<string>(PLAN_ROLES)
const TAG = /^#[\p{L}\p{N}_-]+$/u
const TRAILING_TAGS = /(?:\s+#[\p{L}\p{N}_-]+)+\s*$/u

function splitTrailingTags(text: string): { text: string; tags: string[] } {
  const match = TRAILING_TAGS.exec(text)
  if (!match) return { text: text.trim(), tags: [] }
  return {
    text: text.slice(0, match.index).trim(),
    tags: match[0].trim().split(/\s+/).map((tag) => tag.slice(1)),
  }
}

/** Parse one list item from an Index Note's Running order section. */
export function parsePlanLine(line: string): PlanLine | null {
  const match = /^\s*(-|\*|\d+\.)\s+\[\[([^\]\n]+)\]\](.*)$/.exec(line)
  if (!match) return null
  const marker = match[1] as PlanLineMarker
  const title = match[2].split('|', 1)[0].split('#', 1)[0].trim()
  if (!title) return null

  const remainder = match[3]
  const emDash = remainder.indexOf(' — ')
  const hyphen = remainder.indexOf(' - ')
  const separator = emDash < 0 ? hyphen : hyphen < 0 ? emDash : Math.min(emDash, hyphen)
  const afterLink = separator < 0 ? splitTrailingTags(remainder) : splitTrailingTags(remainder.slice(separator + 3))
  if (separator < 0 && afterLink.text !== '') return null

  let role = 'section'
  const tags: string[] = []
  for (const tag of afterLink.tags) {
    const normalised = tag.toLocaleLowerCase()
    if (ROLE_NAMES.has(normalised)) role = normalised
    else tags.push(tag)
  }
  return {
    marker,
    title,
    gloss: separator < 0 || afterLink.text === '' ? null : afterLink.text,
    role,
    tags,
  }
}

/** Serialise one canonical Plan line; callers choose the surrounding list's marker style. */
export function serialisePlanLine(input: PlanLineInput, marker: PlanLineMarker = '-'): string {
  const title = input.title.trim()
  if (!title || title.includes(']]') || /[|#\r\n]/.test(title)) throw new Error('Plan title cannot be represented as a wikilink.')
  const role = (input.role?.trim() || 'section').toLocaleLowerCase()
  if (!ROLE_NAMES.has(role)) throw new Error(`Unknown Plan role: ${input.role}`)
  const tags = input.tags ?? []
  if (tags.some((tag) => !TAG.test(`#${tag}`) || tag.startsWith('#'))) throw new Error('Plan tag cannot contain spaces or Markdown punctuation.')
  const gloss = input.gloss?.trim() || null
  const suffix = [role === 'section' ? null : `#${role}`, ...tags.map((tag) => `#${tag}`)].filter(Boolean).join(' ')
  return `${marker} [[${title}]]${gloss ? ` — ${gloss}` : ''}${suffix ? ` ${suffix}` : ''}`
}
