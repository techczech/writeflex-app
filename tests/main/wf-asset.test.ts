import { expect, test } from 'bun:test'
import { join, sep } from 'node:path'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { containWorkspacePath, resolveWorkspaceAsset } from '../../src/main/wf-asset'

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

// Use the URLs produced by the preview, including its legacy retry, at the protocol boundary.
import { widgetFor } from '../../src/renderer/src/editor/live-preview'
import { ImageWidget } from '../../src/renderer/src/editor/live-preview-widgets'

test('nested image URLs cannot read outside the workspace on either attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-asset-nested-'))
  const vault = join(root, 'vault')
  await mkdir(join(vault, 'chapters'), { recursive: true })
  await writeFile(join(root, 'outside.png'), 'outside')
  await symlink(root, join(vault, 'escape'))
  const realVault = await realpath(vault)
  for (const path of ['../../outside.png', '../escape/outside.png']) {
    const widget = widgetFor({ kind: 'image', from: 0, to: 1, source: '', url: path, alt: '' }, 'wf-asset://token', false, false, 'chapters/chapter.md') as ImageWidget
    for (const url of [widget.url, widget.fallbackUrl].filter((url): url is string => !!url)) {
      const relative = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
      // Whatever the URL parser does to the path, it may only ever land inside the vault.
      const contained = await containWorkspacePath(vault, relative)
      if (contained.ok) expect(contained.realPath.startsWith(realVault + sep)).toBe(true)
      expect(await resolveWorkspaceAsset(vault, relative)).toBeNull()
    }
  }
  // The outside file exists, so these are refused for containment, not because nothing is there.
  expect(await containWorkspacePath(vault, '../outside.png')).toEqual({ ok: false, reason: 'outside' })
  expect(await containWorkspacePath(vault, 'escape/outside.png')).toEqual({ ok: false, reason: 'outside' })
})
