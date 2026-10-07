import { describe, expect, it } from 'vitest'
import {
  decodeSignedValue,
  encodeSignedValue,
  readSingleCookie,
} from './signedCookie.js'

const SECRET = Buffer.alloc(32, 17)

describe('signed cookie values', () => {
  it('round-trips JSON only in the matching signature context', () => {
    const value = encodeSignedValue({ accountId: 'one' }, SECRET, 'session')

    expect(decodeSignedValue(value, SECRET, 'session', value.length)).toEqual({
      accountId: 'one',
    })
    expect(
      decodeSignedValue(value, SECRET, 'transaction', value.length),
    ).toBeNull()
    expect(
      decodeSignedValue(value, SECRET, 'session', value.length - 1),
    ).toBeNull()
  })

  it('rejects malformed signatures and duplicate cookie names', () => {
    const value = encodeSignedValue({ ok: true }, SECRET, 'test')
    const replacement = value.endsWith('A') ? 'B' : 'A'

    expect(
      decodeSignedValue(
        `${value.slice(0, -1)}${replacement}`,
        SECRET,
        'test',
        1_000,
      ),
    ).toBeNull()
    expect(decodeSignedValue('not.a.cookie', SECRET, 'test', 1_000)).toBeNull()
    expect(
      readSingleCookie(
        new Request('https://studio.example', {
          headers: { cookie: `other=1; target=${value}; target=${value}` },
        }),
        'target',
      ),
    ).toEqual({ present: true, value: null })
  })
})
