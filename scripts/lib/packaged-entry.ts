// Static preflight of a packaged app's entry, so a broken entry is never launched (Electron would
// show its own dialog for it). Reads app.asar only; launches nothing.
import { transformSync } from 'esbuild'
import { builtinModules, createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { findSpecifiers, stripComments } from '../check-packaged-imports'

interface AsarModule {
  extractFile(archive: string, file: string): Buffer
  listPackage(archive: string, options?: object): string[]
}

function loadAsar(): AsarModule {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
  return builderRequire('@electron/asar') as AsarModule
}

const ELECTRON_ALLOWED_NAMES = new Set(['app', 'crashReporter', 'dialog'])
const STATIC_IMPORT = /\bimport\s*(?:([\w$]+)\s*,?\s*)?(?:\*\s*as\s+([\w$]+)|\{([^}]*)\})?\s*from\s*["']([^"']+)["']/gu
const ALLOWED_DYNAMIC_IMPORT = /import\(\s*new URL\(\s*["']\.\/index\.js["']\s*,\s*import\.meta\.url\s*\)\.href\s*\)/gu

/**
 * The bootstrap may import only named `app`/`crashReporter`/`dialog` from electron, node: built-ins
 * (each named import must exist on the ESM namespace) and dynamically `./index.js`. Anything else
 * (a chunk, a bare side-effect import) could fail to link before our handlers exist.
 * Returns the violations (empty when fine).
 */
export async function bootstrapImportViolations(source: string): Promise<string[]> {
  const code = stripComments(source, 'esm')
  const violations: string[] = []
  const handled = new Set<string>()
  for (const match of code.matchAll(STATIC_IMPORT)) {
    const [, defaultName, namespaceName, namedList, specifier] = match as unknown as [string, string | undefined, string | undefined, string | undefined, string]
    handled.add(specifier)
    const names = (namedList ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/u)[0]!).filter(Boolean)
    if (specifier === 'electron') {
      if (defaultName || namespaceName) violations.push('bootstrap uses a default or namespace import of "electron"')
      for (const name of names) if (!ELECTRON_ALLOWED_NAMES.has(name)) violations.push(`bootstrap imports unknown Electron export "${name}"`)
    } else if (specifier.startsWith('node:')) {
      if (!builtinModules.includes(specifier) && !builtinModules.includes(specifier.slice(5))) {
        violations.push(`bootstrap imports unknown built-in "${specifier}"`)
        continue
      }
      let namespace: Record<string, unknown>
      try { namespace = await import(specifier) as Record<string, unknown> } catch {
        violations.push(`bootstrap imports unloadable built-in "${specifier}"`)
        continue
      }
      // Own keys of the ESM namespace are exactly the link-time export names: inherited ones
      // (constructor, toString) are rejected.
      for (const name of names) if (!Object.hasOwn(namespace, name)) violations.push(`"${specifier}" has no export "${name}"`)
    } else {
      violations.push(`bootstrap imports "${specifier}"`)
    }
  }
  for (const specifier of findSpecifiers(code)) {
    if (!handled.has(specifier)) violations.push(`bootstrap imports "${specifier}" (unrecognised form)`)
  }
  if (/\brequire\s*\(/u.test(code)) violations.push('bootstrap calls require()')
  if (/\bimport\s*\(/u.test(code.replace(ALLOWED_DYNAMIC_IMPORT, ''))) violations.push('bootstrap has a dynamic import other than ./index.js')
  return violations
}

/** Returns an error sentence, or null when the packaged entry looks loadable. */
export async function checkPackagedEntry(appPath: string, asar: AsarModule = loadAsar()): Promise<string | null> {
  try {
    const archive = join(resolve(appPath), 'Contents/Resources/app.asar')
    const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')) as {
      main?: string
      dependencies?: Record<string, string>
    }
    if (!manifest.main) return 'package.json in app.asar has no main'
    const entry = manifest.main.replace(/^\.\//u, '')
    const source = asar.extractFile(archive, entry).toString('utf8')
    transformSync(source, { format: 'esm' }) // throws on a syntax error
    const violations = await bootstrapImportViolations(source)
    if (violations.length > 0) return `packaged entry has unexpected imports: ${violations.join('; ')}`
    // Every file:-linked dependency is shipped as a copy under node_modules; it must be in the asar.
    const listed = new Set(asar.listPackage(archive).map((path) => path.replace(/^[\\/]/u, '').replaceAll('\\', '/')))
    const missing = Object.entries(manifest.dependencies ?? {})
      .filter(([, spec]) => spec.startsWith('file:'))
      .map(([name]) => name)
      .filter((name) => !listed.has(`node_modules/${name}/package.json`))
    if (missing.length > 0) return `file: dependencies missing from app.asar: ${missing.join(', ')}`
    return null
  } catch (error) {
    return `packaged entry check failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
