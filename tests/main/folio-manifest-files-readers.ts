// The anti-regression scan behind spec-folio-room-data-model § 1 D-FILES-2 (c) and § 22: every read of a parsed
// Folio manifest's `files` (the `Folio` type of src/main/folio.ts, found by the compiler's types, so unrelated
// `files` fields and raw JSON never match) is reported with the chain of named declarations it sits in
// (`assessManifestOnly/sameEntries`). The test file judges the reports against an allow-list of functions.
import ts from 'typescript'
import { resolve } from 'node:path'

export type FilesReader = { file: string; chain: string; line: number }

const FOLIO_SOURCE = resolve('src/main/folio.ts')

/** The named declarations around `node`, outermost first. */
function chainOf(node: ts.Node): string {
  const names: string[] = []
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isClassDeclaration(at) || ts.isVariableDeclaration(at) || ts.isPropertyAssignment(at)) && at.name && (ts.isIdentifier(at.name) || ts.isStringLiteral(at.name))) {
      names.unshift(at.name.text)
    }
  }
  return names.join('/') || '(top level)'
}

/** The `files` property of the `Folio` type alias itself (a `Pick` or narrowing keeps this declaration). */
function isFolioFilesSymbol(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((declaration) => (
    declaration.getSourceFile().fileName === FOLIO_SOURCE
    && ts.isPropertySignature(declaration)
    && ts.isTypeLiteralNode(declaration.parent)
    && ts.isTypeAliasDeclaration(declaration.parent.parent)
    && declaration.parent.parent.name.text === 'Folio'
  ))
}

/** Every read of a parsed Folio's `files` in `files` (absolute paths) of `program`, with the declarations it sits in. */
export function folioFilesReaders(program: ts.Program, files: readonly string[]): FilesReader[] {
  const checker = program.getTypeChecker()
  const found: FilesReader[] = []
  for (const fileName of files) {
    const source = program.getSourceFile(fileName)
    if (!source) throw new Error(`Not in the program: ${fileName}`)
    const visit = (node: ts.Node): void => {
      let hit = false
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'files') hit = isFolioFilesSymbol(checker.getSymbolAtLocation(node.name))
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'files') {
        hit = isFolioFilesSymbol(checker.getTypeAtLocation(node.expression).getProperty('files'))
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name
        if (ts.isIdentifier(key) && key.text === 'files') hit = isFolioFilesSymbol(checker.getTypeAtLocation(node.parent).getProperty('files'))
      }
      if (hit) found.push({ file: fileName, chain: chainOf(node), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

/** The repository's own program (tsconfig.json), and its non-test sources under src/main. */
export function mainProgram(): { program: ts.Program; files: string[] } {
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const main = resolve('src/main') + '/'
  const files = program.getSourceFiles().map((file) => file.fileName).filter((name) => name.startsWith(main) && !name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(name))
  return { program, files }
}

/** A program over `roots` in which each file of `planted` reads as the given text instead of what is on disk. */
export function plantedProgram(roots: readonly string[], planted: ReadonlyMap<string, string>): ts.Program {
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const host = ts.createCompilerHost(parsed.options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = planted.get(resolve(fileName))
    return text === undefined ? original(fileName, languageVersion, onError, shouldCreate) : ts.createSourceFile(fileName, text, languageVersion, true)
  }
  return ts.createProgram([...roots], parsed.options, host)
}
