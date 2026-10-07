import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VITE_DEVELOPMENT_ASSETS } from './app'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
/** Linked workspace packages are served from source (`/@fs/…`), which a signed-out request cannot read; only those
 *  Vite pre-bundles into `/node_modules/.vite/deps/` are reachable. */
const PREBUNDLED_WORKSPACE = new Set(['studio-configuration'])
const WORKSPACE = Object.entries(MANIFEST.dependencies)
  .filter(([, version]) => version.startsWith('workspace:'))
  .map(([name]) => name)

/** Runtime import specifiers of a module; `import type` and `export type` are erased and never requested. */
function runtimeImports(source: string): string[] {
  const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm
  return [...source.matchAll(pattern)].map((match) => match[1]!)
}

function resolveModule(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier)
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`]
  const found = candidates.find((candidate) => existsSync(candidate) && /\.(ts|tsx|css)$/.test(candidate))
  if (!found) throw new Error(`cannot resolve ${specifier} from ${from}`)
  return `/${relative(ROOT, found)}`
}

describe('the signed-out page', () => {
  it('imports only modules a signed-out browser may load', () => {
    const modules = Object.keys(VITE_DEVELOPMENT_ASSETS).filter((path) => /\.(ts|tsx)$/.test(path))
    for (const path of modules) {
      const file = join(ROOT, path)
      for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.')) {
          expect(VITE_DEVELOPMENT_ASSETS[resolveModule(file, specifier)], `${path} imports ${specifier}`).toBe(true)
          continue
        }
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
        if (WORKSPACE.includes(name)) expect(PREBUNDLED_WORKSPACE.has(name), `${path} imports ${specifier}`).toBe(true)
      }
    }
  })
})
