#!/usr/bin/env node
// The separate-publish step (contract: agent-skill.md, "Available separately"): copies the app's packaged
// skill, plus PROVENANCE.md (app, version, commit), into a target folder passed as the argument. The skill is
// the same content and the same version as the app's. It runs no publish tooling and touches no skills repo
// by itself: the release step points it at a copy of the skills repo's folder and publishes from there.
//
//   bun scripts/publish-agent-skill.mjs <target-folder>
//
// Replaces SKILL.md, references/ and PROVENANCE.md in the target; leaves every other file there alone.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAgentSkill } from './build-agent-skill.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function provenance({ version, commit, date }) {
  return [
    '# Provenance', '',
    'Generated copy of the skill that ships inside the app. Do not edit it here; change it in the app\'s repository.', '',
    '- App: WriteFlex',
    `- App version: ${version}`,
    `- Commit: ${commit}`,
    `- Generated: ${date}`, ''
  ].join('\n')
}

export async function publishAgentSkill(target) {
  if (!target) throw new Error('Usage: bun scripts/publish-agent-skill.mjs <target-folder>')
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  let commit = 'unknown'
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch { /* not a checkout */ }
  const staging = join(tmpdir(), `writeflex-skill-${process.pid}`)
  try {
    const built = await buildAgentSkill({ outDir: staging, version })
    const dest = resolve(target)
    mkdirSync(dest, { recursive: true })
    rmSync(join(dest, 'references'), { recursive: true, force: true })
    for (const entry of readdirSync(built)) cpSync(join(built, entry), join(dest, entry), { recursive: true })
    writeFileSync(join(dest, 'PROVENANCE.md'), provenance({ version, commit, date: new Date().toISOString().slice(0, 10) }))
    return { dest, version, commit }
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await publishAgentSkill(process.argv[2])
  console.log(`published ${r.version} (${r.commit.slice(0, 8)}) to ${r.dest}`)
}
