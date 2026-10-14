import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadSkills } from '@bridle/core'
import { SkillsRegistry } from '../../src/main/skills'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { Workspace } from '../../src/main/workspace'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `wf-skills-${label}-`))
  roots.push(root)
  return root
}

function skillMarkdown(input: {
  name: string
  description: string
  icon: string
  tools: string[]
  body: string
  input?: 'document' | 'folder'
  label?: string
}): string {
  return `---
name: ${input.name}
description: ${input.description}
tools: [${input.tools.join(', ')}]
input: ${input.input ?? 'document'}
trigger:
  label: ${input.label ?? 'Run on this document'}
  icon: ${input.icon}
---

${input.body}
`
}

async function writeSkill(root: string, folder: string, markdown: string): Promise<string> {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  await writeFile(path, markdown)
  return path
}

async function fakeBundle(): Promise<{ appDataDir: string; bundledSkillsDir: string }> {
  const root = await tempRoot('bundle')
  const appDataDir = join(root, 'app-data')
  const bundledSkillsDir = join(root, 'bundled')
  await writeSkill(bundledSkillsDir, 'review', skillMarkdown({
    name: 'review',
    description: 'Critical notes.',
    icon: 'glasses',
    tools: ['files.read', 'housekeeping.create_file'],
    body: 'Review the whole document.',
  }))
  await writeSkill(bundledSkillsDir, 'clean-up', skillMarkdown({
    name: 'clean-up',
    description: 'Mechanical housekeeping.',
    icon: 'eraser',
    tools: ['files.read', 'frontmatter.normalise'],
    body: 'Normalise the frontmatter.',
  }))
  await writeSkill(bundledSkillsDir, 'copy-edit', skillMarkdown({
    name: 'copy-edit',
    description: 'Light copy-editing.',
    icon: 'pen-line',
    tools: ['files.read', 'prose.edit'],
    body: 'Work sentence by sentence.',
  }))
  await writeSkill(bundledSkillsDir, 'report-structure', skillMarkdown({
    name: 'report-structure',
    description: 'A report as a whole.',
    icon: 'list-ordered',
    tools: ['files.read', 'plan.read'],
    body: 'Start with plan.read.',
    input: 'folder',
    label: 'Help with this report',
  }))
  return { appDataDir, bundledSkillsDir }
}

test('seeds bundled skills and exposes metadata separately from full instructions', async () => {
  const paths = await fakeBundle()
  const registry = new SkillsRegistry(paths)
  await registry.init()

  const listed = await registry.list()
  expect(listed.errors).toEqual([])
  expect(listed.skills.map((skill) => skill.name)).toEqual(['clean-up', 'copy-edit', 'report-structure', 'review'])
  expect(listed.skills).toEqual([
    {
      name: 'clean-up',
      description: 'Mechanical housekeeping.',
      icon: 'eraser',
      tools: ['files.read', 'frontmatter.normalise'],
      input: 'document',
      source: join(paths.appDataDir, 'skills', 'clean-up', 'SKILL.md'),
    },
    {
      name: 'copy-edit',
      description: 'Light copy-editing.',
      icon: 'pen-line',
      tools: ['files.read', 'prose.edit'],
      input: 'document',
      source: join(paths.appDataDir, 'skills', 'copy-edit', 'SKILL.md'),
    },
    {
      name: 'report-structure',
      description: 'A report as a whole.',
      icon: 'list-ordered',
      tools: ['files.read', 'plan.read'],
      input: 'folder',
      source: join(paths.appDataDir, 'skills', 'report-structure', 'SKILL.md'),
    },
    {
      name: 'review',
      description: 'Critical notes.',
      icon: 'glasses',
      tools: ['files.read', 'housekeeping.create_file'],
      input: 'document',
      source: join(paths.appDataDir, 'skills', 'review', 'SKILL.md'),
    },
  ])
  expect('instructions' in listed.skills[0]).toBe(false)

  const found = await registry.get('copy-edit')
  expect(found.errors).toEqual([])
  expect(found.skill?.instructions).toBe('Work sentence by sentence.')
})

test('returns malformed-skill errors alongside healthy skills', async () => {
  const paths = await fakeBundle()
  const registry = new SkillsRegistry(paths)
  await registry.init()
  const brokenPath = await writeSkill(join(paths.appDataDir, 'skills'), 'broken', 'No frontmatter here.\n')

  const result = await registry.list()
  expect(result.skills.map((skill) => skill.name)).toEqual(['clean-up', 'copy-edit', 'report-structure', 'review'])
  expect(result.errors).toEqual([{ source: brokenPath, message: 'missing YAML frontmatter (--- … ---)' }])
})

test('reloads an edited skill on the next activation', async () => {
  const paths = await fakeBundle()
  const registry = new SkillsRegistry(paths)
  await registry.init()
  expect((await registry.get('copy-edit')).skill?.instructions).toBe('Work sentence by sentence.')

  const userPath = join(paths.appDataDir, 'skills', 'copy-edit', 'SKILL.md')
  const original = await readFile(userPath, 'utf8')
  await writeFile(userPath, original.replace('Work sentence by sentence.', 'Use the newly edited instructions.'))

  expect((await registry.get('copy-edit')).skill?.instructions).toBe('Use the newly edited instructions.')
})

test('initialisation never clobbers a pre-existing user-edited skill', async () => {
  const paths = await fakeBundle()
  const userPath = await writeSkill(join(paths.appDataDir, 'skills'), 'copy-edit', skillMarkdown({
    name: 'copy-edit',
    description: 'User copy.',
    icon: 'pen-line',
    tools: ['files.read', 'prose.edit'],
    body: 'Keep my custom instructions.',
  }))
  const registry = new SkillsRegistry(paths)

  await registry.init()
  await registry.init()

  expect(await readFile(userPath, 'utf8')).toContain('Keep my custom instructions.')
  expect((await registry.get('copy-edit')).skill?.instructions).toBe('Keep my custom instructions.')
})

test('the real bundled resources contain exactly four cleanly parsed skills', async () => {
  const result = await loadSkills(resolve('resources/skills'))
  expect(result.errors).toEqual([])
  expect(result.skills.map((skill) => skill.name)).toEqual(['clean-up', 'copy-edit', 'report-structure', 'review'])
})

test('the report-structure skill loads on a folder with the plan verbs, each one a registered capability', async () => {
  const { skills } = await loadSkills(resolve('resources/skills'))
  const report = skills.find((skill) => skill.name === 'report-structure')
  expect(report).toMatchObject({
    input: 'folder',
    tools: ['files.read', 'plan.read', 'plan.compare_parts', 'plan.propose', 'prose.insert'],
    trigger: { label: 'Help with this report', icon: 'list-ordered' },
  })
  // The tools line names verbs exactly as the manifest registers them; a misspelt name would scope
  // the thread to nothing for that tool.
  const registered = new Set(buildWriteFlexManifest(new Workspace(resolve('.'))).capabilities.map((capability) => capability.name))
  for (const tool of report!.tools) expect(registered.has(tool), tool).toBe(true)
  // The approved rules the thread depends on reached the shipped body.
  expect(report!.instructions).toContain('Always start with `plan.read`')
  expect(report!.instructions).toContain('Advise first, and propose nothing yet')
  expect(report!.instructions).toContain('one `plan.propose` call')
})

test('the real bundle seeds report-structure beside the three document skills', async () => {
  const appDataDir = await tempRoot('real-seed')
  const registry = new SkillsRegistry({ appDataDir, bundledSkillsDir: resolve('resources/skills') })
  await registry.init()
  const listed = await registry.list()
  expect(listed.errors).toEqual([])
  expect(listed.skills.find((skill) => skill.name === 'report-structure')).toMatchObject({ input: 'folder', icon: 'list-ordered', title: 'Help with this report' })
  // Only the report skill carries a title; the document skills show their names.
  expect(listed.skills.filter((skill) => skill.title !== undefined).map((skill) => skill.name)).toEqual(['report-structure'])
  expect((await registry.get('report-structure')).skill?.title).toBe('Help with this report')
})

test('a SKILL.md title reaches the listing and the loaded skill; absent, none is invented', async () => {
  const paths = await fakeBundle()
  const registry = new SkillsRegistry(paths)
  await registry.init()
  const source = join(paths.appDataDir, 'skills', 'review', 'SKILL.md')
  await writeFile(source, (await readFile(source, 'utf8')).replace('name: review\n', 'name: review\ntitle: "  Notes on this draft  "\n'))
  const listed = await registry.list()
  expect(listed.errors).toEqual([])
  expect(listed.skills.find((skill) => skill.name === 'review')?.title).toBe('Notes on this draft')
  expect('title' in listed.skills.find((skill) => skill.name === 'copy-edit')!).toBe(false)
  expect((await registry.get('review')).skill?.title).toBe('Notes on this draft')
  expect((await registry.get('copy-edit')).skill?.title).toBeUndefined()
})

test('a seed failure does not throw and remains visible as a load error', async () => {
  const root = await tempRoot('seed-error')
  const registry = new SkillsRegistry({
    appDataDir: join(root, 'app-data'),
    bundledSkillsDir: join(root, 'missing-bundle'),
  })

  await expect(registry.init()).resolves.toBeUndefined()
  const result = await registry.list()
  expect(result.skills).toEqual([])
  expect(result.errors).toHaveLength(1)
  expect(result.errors[0].source).toBe(resolve(root, 'missing-bundle'))
  expect(result.errors[0].message).toMatch(/seed bundled skills/i)
})

test('bundle fixes flow to PRISTINE seeded copies; edited copies are sacred (OPEN-QUESTIONS #1 mechanism)', async () => {
  const { writeFile: wf, readFile: rf } = await import('node:fs/promises')
  const appData = await tempRoot('refresh-data')
  const bundledDir = await tempRoot('refresh-bundle')
  await writeSkill(bundledDir, 'copy-edit', skillMarkdown({
    name: 'copy-edit', description: 'Tightens prose. Never rewrites your voice.', icon: 'pen-line',
    tools: ['files.read', 'prose.edit'], body: 'Work carefully.',
  }))
  const registry = new SkillsRegistry({ appDataDir: appData, bundledSkillsDir: bundledDir })
  await registry.init()
  const seeded = join(appData, 'skills', 'copy-edit', 'SKILL.md')
  const bundledFile = join(bundledDir, 'copy-edit', 'SKILL.md')
  const original = await rf(bundledFile, 'utf8')

  // A bundle fix reaches the untouched copy on the next init.
  await wf(bundledFile, original.replace('Never rewrites your voice.', 'Never rewrites your voice, ever.'), 'utf8')
  await registry.init()
  expect(await rf(seeded, 'utf8')).toContain('Never rewrites your voice, ever.')

  // A USER-EDITED copy is never touched by later bundle changes.
  await wf(seeded, (await rf(seeded, 'utf8')) + '\nMy personal addition.\n', 'utf8')
  await wf(bundledFile, original.replace('Never rewrites your voice.', 'A third wording.'), 'utf8')
  await registry.init()
  const kept = await rf(seeded, 'utf8')
  expect(kept).toContain('My personal addition.')
  expect(kept).not.toContain('A third wording.')
})
