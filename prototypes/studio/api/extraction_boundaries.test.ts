import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name))
    : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
/** Every module a source file asks for: static and re-exported (`… from`), side-effect (`import '…'`) and dynamic. */
function specifiers(source: string): string[] {
  const forms = /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g
  return [...source.matchAll(forms)].map((match) => match[1]!)
}
const research = (specifier: string) => /experiments\/extraction|docs\/validation/.test(specifier)
/** The pure parts of the extraction package a browser may load; the runtime (its root, workflows, batch, kei) is not. */
const BROWSER_EXTRACTION = new Set(['extraction/allowed-values', 'extraction/extraction-method', 'extraction/parsed-document', 'extraction/schema', 'extraction/durable-types'])
const extractionRuntime = (specifier: string) =>
  (specifier === 'extraction' || specifier.startsWith('extraction/')) && !BROWSER_EXTRACTION.has(specifier)

describe('extraction method boundaries (design §8)', () => {
  it('sees every import form', () => {
    const source = `import a from 'extraction/workflows'\nimport 'extraction'\nexport { b } from "extraction/batch"\n` +
      `const c = await import( 'x/experiments/extraction/run' )\nimport type { D } from 'extraction/schema'`
    const found = specifiers(source)
    expect(found).toEqual(['extraction/workflows', 'extraction', 'extraction/batch', 'x/experiments/extraction/run', 'extraction/schema'])
    expect(found.filter(extractionRuntime)).toEqual(['extraction/workflows', 'extraction', 'extraction/batch'])
    expect(found.filter(research)).toEqual(['x/experiments/extraction/run'])
  })

  it('start handlers hold no method policy and never read the account configuration themselves', () => {
    for (const handler of ['api/extractions.ts', 'api/batch_extractions.ts', 'api/batch_schema_suggestions.ts']) {
      const source = read(handler)
      for (const forbidden of ['readAccountModelConfig', 'modelConfigurations', 'lockModelConfiguration', 'accountMethod',
        'articleSettingsIssues', 'identityFieldIssues', 'keiMethodOptions'])
        expect(source.includes(forbidden), `${handler} uses ${forbidden}`).toBe(false)
    }
  })

  it('browser code never imports the extraction runtime, experiments or validation reports', () => {
    for (const file of walk('src')) {
      const found = specifiers(read(file))
      expect(found.filter(extractionRuntime), file).toEqual([])
      expect(found.filter(research), file).toEqual([])
    }
  })

  it('server code never imports experiments or validation reports', () => {
    for (const file of [...walk('api'), ...walk('server'), ...walk('shared')])
      expect(specifiers(read(file)).filter(research), file).toEqual([])
  })
})
