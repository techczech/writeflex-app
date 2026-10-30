// Fails the build when out/main or out/preload import something the packaged app cannot resolve.
// WriteFlex externalizes every dependency (externalizeDepsPlugin) and electron-builder ships the
// `dependencies` of package.json, including file:-linked ones (@readflex/*, @bridle/*), as copies
// under node_modules in the asar. So a bare import is fine iff it names a declared dependency
// (not a devDependency) and, for a file: dependency, its node_modules copy exists. Absolute and
// URL specifiers (file:, https:, /abs) are never fine. Syntax is parsed with TypeScript. Computed
// requires cannot be resolved statically; the packaged launch smoke covers those.
import { transformSync } from 'esbuild'
import ts from 'typescript'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'

export interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')))

function isAbsoluteOrUrl(specifier: string): boolean {
  return specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(specifier)
}

export function stripComments(source: string, format: 'esm' | 'cjs'): string {
  try {
    return transformSync(source, { format, minifyWhitespace: true, legalComments: 'none' }).code
  } catch {
    return source
  }
}

export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return null
  if (isAbsoluteOrUrl(specifier)) return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  if (NODE_BUILTINS.has(name)) return null
  return name
}

export function findSpecifiers(source: string): string[] {
  const parsed = ts.createSourceFile('bundle.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) throw new Error(`Cannot inspect packaged imports: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, ' ')}`)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.add(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    ) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.add(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return [...found]
}

export interface ImportProblem { file: string; specifier: string; reason: string }

export function classifySpecifier(specifier: string, manifest: Manifest, copyExists: (name: string) => boolean = () => true): string | null {
  if (specifier.startsWith('node:')) return null
  if (isAbsoluteOrUrl(specifier)) return `"${specifier}" is an absolute path or URL import; the packaged app cannot rely on it`
  const name = packageNameOf(specifier)
  if (name === null || name === 'electron') return null
  const spec = manifest.dependencies?.[name]
  if (spec === undefined) {
    return manifest.devDependencies?.[name] !== undefined
      ? `"${name}" is only a devDependency, which electron-builder does not ship`
      : `"${name}" is not a runtime dependency in package.json, so the packaged app cannot resolve it`
  }
  if (spec.startsWith('workspace:')) return `workspace package "${name}" is not shipped; it must be bundled`
  if (spec.startsWith('file:') && !copyExists(name)) return `file: dependency "${name}" has no copy in node_modules, so electron-builder cannot ship it`
  return null
}

export function checkSources(
  sources: ReadonlyArray<{ file: string; source: string }>,
  manifest: Manifest,
  copyExists?: (name: string) => boolean,
): ImportProblem[] {
  const problems: ImportProblem[] = []
  for (const { file, source } of sources) {
    for (const specifier of findSpecifiers(source)) {
      const reason = classifySpecifier(specifier, manifest, copyExists)
      if (reason) problems.push({ file, specifier, reason })
    }
  }
  return problems
}

function bundleFiles(root: string): Array<{ file: string; source: string }> {
  const files: Array<{ file: string; source: string }> = []
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(?:c|m)?js$/u.test(entry.name)) files.push({ file: path, source: readFileSync(path, 'utf8') })
    }
  }
  for (const directory of ['main', 'preload']) walk(join(root, directory))
  return files
}

if (import.meta.main) {
  const repo = resolve(import.meta.dir, '..')
  const outputRoot = resolve(process.argv[2] ?? join(repo, 'out'))
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Manifest
  const files = bundleFiles(outputRoot)
  if (files.length === 0) { console.error(`check-packaged-imports: no bundle files in ${outputRoot}`); process.exit(1) }
  const problems = checkSources(files, manifest, (name) => existsSync(join(repo, 'node_modules', name, 'package.json')))
  if (problems.length > 0) {
    console.error('check-packaged-imports: the packaged app would fail to start:')
    for (const problem of problems) console.error(`  ${problem.file}: import "${problem.specifier}": ${problem.reason}`)
    process.exit(1)
  }
  console.log(`check-packaged-imports: ${files.length} bundle files in ${outputRoot} import only shipped packages.`)
}
