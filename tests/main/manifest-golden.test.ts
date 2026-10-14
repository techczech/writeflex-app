import { expect, test } from 'bun:test'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import golden from './fixtures/writeflex-manifest-golden.json'

// Captured from the original manifest before refactoring. Function bodies are exercised by
// capabilities.test.ts; the golden preserves their presence and all declarative fields.
const normalise = (manifest: ReturnType<typeof buildWriteFlexManifest>) => JSON.parse(JSON.stringify({
  ...manifest,
  capabilities: [...manifest.capabilities].sort((a, b) => a.name.localeCompare(b.name)),
}, (_key, value) => typeof value === 'function' ? '[function]' : value))

test('manifest matches the pre-registry golden, with and without Scraps', () => {
  const workspace = new Workspace('/tmp/writeflex-golden')
  expect(normalise(buildWriteFlexManifest(workspace))).toEqual(golden.withoutScraps)
  expect(normalise(buildWriteFlexManifest(workspace, undefined, { scraps: new ScrapStore(workspace) }))).toEqual(golden.withScraps)
  const enabled = (name: string) => name === 'files.read' || name === 'scraps.add'
  expect(normalise(buildWriteFlexManifest(workspace, enabled, { scraps: new ScrapStore(workspace) }))).toEqual({
    ...golden.withScraps, capabilities: golden.withScraps.capabilities.filter((c) => enabled(c.name)),
  })
})
