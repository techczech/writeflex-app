// Release gate for the separate publication of the agent skill (contract: agent-skill.md, "Available
// separately"). Compares the public copy in the skills repository with the skill built from this release:
// every file of the built skill (SKILL.md and references/) must be published with the same SHA-256, and
// SKILL.md's `metadata.app-version` must equal the release version. PROVENANCE.md exists only in the public
// copy and is ignored. It publishes nothing and runs no publish tooling: when it fails, run the publish step
// (scripts/publish-agent-skill.mjs into a copy of the skills repository, then publish from there) and release again.
//
//   bun scripts/check-published-skill.mjs [--skill <built skill folder>] [--version <x.y.z>]
//
// With no --skill the skill is built into a temporary folder from this checkout. The public copy sits at
// <category>/<skill>/ in the repository named by the skill's publish.yaml (techczech/dominiks-agent-skills,
// category `writing`, skill `writeflex`).
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAgentSkill } from './build-agent-skill.mjs'
import { readSkillMetadata } from '../src/main/agent-skill/skill-source.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const PUBLISHED = { repo: 'techczech/dominiks-agent-skills', branch: 'main', dir: 'writing/writeflex' }
export const publishedUrl = (rel = 'SKILL.md', p = PUBLISHED) => `https://raw.githubusercontent.com/${p.repo}/${p.branch}/${p.dir}/${rel}`

const sha = (b) => createHash('sha256').update(b).digest('hex')

/** Every file under `dir` as Map<posix relative path, Buffer>. */
export function readSkillFiles(dir) {
  const out = new Map()
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const abs = join(e.parentPath ?? e.path, e.name)
    out.set(relative(dir, abs).split(sep).join('/'), readFileSync(abs))
  }
  return out
}

/**
 * Resolves with the published version, or rejects with a message that names what is missing or different
 * and what to do. `files` is the built skill (Map of path to bytes); `fetchBytes(url)` returns the body or
 * throws; it is a seam for tests.
 */
export async function checkPublishedSkill({ version, files, urlFor = publishedUrl, fetchBytes = defaultFetch }) {
  const fix = 'Run the publish step first (bun run publish:agent-skill into a copy of the skills repository, then publish from there), then release again.'
  const built = new Map([...files].filter(([rel]) => rel !== 'PROVENANCE.md'))
  if (!built.has('SKILL.md')) throw new Error('The built agent skill has no SKILL.md, so there is nothing to compare.')
  let skillBody
  try { skillBody = await fetchBytes(urlFor('SKILL.md')) } catch (e) {
    throw new Error(`The published agent skill could not be fetched from ${urlFor('SKILL.md')} (${e instanceof Error ? e.message : e}). ${fix}`)
  }
  const meta = readSkillMetadata(skillBody.toString('utf8'))
  if (meta.app !== 'writeflex') throw new Error(`The file at ${urlFor('SKILL.md')} is not the WriteFlex agent skill (metadata.app is ${meta.app ?? 'missing'}). ${fix}`)
  if (!meta.version) throw new Error(`The published agent skill carries no metadata.app-version. ${fix}`)
  if (meta.version !== version) throw new Error(`The published agent skill is version ${meta.version}, but this release is ${version}. ${fix}`)
  const problems = []
  for (const [rel, bytes] of [...built].sort(([a], [b]) => a.localeCompare(b))) {
    let published
    try { published = rel === 'SKILL.md' ? skillBody : await fetchBytes(urlFor(rel)) } catch { problems.push(`${rel}: missing from the published copy`); continue }
    if (sha(published) !== sha(bytes)) problems.push(`${rel}: differs from the published copy`)
  }
  if (problems.length) throw new Error(`The published agent skill does not match this release's skill:\n  ${problems.join('\n  ')}\n${fix}`)
  return meta.version
}

async function defaultFetch(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'writeflex-release-check' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
  const version = arg('--version') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  let scratch = null
  try {
    let dir = arg('--skill')
    if (!dir) { scratch = mkdtempSync(join(tmpdir(), 'writeflex-skill-check-')); dir = await buildAgentSkill({ outDir: scratch, version }) }
    console.log(`published agent skill is version ${await checkPublishedSkill({ version, files: readSkillFiles(dir) })}: every file matches this release`)
  } catch (e) {
    console.error(`::error::${e.message}`)
    process.exitCode = 1
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }) }
}
