import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Skill, SkillInput, SkillLoadError, SkillLoadResult, SkillTrigger } from "./types.ts";

/**
 * Load an app's bundled skills from a directory (PRD ticket S1; hardened after
 * Sol review round 2). Skills are SKILL.md files, either folder-form
 * (`<dir>/<name>/SKILL.md`, the Claude-Code shape) or flat (`<dir>/<name>.md`).
 * A malformed or unreadable skill is recorded as an error, never a crash — the
 * rest still load. A missing directory yields an empty result; any OTHER
 * directory failure is a directory-level error (an unreadable dir must not
 * impersonate an app that ships zero skills). Present-but-invalid frontmatter
 * fields are errors, not silent defaults.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const VALID_INPUT: readonly SkillInput[] = ["document", "selection", "folder", "none"];
/** Bounded read: a skill is instructions, not a corpus. */
export const MAX_SKILL_BYTES = 1_000_000;

/** Parse one SKILL.md's raw text into a Skill, or return an error message. */
export function parseSkill(raw: string, source: string): Skill | string {
  const match = FRONTMATTER_RE.exec(raw.replace(/^﻿/, "").trimStart());
  if (!match) return "missing YAML frontmatter (--- … ---)";
  let fm: unknown;
  try { fm = parseYaml(match[1] ?? ""); } catch (error) { return `unreadable frontmatter: ${(error as Error).message}`; }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return "frontmatter must be a mapping";
  const f = fm as Record<string, unknown>;

  const name = typeof f.name === "string" ? f.name.trim() : "";
  if (!name) return "frontmatter.name is required";
  const description = typeof f.description === "string" ? f.description.trim() : "";
  if (!description) return "frontmatter.description is required";

  if (f.tools !== undefined && (!Array.isArray(f.tools) || f.tools.some((t) => typeof t !== "string"))) {
    return "frontmatter.tools must be a list of capability names";
  }
  const tools = Array.isArray(f.tools) ? (f.tools as string[]) : [];

  // Present-but-invalid is an authoring mistake to surface, never a silent default.
  if (f.input !== undefined && !VALID_INPUT.includes(f.input as SkillInput)) {
    return `frontmatter.input must be one of ${VALID_INPUT.join(", ")}`;
  }
  const input: SkillInput = (f.input as SkillInput) ?? "none";

  let trigger: SkillTrigger | undefined;
  if (f.trigger !== undefined) {
    if (typeof f.trigger !== "object" || f.trigger === null || Array.isArray(f.trigger)) {
      return "frontmatter.trigger must be a mapping with a label";
    }
    const t = f.trigger as Record<string, unknown>;
    if (typeof t.label !== "string" || !t.label.trim()) return "frontmatter.trigger needs a non-empty label";
    trigger = { label: t.label.trim(), ...(typeof t.icon === "string" ? { icon: t.icon } : {}) };
  }

  const instructions = (match[2] ?? "").trim();
  if (!instructions) return "skill has no instructions body — the body IS the skill";

  return {
    name, description, tools, input, instructions, source,
    ...(trigger ? { trigger } : {}),
  };
}

export async function loadSkills(skillsDir: string): Promise<SkillLoadResult> {
  const dir = resolve(skillsDir);
  const skills: Skill[] = [];
  const errors: SkillLoadError[] = [];

  // ONLY a genuinely absent directory is "app ships zero skills" (ENOENT);
  // any other lookup failure is an error, never an empty success (Sol F6 r3).
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { skills, errors };
    errors.push({ source: dir, message: `unreadable skills directory: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` });
    return { skills, errors };
  }

  // Deterministic order so "first wins" on duplicate names is stable.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const seenNames = new Map<string, string>();
  for (const entry of entries) {
    let file: string | null = null;
    if (entry.isDirectory()) {
      const candidate = join(dir, entry.name, "SKILL.md");
      try {
        await stat(candidate);
        file = candidate;
      } catch (error) {
        // Absent SKILL.md = not a skill folder; anything else is a real failure.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push({ source: candidate, message: `unreadable skill file: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` });
        }
        continue;
      }
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md" && entry.name !== "README.md") {
      file = join(dir, entry.name);
    }
    if (!file) continue;

    let raw;
    try {
      const info = await stat(file);
      if (info.size > MAX_SKILL_BYTES) {
        errors.push({ source: file, message: `skill file too large (${info.size} bytes; limit ${MAX_SKILL_BYTES})` });
        continue;
      }
      raw = await readFile(file, "utf8");
    } catch (error) {
      errors.push({ source: file, message: `unreadable skill file: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` });
      continue;
    }
    const parsed = parseSkill(raw, file);
    if (typeof parsed === "string") {
      errors.push({ source: file, message: parsed });
      continue;
    }
    const first = seenNames.get(parsed.name);
    if (first) {
      errors.push({ source: file, message: `duplicate skill name "${parsed.name}" (already loaded from ${first})` });
      continue;
    }
    seenNames.set(parsed.name, file);
    skills.push(parsed);
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills, errors };
}
