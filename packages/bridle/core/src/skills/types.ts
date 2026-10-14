/**
 * A Bridle skill (PRD 2026-07-18): a purpose-specific agent = instructions + a
 * scope of the app's already-bound tools. Not scripts the user must install — a
 * skill names a subset of the app's Bridle-bound capabilities, so it's install-free
 * and safe by construction. Authored as a SKILL.md (YAML frontmatter + body).
 */

export type SkillTrigger = {
  /** Button label an app may surface to fire the skill one-shot. */
  label: string;
  icon?: string;
};

/** What a one-shot invocation operates on. */
export type SkillInput = "document" | "selection" | "folder" | "none";

export type Skill = {
  name: string;
  /** One-line summary — the only thing shown for progressive-disclosure discovery. */
  description: string;
  /** Subset of the app's bound capability names this skill may use. Empty = no tools. */
  tools: string[];
  /** Optional — an app surfaces this as a button. */
  trigger?: SkillTrigger;
  input: SkillInput;
  /** The skill body — loaded into the prompt only once the skill is activated. */
  instructions: string;
  /** Absolute path the skill was loaded from. */
  source: string;
};

export type SkillLoadError = { source: string; message: string };

/** Malformed skills never crash the load — they surface as errors, others still load. */
export type SkillLoadResult = { skills: Skill[]; errors: SkillLoadError[] };
