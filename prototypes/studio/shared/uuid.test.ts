import { describe, expect, it } from 'vitest'
import { CANONICAL_UUID, normalizeCanonicalUuid } from './uuid.js'

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('canonical UUIDs', () => {
  it('keeps strict signed-payload validation separate from input normalization', () => {
    expect(CANONICAL_UUID.test(UUID)).toBe(true)
    expect(CANONICAL_UUID.test(UUID.toUpperCase())).toBe(false)
    expect(normalizeCanonicalUuid(UUID.toUpperCase())).toBe(UUID)
    expect(normalizeCanonicalUuid('not-a-uuid')).toBeNull()
  })
})
