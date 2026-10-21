import { expect, test } from 'bun:test'
import { defaultExportScope } from '../../src/renderer/src/components/ExportSheet'
import { exportPlaceFor, type ExportDirApi } from '../../src/renderer/src/app/export-collection-dir'

// Defect 026: a part of a Folio opened the Export sheet on "This piece", so the export wrote only the open file.
test('a part of a Folio opens on the whole collection', () => {
  expect(defaultExportScope({ hasCollection: true, inFolio: true })).toBe('collection')
})
test('a plain Collection keeps the piece default', () => {
  expect(defaultExportScope({ hasCollection: true, inFolio: false })).toBe('piece')
})
test('a file in no collection keeps the piece default', () => {
  expect(defaultExportScope({ hasCollection: false, inFolio: false })).toBe('piece')
  expect(defaultExportScope({ hasCollection: false, inFolio: true })).toBe('piece')
})

function api(folios: Record<string, string | null>, collections: Record<string, string>, manifests: string[]): ExportDirApi {
  return {
    folioDirOf: async (path) => folios[path] ?? null,
    hasManifest: async (dir) => manifests.includes(dir),
    collectionDirFor: async (path) => collections[path] ?? path.slice(0, path.lastIndexOf('/')),
  }
}
test('exportPlaceFor marks a manifest Folio part as inFolio and its folder as the bundle', async () => {
  const place = await exportPlaceFor('report/contents/01.md', api({ 'report/contents/01.md': 'report' }, {}, ['report']))
  expect(place).toEqual({ dir: 'report', inFolio: true })
})
test('exportPlaceFor marks a plain Collection as not inFolio', async () => {
  const place = await exportPlaceFor('notes/a.md', api({}, { 'notes/a.md': 'notes' }, []))
  expect(place).toEqual({ dir: 'notes', inFolio: false })
})
test('exportPlaceFor marks a loose file as not inFolio', async () => {
  const place = await exportPlaceFor('loose/a.md', api({}, { 'loose/a.md': 'loose' }, []))
  expect(place).toEqual({ dir: 'loose', inFolio: false })
})
