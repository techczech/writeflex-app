import { expect, test } from 'bun:test'
import ts from 'typescript'
import { resolve } from 'node:path'
import { METADATA_REGISTRY } from '../../src/shared/metadata-registry'

// Use the compiler's types so aliases of Frontmatter and its extra map are included,
// while unrelated objects named metadata/extra do not become false positives.
test('every statically named frontmatter key read in src is registered', () => {
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const files = program.getSourceFiles().filter(file => file.fileName.startsWith(resolve('src') + '/') && !file.isDeclarationFile)
  const aliases = new Set<ts.Symbol>()
  const frontmatter = (node: ts.Node): boolean => {
    const type = checker.getTypeAtLocation(node)
    return (type.isUnion() ? type.types : [type]).some(t => t.getSymbol()?.name === 'Frontmatter' || (!!t.getProperty('extra') && (!!t.getProperty('author') || !!t.getProperty('title'))))
  }
  const extraMap = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node)) return extraMap(node.expression)
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return extraMap(node.left)
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'extra' && frontmatter(node.expression)) return true
    return ts.isIdentifier(node) && !!checker.getSymbolAtLocation(node) && aliases.has(checker.getSymbolAtLocation(node)!)
  }
  const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => { visit(node); ts.forEachChild(node, child => walk(child, visit)) }
  for (const file of files) walk(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && extraMap(node.initializer)) {
      const symbol = checker.getSymbolAtLocation(node.name); if (symbol) aliases.add(symbol)
    }
  })
  const hits = new Map<string, string[]>()
  for (const file of files) walk(file, node => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return
    if (!frontmatter(node.expression) && !extraMap(node.expression)) return
    // Assignment targets populate the parser shape; they are not key reads.
    if (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return
    const type = ts.isElementAccessExpression(node) ? checker.getTypeAtLocation(node.argumentExpression) : null
    const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : (type?.isUnion() ? type.types : type ? [type] : []).flatMap(t => t.isStringLiteral() ? [t.value] : [])
    for (const key of keys) {
      // extra is the parser container; _raw is parser diagnostics, never a disk key.
      if (key === 'extra' || key === '_raw') continue
      const diskKey = key === 'seriesOrder' ? 'series-order' : key
      const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
      hits.set(diskKey, [...hits.get(diskKey) ?? [], `${file.fileName}:${line}`])
    }
  })
  const registered = new Set(METADATA_REGISTRY.map(field => field.key))
  expect([...hits].filter(([key]) => !registered.has(key))).toEqual([])
  // Ensure the scan covers the previously missed direct, aliased and constant-key reads.
  for (const key of ['pattern', 'diary', 'heading', 'authors', 'year', 'published', 'toc_depth', 'sources']) expect(hits.has(key), key).toBe(true)
}, 30_000)
