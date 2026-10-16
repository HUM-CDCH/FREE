import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('bounded Article deployment gate', () => {
  it('passes the operator value only to Studio, with an explicit empty default', () => {
    const base = read('compose.yaml')
    const studio = base.match(/^ {2}studio:\n[\s\S]*?(?=^ {2}[\w-]+:|^volumes:)/m)?.[0]

    expect(studio).toContain('FREE_ARTICLE_CONTEXT: "${FREE_ARTICLE_CONTEXT:-}"')
    expect(base.match(/^\s+FREE_ARTICLE_CONTEXT:/gm)).toHaveLength(1)
  })

  it('does not enable or override the admission gate in any Compose overlay', () => {
    const overlays = readdirSync(root).filter((name) => /^compose\..+\.yaml$/.test(name))
    expect(overlays.length).toBeGreaterThan(0)
    for (const overlay of overlays)
      expect(read(overlay), overlay).not.toMatch(/^\s+FREE_ARTICLE_CONTEXT:/m)
  })

  it('keeps the example opt-in commented out', () => {
    const example = read('.env.example')
    expect(example).toMatch(/^# FREE_ARTICLE_CONTEXT=bounded$/m)
    expect(example).not.toMatch(/^FREE_ARTICLE_CONTEXT=/m)
  })
})
