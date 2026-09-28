import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name))
    : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
const importing = /(?:from\s*|import\(\s*)['"][^'"]*(?:experiments\/extraction|docs\/validation)[^'"]*['"]/

describe('extraction method boundaries (design §8)', () => {
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
      const source = read(file)
      expect(source, file).not.toMatch(/from\s*['"]extraction['"]/)
      expect(source, file).not.toMatch(importing)
    }
  })

  it('server code never imports experiments or validation reports', () => {
    for (const file of [...walk('api'), ...walk('server'), ...walk('shared')]) expect(read(file), file).not.toMatch(importing)
  })
})
