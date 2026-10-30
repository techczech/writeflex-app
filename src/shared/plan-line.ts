/** The Plan's roles. `front-matter` (ADR-0046, shared/folio-front-matter.ts) exports before the contents and is never in them. */
export const PLAN_ROLES = ['section', 'vignette', 'appendix', 'summary', 'front-matter'] as const

export type PlanLineMarker = '-' | '*' | `${number}.`

export type PlanLine = {
  marker: PlanLineMarker
  title: string
  /** Link destination, separate from its displayed label. Absent for unaliased legacy title links. */
  target?: string
  /** Literal heading fragment, including #, independent of the file target. */
  fragment?: string
  gloss: string | null
  /** The last role tag on the line (`section` when none). */
  role: string
  tags: string[]
  /**
   * Whether the line carries `#front-matter` among its tags, whatever role it ends on (ADR-0046): the tag is a
   * sufficient front-matter marker on its own, so `#front-matter #summary` is still front matter.
   */
  frontMatter: boolean
}

export type PlanLineInput = {
  title: string
  /** Link destination, separate from its displayed label. Absent for unaliased legacy title links. */
  target?: string
  /** Literal heading fragment, including #, independent of the file target. */
  fragment?: string
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
  const separatorAt = match[2].indexOf('|')
  const rawTarget = separatorAt < 0 ? match[2] : match[2].slice(0, separatorAt)
  const fragmentAt = rawTarget.indexOf('#')
  const fragment = fragmentAt < 0 ? undefined : rawTarget.slice(fragmentAt)
  const target = rawTarget.split('#', 1)[0].trim()
  const title = separatorAt < 0 ? target : unescapePlanLink(match[2].slice(separatorAt + 1).trim())
  if (!title) return null

  const remainder = match[3]
  const emDash = remainder.indexOf(' — ')
  const hyphen = remainder.indexOf(' - ')
  const separator = emDash < 0 ? hyphen : hyphen < 0 ? emDash : Math.min(emDash, hyphen)
  const afterLink = separator < 0 ? splitTrailingTags(remainder) : splitTrailingTags(remainder.slice(separator + 3))
  if (separator < 0 && afterLink.text !== '') return null

  let role = 'section'
  let frontMatter = false
  const tags: string[] = []
  for (const tag of afterLink.tags) {
    const normalised = tag.toLocaleLowerCase()
    if (normalised === 'front-matter') frontMatter = true
    if (ROLE_NAMES.has(normalised)) role = normalised
    else tags.push(tag)
  }
  return {
    marker,
    title,
    ...(fragment ? { fragment } : {}),
    ...(separatorAt >= 0 || target.startsWith('./') ? { target } : {}),
    gloss: separator < 0 || afterLink.text === '' ? null : afterLink.text,
    role,
    tags,
    frontMatter,
  }
}

/** Serialise one canonical Plan line; callers choose the surrounding list's marker style. */
export function serialisePlanLine(input: PlanLineInput, marker: PlanLineMarker = '-'): string {
  const title = input.title.trim()
  if (!title || (!input.target && (title.includes(']]') || /[|#\r\n]/.test(title)))) throw new Error('Folio outline title cannot be represented as a wikilink.')
  const target = input.target
  if (target && (!target.trim() || /[|#\[\]\r\n]/.test(target))) throw new Error('Folio file target must be escaped.')
  if (input.fragment && (!input.fragment.startsWith('#') || /[|\]\r\n]/.test(input.fragment))) throw new Error('Invalid Folio heading fragment.')
  const fragment = input.fragment ?? ''
  const link = target ? `${target}${fragment}|${escapePlanLink(title)}` : `${title}${fragment}`
  const role = (input.role?.trim() || 'section').toLocaleLowerCase()
  if (!ROLE_NAMES.has(role)) throw new Error(`Unknown Folio outline role: ${input.role}`)
  const tags = input.tags ?? []
  if (tags.some((tag) => !TAG.test(`#${tag}`) || tag.startsWith('#'))) throw new Error('Folio outline tag cannot contain spaces or Markdown punctuation.')
  const gloss = input.gloss?.trim() || null
  const suffix = [role === 'section' ? null : `#${role}`, ...tags.map((tag) => `#${tag}`)].filter(Boolean).join(' ')
  return `${marker} [[${link}]]${gloss ? ` — ${gloss}` : ''}${suffix ? ` ${suffix}` : ''}`
}

/** Escape only wikilink delimiters and percent, leaving readable relative paths and spaces intact. */
export function escapePlanLink(value: string): string {
  return value.replace(/[%#|\[\]\r\n]/g, char => encodeURIComponent(char))
}

export function unescapePlanLink(value: string): string {
  // Decode only our delimiters: legacy percent text (and encoded separators) cannot change containment.
  return value.replace(/%(?:25|23|7c|5b|5d|0d|0a)/gi, token => String.fromCharCode(parseInt(token.slice(1), 16)))
}
