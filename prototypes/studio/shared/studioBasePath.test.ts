import { describe, expect, it } from 'vitest'
import {
  canonicalStudioBasePath,
  studioBaseHref,
  studioPath,
  stripStudioBasePath,
} from './studioBasePath.js'

describe('Studio base path', () => {
  it('accepts one canonical root or path prefix', () => {
    expect(canonicalStudioBasePath('/')).toBe('/')
    expect(canonicalStudioBasePath('/free')).toBe('/free')
    expect(canonicalStudioBasePath('/research/free')).toBe('/research/free')

    for (const value of [
      '',
      'free',
      '/free/',
      '//free',
      '/free?mode=test',
      '/free#section',
      '/free/../admin',
      '/free/%2fadmin',
      '/free\\admin',
    ])
      expect(() => canonicalStudioBasePath(value)).toThrow(/base path/i)
  })

  it('maps between internal and public Studio paths', () => {
    expect(studioPath('/', '/api/healthz')).toBe('/api/healthz')
    expect(studioPath('/free', '/api/healthz')).toBe('/free/api/healthz')
    expect(studioBaseHref('/')).toBe('/')
    expect(studioBaseHref('/free')).toBe('/free/')

    expect(stripStudioBasePath('/free', '/free')).toBe('/')
    expect(stripStudioBasePath('/free', '/free/')).toBe('/')
    expect(stripStudioBasePath('/free', '/free/projects/one')).toBe(
      '/projects/one',
    )
    expect(stripStudioBasePath('/free', '/api/healthz')).toBeNull()
    expect(stripStudioBasePath('/free', '/free-adjacent')).toBeNull()
  })
})
