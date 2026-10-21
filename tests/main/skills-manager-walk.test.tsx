import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkillsRegistry } from '../../src/main/skills'
import { resolveWorkspaceRoot } from '../../src/main/root-resolution'
import { SkillProvenanceBelt, activeSkillForPath, filterSkills } from '../../src/renderer/src/components/SkillsManager'

// The logic of tests/e2e/skills-manager.spec.ts without Electron, on the real bundled skills seeded into a
// real temporary user-data folder. The three doors that open the manager and the second window are the
// app's; what the hand-edit opens, and what that window then says about it, is decided here.
let userData: string
let registry: SkillsRegistry
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'wf-skills-manager-'))
  registry = new SkillsRegistry({ appDataDir: userData, bundledSkillsDir: resolve('resources/skills') })
  await registry.init()
})
afterEach(() => rm(userData, { recursive: true, force: true }))

test('the manager\'s filter: "reviewer" keeps Review and drops Copy-edit; clearing it brings every skill back', async () => {
  const { skills } = await registry.list()
  expect(filterSkills(skills, 'reviewer').map((skill) => skill.name)).toEqual(['review'])
  expect(filterSkills(skills, 'reviewer').some((skill) => skill.name === 'copy-edit')).toBe(false)
  expect(filterSkills(skills, '').map((skill) => skill.name).sort()).toEqual(['clean-up', 'copy-edit', 'report-structure', 'review'])
})

test('Edit by hand opens the registered SKILL.md and marks the skills folder as its workspace; the new window\'s belt names the skill', async () => {
  const target = await registry.resolveOpenForEditing('copy-edit')

  // The folder is promoted to a Bridle workspace (the .bridle marker) and is what the file's window binds to.
  expect(target.root).toBe(join(userData, 'skills'))
  expect(existsSync(join(target.root, '.bridle'))).toBe(true)
  expect(target.source).toBe(join(userData, 'skills', 'copy-edit', 'SKILL.md'))
  expect(resolveWorkspaceRoot(target.source, { home: userData })).toBe(target.root)

  // The file opened is the skill's own text.
  expect(await readFile(target.source, 'utf8')).toContain('Work sentence by sentence')

  // The window finds the skill from that file, and the belt says so with the source tail.
  const { skills } = await registry.list()
  const active = activeSkillForPath(skills, target.root, 'copy-edit/SKILL.md')
  expect(active?.name).toBe('copy-edit')
  const belt = renderToStaticMarkup(<SkillProvenanceBelt skill={active} />)
  expect(belt).toContain('This file defines the <strong>Copy-edit</strong> skill')
  expect(belt).toContain('skills/copy-edit/SKILL.md')
})

test('an ordinary document in a window has no belt', async () => {
  const { skills } = await registry.list()
  expect(activeSkillForPath(skills, join(userData, 'notes'), 'metaphors.md')).toBeNull()
  expect(renderToStaticMarkup(<SkillProvenanceBelt skill={null} />)).toBe('')
})
