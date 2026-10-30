import { expect, test } from 'bun:test'
import { bootstrapImportViolations, checkPackagedEntry } from '../../scripts/lib/packaged-entry'
import { checkSources, classifySpecifier, findSpecifiers, stripComments } from '../../scripts/check-packaged-imports'
import { gateCipherForSmoke } from '../../src/main/secrets-store'

const manifest = {
  dependencies: { '@readflex/sidecar': 'file:../x', docx: '9.7.1' },
  devDependencies: { vite: '^6' },
}

test('static import check: shipped, builtin and electron imports pass', () => {
  expect(checkSources([{ file: 'a.js', source: 'import {app} from "electron"; import fs from "node:fs"; import d from "docx/x"; import "./b.js"' }], manifest)).toEqual([])
})

test('static import check: undeclared, dev-only, absolute, file: and missing file-dependency imports fail', () => {
  const sources = [{ file: 'a.js', source: 'import a from "left-pad"; import b from "vite"; import c from "/abs/x.js"; import d from "file:///x.js"; import e from "@readflex/sidecar"' }]
  const problems = checkSources(sources, manifest, () => false)
  expect(problems.map((problem) => problem.specifier).sort()).toEqual(['/abs/x.js', '@readflex/sidecar', 'file:///x.js', 'left-pad', 'vite'])
  expect(classifySpecifier('@readflex/sidecar', manifest, () => true)).toBeNull()
})

test('static import check ignores specifiers in comments', () => {
  expect(checkSources([{ file: 'a.js', source: '// import x from "left-pad"\n/* require("nope") */\nexport const a = 1' }], manifest)).toEqual([])
  expect(stripComments('// import x from "left-pad"\nexport const a = 1', 'esm')).not.toContain('left-pad')
})

function fakeAsar(files: Record<string, string>) {
  return {
    extractFile: (_archive: string, file: string) => {
      if (!(file in files)) throw new Error(`${file} not found in archive`)
      return Buffer.from(files[file]!)
    },
    listPackage: () => Object.keys(files).map((file) => `/${file}`),
  }
}
const goodManifest = JSON.stringify({ main: './out/main/bootstrap.js', dependencies: { '@readflex/sidecar': 'file:../x' } })

test('entry preflight: a good entry passes', async () => {
  expect(await checkPackagedEntry('/x/WriteFlex.app', fakeAsar({
    'package.json': goodManifest, 'out/main/bootstrap.js': VALID, 'node_modules/@readflex/sidecar/package.json': '{}',
  }))).toBeNull()
})

test('entry preflight: missing entry, syntax error and unshipped file: dependency refuse', async () => {
  expect(await checkPackagedEntry('/x/WriteFlex.app', fakeAsar({ 'package.json': goodManifest }))).toContain('not found')
  expect(await checkPackagedEntry('/x/WriteFlex.app', fakeAsar({ 'package.json': goodManifest, 'out/main/bootstrap.js': 'import {' }))).toContain('failed')
  expect(await checkPackagedEntry('/x/WriteFlex.app', fakeAsar({ 'package.json': goodManifest, 'out/main/bootstrap.js': VALID }))).toContain('@readflex/sidecar')
})

test('smoke mode never touches safeStorage: the gated cipher says unavailable', () => {
  const touched: string[] = []
  const gated = gateCipherForSmoke(() => { touched.push('safeStorage'); throw new Error('must not be reached') }, true)
  expect(gated.isEncryptionAvailable()).toBe(false)
  expect(() => gated.encryptString('x')).toThrow()
  expect(() => gated.decryptString(Buffer.from('x'))).toThrow()
  expect(touched).toEqual([])
})

test('outside smoke mode the cipher passes through to safeStorage', () => {
  const gated = gateCipherForSmoke(() => ({ isEncryptionAvailable: () => true, encryptString: () => Buffer.from('e'), decryptString: () => 'd' }), false)
  expect(gated.isEncryptionAvailable()).toBe(true)
})

const VALID = 'import { writeSync } from "node:fs";\nimport { app, crashReporter, dialog } from "electron";\n// import x from "./chunks/c.js"\nawait import(new URL("./index.js", import.meta.url).href);'

test('bootstrap import contract: the valid entry passes', async () => {
  expect(await bootstrapImportViolations(VALID)).toEqual([])
})

test('bootstrap import contract: bad built-ins and names are rejected', async () => {
  expect((await bootstrapImportViolations('import { x } from "node:does-not-exist"')).join()).toContain('unknown built-in')
  expect((await bootstrapImportViolations('import { nope } from "node:fs"')).join()).toContain('no export "nope"')
  expect((await bootstrapImportViolations('import { constructor } from "node:fs"')).join()).toContain('no export "constructor"')
  expect((await bootstrapImportViolations('import { toString } from "node:fs"')).join()).toContain('no export "toString"')
})

test('bootstrap import contract: electron, chunk, side-effect and extra dynamic imports are rejected', async () => {
  expect((await bootstrapImportViolations('import { shell } from "electron"')).join()).toContain('unknown Electron export "shell"')
  expect((await bootstrapImportViolations('import electron from "electron"')).join()).toContain('default or namespace')
  expect((await bootstrapImportViolations('import * as e from "electron"')).join()).toContain('default or namespace')
  expect((await bootstrapImportViolations('import { a } from "./chunks/x.js"')).join()).toContain('./chunks/x.js')
  expect((await bootstrapImportViolations('import "./side.js"')).join()).toContain('./side.js')
  expect((await bootstrapImportViolations('await import("./other.js")')).join()).toContain('dynamic import')
})


test('static import check ignores import syntax inside strings and retains real static and dynamic imports', () => {
  const source = `const event = "scratchpad:external-import"; const message = 'require("ghost")';
    const widget = \`import bad from "ghost-widget"\`;
    import real from "docx"; export { thing } from "actual-export";
    await import("actual-dynamic"); require("actual-require");`
  expect(findSpecifiers(source).sort()).toEqual(['actual-dynamic', 'actual-export', 'actual-require', 'docx'])
  expect(checkSources([{ file: 'minified.js', source }], manifest).map((p) => p.specifier).sort())
    .toEqual(['actual-dynamic', 'actual-export', 'actual-require'])
})
