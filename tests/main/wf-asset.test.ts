import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolveWorkspaceAsset } from '../../src/main/wf-asset'

test('asset paths stay inside the workspace, including through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-asset-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'wf-asset-out-'))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets', 'ok.png'), 'ok')
  await writeFile(join(outside, 'secret.png'), 'no')
  await symlink(outside, join(root, 'escape'))
  expect(await resolveWorkspaceAsset(root, 'assets/ok.png')).toBe(await realpath(join(root, 'assets', 'ok.png')))
  expect(await resolveWorkspaceAsset(root, '../secret.png')).toBeNull()
  expect(await resolveWorkspaceAsset(root, 'escape/secret.png')).toBeNull()
})
