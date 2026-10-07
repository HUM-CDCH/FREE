// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  browserStudioPath,
  browserStudioPathname,
} from './studioUrl.js'

afterEach(() => {
  document.querySelector('base')?.remove()
  history.replaceState(null, '', '/')
})

describe('browser Studio URL', () => {
  it('uses the document base for requests and navigation', () => {
    const base = document.createElement('base')
    base.href = '/free/'
    document.head.prepend(base)

    expect(browserStudioPath('/api/auth/session')).toBe(
      '/free/api/auth/session',
    )
    expect(browserStudioPath('/projects/one?tab=schema')).toBe(
      '/free/projects/one?tab=schema',
    )
    expect(browserStudioPathname('/free/projects/one')).toBe('/projects/one')
    expect(() => browserStudioPathname('/other/projects/one')).toThrow(
      /outside the Studio base path/i,
    )
  })
})
