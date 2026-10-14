import { loadSkills, type Skill, type SkillInput, type SkillLoadError } from '@bridle/core'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from './frontmatter'

export type SkillMeta = {
  name: string
  /** SKILL.md `title:` — the on-screen name when set (ticket 11); absent, the name is shown. */
  title?: string
  description: string
  icon: string | undefined
  tools: string[]
  input: SkillInput
  source: string
}

/** A loaded skill plus its SKILL.md `title:` (ticket 11). Bridle's loader ignores the key, so the
 *  registry reads it itself; the on-screen name comes from here, never from a hard-coded label. */
export type RegisteredSkill = Skill & { title?: string }

/** A SKILL.md's top-level `title:`, trimmed; undefined when absent, empty or the file has no frontmatter. */
export function skillTitleFromMarkdown(raw: string): string | undefined {
  const title = parseFrontmatter(raw.replace(/^\uFEFF/, ''))?.title?.trim()
  return title ? title : undefined
}

async function withTitle(skill: Skill): Promise<RegisteredSkill> {
  try {
    const title = skillTitleFromMarkdown(await readFile(skill.source, 'utf8'))
    return title ? { ...skill, title } : skill
  } catch {
    return skill // unreadable since loading: the name still shows, never a failed list
  }
}

export type SkillProposeEditInput = { name: string; request: string }
export type SkillApplyEditInput = { name: string; content: string }
export type SkillOpenForEditingInput = { name: string }

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function inputRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

/** A skill NAME is an identifier, never a path (review finding B5 review r1+r2): reject exactly PATH syntax —
 *  separators, and the whole-name dot / dot-dot — without inventing a narrower identifier grammar
 *  than the bridle loader's (which accepts any trimmed non-empty string, `draft..review` included).
 *  With separators banned, a dot-dot SEGMENT can only ever be the entire name. */
function plainSkillName(value: unknown): value is string {
  return nonEmptyString(value) && !/[/\\]/.test(value) && value !== '.' && value !== '..'
}

export function parseSkillProposeEditInput(input: unknown): SkillProposeEditInput {
  const record = inputRecord(input)
  if (!record || !plainSkillName(record.name) || !nonEmptyString(record.request)) {
    throw new Error('Invalid skills:propose-edit payload: name must be a plain skill name and request a non-empty string.')
  }
  return { name: record.name, request: record.request }
}

export function parseSkillApplyEditInput(input: unknown): SkillApplyEditInput {
  const record = inputRecord(input)
  if (!record || !plainSkillName(record.name) || !nonEmptyString(record.content)) {
    throw new Error('Invalid skills:apply-edit payload: name must be a plain skill name and content a non-empty string.')
  }
  return { name: record.name, content: record.content }
}

export function parseSkillOpenForEditingInput(input: unknown): SkillOpenForEditingInput {
  const record = inputRecord(input)
  if (!record || !plainSkillName(record.name)) {
    throw new Error('Invalid skills:open-for-editing payload: name must be a plain skill name.')
  }
  return { name: record.name }
}

export class SkillsRegistry {
  private readonly skillsDir: string
  private readonly bundledSkillsDir: string
  private seedErrors: SkillLoadError[] = []
  /** Exact registered source -> last queued apply. Different skills remain independent. */
  private applyTails = new Map<string, Promise<void>>()
  /** Preserve caller order while resolving names to exact sources and placing them on those queues. */
  private applyAdmission: Promise<void> = Promise.resolve()

  constructor(paths: { appDataDir: string; bundledSkillsDir: string }) {
    this.skillsDir = join(paths.appDataDir, 'skills')
    this.bundledSkillsDir = resolve(paths.bundledSkillsDir)
  }

  async init(): Promise<void> {
    this.seedErrors = []
    try {
      await mkdir(this.skillsDir, { recursive: true })
      // Clean-up is deliberately limited to frontmatter capabilities until a designed
      // housekeeping.tidy round; the bundled file must advertise only real tools (OPEN-QUESTIONS #1,
      // resolved 2026-07-24: description trimmed to the truth).
      // report-structure (ticket 10) runs on a folder: the Plan pane, the folder menu and the palette.
      const bundledSkillNames = ['copy-edit', 'review', 'clean-up', 'report-structure']
      for (const name of bundledSkillNames) {
        const destination = join(this.skillsDir, name)
        const bundledFile = join(this.bundledSkillsDir, name, 'SKILL.md')
        const seededFile = join(destination, 'SKILL.md')
        const sidecar = join(destination, '.bundled.sha256')
        if (!existsSync(destination)) {
          await cp(join(this.bundledSkillsDir, name), destination, { recursive: true, force: false, errorOnExist: true })
          await writeFile(sidecar, await fileSha256(bundledFile), 'utf8')
          continue
        }
        // A copy the user NEVER edited (its hash still equals the recorded seeded hash — or, for
        // pre-sidecar copies, it is byte-identical to the current bundle) may take bundle fixes;
        // an edited copy is sacred and is never touched, ever.
        const currentHash = existsSync(seededFile) ? await fileSha256(seededFile) : null
        const bundledHash = await fileSha256(bundledFile)
        if (currentHash === null) continue
        const recordedHash = existsSync(sidecar) ? (await readFile(sidecar, 'utf8')).trim() : null
        if (recordedHash === null) {
          if (currentHash === bundledHash) await writeFile(sidecar, bundledHash, 'utf8')
          continue // pre-sidecar and different from the bundle: cannot prove pristine — hands off
        }
        if (currentHash === recordedHash && currentHash !== bundledHash) {
          await copyFile(bundledFile, seededFile)
          await writeFile(sidecar, bundledHash, 'utf8')
        }
      }
    } catch (error) {
      this.seedErrors = [{
        source: this.bundledSkillsDir,
        message: `Could not seed bundled skills: ${errorMessage(error)}`,
      }]
    }
  }

  async list(): Promise<{ skills: SkillMeta[]; errors: SkillLoadError[] }> {
    const loaded = await loadSkills(this.skillsDir)
    const titled = await Promise.all(loaded.skills.map(withTitle))
    return {
      skills: titled.map(({ name, title, description, trigger, tools, input, source }) => ({
        name,
        ...(title ? { title } : {}),
        description,
        icon: trigger?.icon,
        tools,
        input,
        source,
      })),
      errors: [...this.seedErrors, ...loaded.errors],
    }
  }

  async get(name: string): Promise<{ skill: RegisteredSkill | null; errors: SkillLoadError[] }> {
    const loaded = await loadSkills(this.skillsDir)
    const found = loaded.skills.find((skill) => skill.name === name)
    return {
      skill: found ? await withTitle(found) : null,
      errors: [...this.seedErrors, ...loaded.errors],
    }
  }

  /** Resolve only a currently registered skill file; caller-supplied names never become paths. */
  async resolveOpenForEditing(name: string): Promise<{ root: string; source: string }> {
    const input = parseSkillOpenForEditingInput({ name })
    const source = await this.registeredSource(input.name)
    // ADR-0007 promotes a foreign file to the nearest marked Workspace. Mark the shared skills
    // folder (not the individual skill) because that window manages the whole registry, and use
    // Bridle's own marker: this Workspace immediately owns Bridle snapshots and is not a Library.
    await mkdir(join(this.skillsDir, '.bridle'), { recursive: true })
    return { root: this.skillsDir, source }
  }

  /** `app:show-item` is normally Workspace-relative. The manager's malformed rows are the one
   * absolute-path exception: admit only a path that the registry currently reports as an error. */
  async resolveRevealErrorSource(input: unknown): Promise<string> {
    if (!nonEmptyString(input) || !isAbsolute(input)) {
      throw new Error('The requested path is not a current skill load error.')
    }
    const candidate = resolve(input)
    const { errors } = await this.list()
    if (!errors.some((error) => resolve(error.source) === candidate)) {
      throw new Error('The requested path is not a current skill load error.')
    }
    return candidate
  }

  /** Snapshot the current file once, then replace it with a sibling-temp rename. */
  async applyEdit(name: string, content: string): Promise<{ source: string; backup: string }> {
    const input = parseSkillApplyEditInput({ name, content })
    let source!: string
    let operation!: Promise<{ source: string; backup: string }>
    let tail!: Promise<void>
    const admitted = this.applyAdmission.then(async () => {
      source = await this.registeredSource(input.name)
      const previous = this.applyTails.get(source) ?? Promise.resolve()
      operation = previous.catch(() => {}).then(() => this.applyResolvedEdit(source, input.content))
      tail = operation.then(() => {}, () => {})
      this.applyTails.set(source, tail)
    })
    this.applyAdmission = admitted.catch(() => {})
    await admitted
    try {
      return await operation
    } finally {
      if (this.applyTails.get(source) === tail) this.applyTails.delete(source)
    }
  }

  private async applyResolvedEdit(source: string, content: string): Promise<{ source: string; backup: string }> {
    const current = await readFile(source, 'utf8')
    let timestamp = Date.now()
    let backup = `${source}.bak-${timestamp}`
    while (existsSync(backup)) backup = `${source}.bak-${++timestamp}`
    await writeFile(backup, current, { encoding: 'utf8', flag: 'wx' })
    const temp = join(dirname(source), `.${basename(source)}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, content, 'utf8')
      await rename(temp, source)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    return { source, backup }
  }

  private async registeredSource(name: string): Promise<string> {
    const { skill, errors } = await this.get(name)
    if (!skill) {
      const detail = errors.find((error) => error.source.includes(name))?.message
      throw new Error(detail ? `${name}: ${detail}` : `No skill named "${name}" is available.`)
    }
    const source = resolve(skill.source)
    const fromRoot = relative(this.skillsDir, source)
    if (
      !fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)
      || resolve(this.skillsDir, fromRoot) !== source
    ) {
      throw new Error(`The registered source for "${name}" is outside the skills folder.`)
    }
    return source
  }
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
