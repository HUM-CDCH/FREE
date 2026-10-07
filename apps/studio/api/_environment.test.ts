import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Task 7.2: saved configuration is the sole runtime model-configuration source.
// Reading any of these back into production code would silently reintroduce the
// duplicated environment routing this change removed, and no unit test of a
// single module can catch that — only a sweep of the tree can.
const REMOVED_SETTINGS = ['AI_PROVIDER', 'AI_MODEL', 'AI_CHAT_MODEL', 'AI_BASE_URL', 'AI_API_KEY']
const PRODUCTION_ROOTS = ['api', 'src']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) return []
    // Tests may name a removed setting in order to prove it is ignored.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) return []
    return [path]
  }))
  return found.flat()
}

describe('runtime model configuration', () => {
  it('reads no removed AI_* setting anywhere in production Studio code', async () => {
    const studio = fileURLToPath(new URL('..', import.meta.url))
    const sources = (await Promise.all(
      PRODUCTION_ROOTS.map((root) => productionSources(join(studio, root))),
    )).flat()
    // Guards the sweep itself: an empty file list would pass vacuously.
    expect(sources.length).toBeGreaterThan(10)

    const offenders: string[] = []
    for (const path of sources) {
      const text = await readFile(path, 'utf8')
      for (const setting of REMOVED_SETTINGS) {
        if (text.includes(setting)) offenders.push(`${path.slice(studio.length)}: ${setting}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
