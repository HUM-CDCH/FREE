// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureSessionRecovery,
  clearSessionRecovery,
  consumeSessionRecovery,
  clearSessionSignedOut,
  isAuthenticationRedirecting,
  isSessionSignedOut,
  registerSessionRecoveryCapture,
  markSessionSignedOut,
  removeSessionRecovery,
  setSessionRecoveryAccount,
} from './sessionRecovery.js'

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  clearSessionRecovery()
  sessionStorage.clear()
  vi.useRealTimers()
})

describe('same-tab authentication recovery', () => {
  it('captures and restores only registered account/resource state', () => {
    setSessionRecoveryAccount(ACCOUNT_A)
    const unregister = registerSessionRecoveryCapture(
      'schema-draft',
      'project-a/schema-a',
      () => ({ acknowledgedRevision: 3, draft: { schemaNodes: [] } }),
    )
    captureSessionRecovery()
    unregister()

    expect(isAuthenticationRedirecting()).toBe(true)
    setSessionRecoveryAccount(ACCOUNT_A)
    expect(
      consumeSessionRecovery(
        'schema-draft',
        'project-b/schema-a',
        (value) => value,
      ),
    ).toBeNull()
    expect(
      consumeSessionRecovery(
        'schema-draft',
        'project-a/schema-a',
        (value) => value,
      ),
    ).toEqual({ acknowledgedRevision: 3, draft: { schemaNodes: [] } })
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('rejects cross-account state before a resource can inspect it', () => {
    setSessionRecoveryAccount(ACCOUNT_A)
    const unregister = registerSessionRecoveryCapture(
      'batch-schema-draft',
      'extraction-a',
      () => ({ decisions: [] }),
    )
    captureSessionRecovery()
    unregister()

    setSessionRecoveryAccount(ACCOUNT_B)
    expect(
      consumeSessionRecovery('batch-schema-draft', 'extraction-a', (value) => value),
    ).toBeNull()
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('drops malformed, expired, and server-incompatible values', () => {
    sessionStorage.setItem('free.auth.recovery.v1', '{malformed')
    setSessionRecoveryAccount(ACCOUNT_A)
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-26T12:00:00.000Z'))
    setSessionRecoveryAccount(ACCOUNT_A)
    const unregister = registerSessionRecoveryCapture(
      'batch-schema-draft',
      'suggestion-a',
      () => ({ version: 4 }),
    )
    captureSessionRecovery()
    unregister()
    vi.setSystemTime(new Date('2026-08-26T12:31:00.000Z'))
    expect(
      consumeSessionRecovery('batch-schema-draft', 'suggestion-a', (value) => value),
    ).toBeNull()

    vi.setSystemTime(new Date('2026-08-26T13:00:00.000Z'))
    setSessionRecoveryAccount(ACCOUNT_A)
    const incompatible = registerSessionRecoveryCapture(
      'schema-draft',
      'schema-a',
      () => ({ acknowledgedRevision: 1 }),
    )
    captureSessionRecovery()
    incompatible()
    setSessionRecoveryAccount(ACCOUNT_A)
    expect(
      consumeSessionRecovery('schema-draft', 'schema-a', () => null),
    ).toBeNull()
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('clears one durable entry or the complete logout boundary', () => {
    setSessionRecoveryAccount(ACCOUNT_A)
    const unregisterSchema = registerSessionRecoveryCapture(
      'schema-draft',
      'schema-a',
      () => ({ draft: 1 }),
    )
    const unregisterBatch = registerSessionRecoveryCapture(
      'batch-schema-draft',
      'extraction-a',
      () => ({ draft: 2 }),
    )
    captureSessionRecovery()
    unregisterSchema()
    unregisterBatch()

    removeSessionRecovery('schema-draft', 'schema-a')
    expect(
      consumeSessionRecovery('schema-draft', 'schema-a', (value) => value),
    ).toBeNull()
    clearSessionRecovery()
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
    expect(isAuthenticationRedirecting()).toBe(false)
  })

  it('holds explicit logout across Back until sign-in starts', () => {
    setSessionRecoveryAccount(ACCOUNT_A)
    markSessionSignedOut()

    expect(isSessionSignedOut()).toBe(true)
    clearSessionSignedOut()
    expect(isSessionSignedOut()).toBe(false)
  })
})
