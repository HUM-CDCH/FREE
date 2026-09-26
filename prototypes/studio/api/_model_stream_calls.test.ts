import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every `streamText` / `streamObject` call from `ai` in `source` whose options do not name `onError` inline (Ruling 5):
 * the SDK's default handler logs provider bodies and `Bearer <key>` runtime messages. Calls are resolved through the
 * file's imports, aliases included, so a same-named local function does not count and an alias does; an `onError`
 * anywhere else in the file excuses nothing, and options passed as a variable count as unhandled, since the scan
 * cannot see into them.
 */
function unhandledStreamCalls(source: string, fileName = 'scanned.ts'): number {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const streamNames = new Set(['streamText', 'streamObject'])
  const named = new Set<string>()        // local names bound to ai's stream functions
  const namespaces = new Set<string>()   // local names of `import * as x from 'ai'`
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== 'ai') continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings) continue
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    else for (const element of bindings.elements) {
      if (streamNames.has((element.propertyName ?? element.name).text)) named.add(element.name.text)
    }
  }
  const isStreamCall = (callee: ts.Expression) =>
    (ts.isIdentifier(callee) && named.has(callee.text))
    || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      && namespaces.has(callee.expression.text) && streamNames.has(callee.name.text))
  const handled = (options: ts.Expression | undefined) =>
    options !== undefined && ts.isObjectLiteralExpression(options)
    && options.properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === 'onError')
  let unhandled = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isStreamCall(node.expression) && !handled(node.arguments[0])) unhandled += 1
    ts.forEachChild(node, visit)
  }
  visit(file)
  return unhandled
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('the stream-call scan', () => {
  const AI = "import { streamText, streamObject } from 'ai'\n"

  it('counts a call without onError and passes one whose own options name it', () => {
    expect(unhandledStreamCalls(`${AI}const r = streamText({ model })`)).toBe(1)
    expect(unhandledStreamCalls(`${AI}const r = streamObject({ model, onError: log })`)).toBe(0)
  })

  it('an onError elsewhere in the file excuses nothing', () => {
    expect(unhandledStreamCalls(`${AI}const options = { onError: safe }\nstreamText({ model })`)).toBe(1)
    expect(unhandledStreamCalls(`${AI}streamText({ model, onError: log })\nstreamObject({ model })`)).toBe(1)
  })

  it('options passed as a variable count as unhandled', () => {
    expect(unhandledStreamCalls(`${AI}const options = { model, onError: safe }\nstreamText(options)`)).toBe(1)
  })

  it('whitespace, aliases and namespace imports are still calls; a same-named local function is not', () => {
    expect(unhandledStreamCalls(`${AI}streamText ({ model })`)).toBe(1)
    expect(unhandledStreamCalls("import { streamText as stream } from 'ai'\nstream({ model })")).toBe(1)
    expect(unhandledStreamCalls("import * as ai from 'ai'\nai.streamText({ model })")).toBe(1)
    expect(unhandledStreamCalls("function streamText(o: unknown) { return o }\nstreamText({ model })")).toBe(0)
    expect(unhandledStreamCalls("import { streamText } from './local.js'\nstreamText({ model })")).toBe(0)
  })

  it('the directory walk includes nested files', () => {
    const files = sourceFiles(join(import.meta.dirname, '..', 'test'))
    expect(files.some((path) => path.includes(`${join('test', 'support')}/`))).toBe(true)
  })
})

it('every streamText and streamObject call in server code passes an explicit onError', () => {
  for (const directory of ['api', 'server']) {
    for (const file of sourceFiles(join(import.meta.dirname, '..', directory))) {
      expect({ file, unhandled: unhandledStreamCalls(readFileSync(file, 'utf8'), file) }).toEqual({ file, unhandled: 0 })
    }
  }
})
