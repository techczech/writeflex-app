import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectGitVault } from '../../src/main/git-vault-discovery'

const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: 'pipe' }).toString().trim()
test('discovers nested vault and refuses missing remote, detached HEAD and interrupted operations without changing files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-git-discovery-')))
  try {
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Test Mac'); git(root, 'config', 'user.email', 'test@example.invalid')
    await mkdir(join(root, 'vault')); await writeFile(join(root, 'vault', 'draft.md'), 'Draft')
    git(root, 'add', 'vault'); git(root, 'commit', '-m', 'Initial')
    const vault = join(root, 'vault')
    expect((await inspectGitVault(vault)).state).toBe('no-remote')
    git(root, 'remote', 'add', 'origin', 'git@github.com:example/writing.git')
    const before = git(root, 'status', '--porcelain=v1')
    expect(await inspectGitVault(vault)).toMatchObject({ state: 'ready', root, vault, branch: 'main', remote: 'origin', host: 'github.com', repository: 'example/writing', prefix: 'vault/' })
    expect(git(root, 'status', '--porcelain=v1')).toBe(before)
    await writeFile(join(root, '.git', 'MERGE_HEAD'), git(root, 'rev-parse', 'HEAD'))
    expect((await inspectGitVault(vault)).state).toBe('operation-in-progress')
    await rm(join(root, '.git', 'MERGE_HEAD'))
    git(root, 'checkout', '--detach')
    expect((await inspectGitVault(vault)).state).toBe('detached')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('refuses unborn repositories and unavailable folders', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-git-discovery-')))
  try {
    git(root, 'init', '-b', 'main')
    git(root, 'remote', 'add', 'origin', 'https://example.invalid/team/writing.git')
    expect((await inspectGitVault(root)).state).toBe('unsupported')
    expect((await inspectGitVault(join(root, 'absent'))).state).toBe('unavailable')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('refuses ambiguous destinations and separate push URLs instead of guessing where writing goes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-git-discovery-')))
  try {
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Test Mac'); git(root, 'config', 'user.email', 'test@example.invalid')
    await writeFile(join(root, 'draft.md'), 'Draft')
    git(root, 'add', 'draft.md'); git(root, 'commit', '-m', 'Initial')
    git(root, 'remote', 'add', 'origin', 'https://example.invalid/team/writing.git')
    git(root, 'remote', 'add', 'elsewhere', 'https://example.invalid/team/other.git')
    expect((await inspectGitVault(root)).state).toBe('ambiguous-remote')
    git(root, 'config', 'branch.main.remote', 'origin')
    expect(await inspectGitVault(root)).toMatchObject({ state: 'ready', remote: 'origin', host: 'example.invalid', repository: 'team/writing' })
    git(root, 'remote', 'set-url', '--push', 'origin', 'https://example.invalid/team/different.git')
    expect((await inspectGitVault(root)).state).toBe('unsupported')
  } finally { await rm(root, { recursive: true, force: true }) }
})
