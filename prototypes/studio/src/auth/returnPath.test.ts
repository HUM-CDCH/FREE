// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { currentReturnPath, validateLocalReturnPath } from './returnPath.js'

afterEach(() => {
  document.querySelector('base')?.remove()
  history.replaceState(null, '', '/')
})

describe('authentication return paths', () => {
  it.each([
    ['/projects', '/projects'],
    [
      '/projects/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222?view=review#value',
      '/projects/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222?view=review#value',
    ],
    ['https://attacker.example/projects/secret', null],
    ['//attacker.example/projects/secret', null],
    ['javascript:alert(1)', null],
    ['/projects\\secret', null],
    ['/projects/%5Csecret', null],
    ['/projects/%00secret', null],
    ['/projects/%zz', null],
    ['', null],
    [null, null],
  ])('validates return target %j as %j', (candidate, expected) => {
    expect(validateLocalReturnPath(candidate)).toBe(expected)
  })

  it('keeps a valid internal deep link beneath a configured base path', () => {
    const base = document.createElement('base')
    base.href = '/free/'
    document.head.prepend(base)
    const returnTo =
      '/projects/11111111-1111-4111-8111-111111111111/schemas?revision=latest'
    history.replaceState(
      null,
      '',
      `/free/login?${new URLSearchParams({ returnTo })}`,
    )

    expect(currentReturnPath()).toBe(returnTo)
  })

  it.each([
    ['deployment-prefixed target', '/free/projects/secret'],
    ['external target', 'https://attacker.example/projects/secret'],
    ['protocol-relative target', '//attacker.example/projects/secret'],
    ['malformed target', '/projects/%zz'],
  ])('falls back safely for a $label beneath a base path', (_label, returnTo) => {
    const base = document.createElement('base')
    base.href = '/free/'
    document.head.prepend(base)
    history.replaceState(
      null,
      '',
      `/free/login?${new URLSearchParams({ returnTo })}`,
    )

    expect(currentReturnPath()).toBe('/projects')
  })
})
