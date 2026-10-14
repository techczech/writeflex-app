/**
 * How a skill is named and scoped on screen (ticket 11). Pure, shared by main (thread titles) and the
 * renderer (banner, switcher, toasts), so every surface names a skill the same way.
 *
 * A skill's display name is its SKILL.md `title:` when it has one ("Help with this report", the label
 * its launch points already use), else its name in CONTENT.md's register ("copy-edit" → "Copy-edit").
 */

export type SkillNaming = { name: string; title?: string | undefined }

export function skillDisplayName(skill: SkillNaming | string): string {
  const { name, title } = typeof skill === 'string' ? { name: skill, title: undefined } : skill
  const titled = title?.trim()
  if (titled) return titled
  return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name
}

/** The display name for a skill known only by name: its registry entry's title when listed. */
export function skillDisplayNameFor(name: string, skills: readonly SkillNaming[]): string {
  return skillDisplayName(skills.find((skill) => skill.name === name) ?? name)
}

/** The last segment of a workspace-relative folder path, for the scope chip ("" is the workspace). */
function folderName(dir: string): string {
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? dir
}

/**
 * The "reads" scope chip's wording. A document skill reads the open document; a folder skill
 * (`input: folder`) works on the folder it was launched on, named when that folder is known.
 */
export function readScopeLabel(input: string, folder: string | null = null): string {
  if (input !== 'folder') return 'reads this document'
  const name = folder === null ? '' : folderName(folder)
  return name ? `works on this folder · ${name}` : 'works on a folder'
}

/**
 * The running line's words, shown the instant a skill run starts. A folder skill reads its folder,
 * named when known; a document skill reads the open document. Staging reads the same for both.
 */
export function runningLineText(displayName: string, staging: boolean, input: string = 'document', folder: string | null = null): string {
  if (staging) return `${displayName} is staging changes…`
  if (input !== 'folder') return `${displayName} is reading your document…`
  const name = folder === null ? '' : folderName(folder)
  return name ? `${displayName} is reading ${name}…` : `${displayName} is reading the folder…`
}
