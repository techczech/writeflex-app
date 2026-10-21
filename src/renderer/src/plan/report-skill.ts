/**
 * Where a skill run lands (ticket 10). Document skills run on the open document; a folder skill
 * (`input: folder`, the bundled report-structure skill) runs on a folder. The Plan pane and a
 * folder's menu hand over their own folder; the palette, the switcher and the chords have none of
 * their own, so they act on the focused folder (ticket 03's Focus). Pure, so every door agrees.
 */
import type { SkillMeta } from '../../../preload'

export const REPORT_SKILL = 'report-structure'
/** The palette command: the report skill on the focused folder. */
export const REPORT_SKILL_COMMAND = 'skill.run.report-structure'
/** The folder menu's item: the report skill on the folder that was right-clicked. */
export const FOLDER_REPORT_SKILL_COMMAND = 'folder.helpWithReport'

export type SkillLaunch =
  | { kind: 'document' }
  | { kind: 'folder'; dir: string }
  | { kind: 'refused'; message: string }

export function skillLaunchTarget(
  skill: Pick<SkillMeta, 'input'> | undefined,
  displayName: string,
  situation: { activeFile: string | null; focusedFolder: string | null },
): SkillLaunch {
  if (skill?.input === 'folder') {
    return situation.focusedFolder === null
      ? { kind: 'refused', message: `${displayName} works on a folder. Focus one first, or start it from the Folio outline or a folder’s menu.` }
      : { kind: 'folder', dir: situation.focusedFolder }
  }
  if (skill?.input === 'document' && situation.activeFile === null) {
    return { kind: 'refused', message: `${displayName} needs an open document.` }
  }
  return { kind: 'document' }
}
