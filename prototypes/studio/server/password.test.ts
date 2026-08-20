import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  PasswordPolicyError,
  validatePassword,
  verifyPassword,
} from './password.js'

const temporaryPassword = 'temporary-password'

describe('password policy', () => {
  it('accepts exactly 15 through 128 Unicode scalar values', () => {
    expect(() => validatePassword('a'.repeat(15))).not.toThrow()
    expect(() => validatePassword('a'.repeat(128))).not.toThrow()
    expect(() => validatePassword('a'.repeat(14))).toThrow(PasswordPolicyError)
    expect(() => validatePassword('a'.repeat(129))).toThrow(PasswordPolicyError)
  })

  it('counts astral characters as one scalar instead of two UTF-16 code units', () => {
    expect('🔬'.repeat(15)).toHaveLength(30)
    expect(() => validatePassword('🔬'.repeat(15))).not.toThrow()
    expect(() => validatePassword('🔬'.repeat(14))).toThrow(PasswordPolicyError)
    expect(() => validatePassword('🔬'.repeat(128))).not.toThrow()
    expect(() => validatePassword('🔬'.repeat(129))).toThrow(PasswordPolicyError)
  })

  it('rejects strings containing unpaired surrogate code units', () => {
    expect(() => validatePassword(`${'a'.repeat(15)}\ud800`)).toThrow(
      PasswordPolicyError,
    )
    expect(() => validatePassword(`\udc00${'a'.repeat(15)}`)).toThrow(
      PasswordPolicyError,
    )
  })
})

describe('scrypt password representation', () => {
  it('records its version and costs and uses a fresh random salt', async () => {
    const first = await hashPassword(temporaryPassword)
    const second = await hashPassword(temporaryPassword)

    expect(first).toMatch(
      /^scrypt\$v=1\$N=16384,r=8,p=1,dkLen=32\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    )
    expect(second).toMatch(
      /^scrypt\$v=1\$N=16384,r=8,p=1,dkLen=32\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    )
    expect(second).not.toBe(first)
  })

  it('verifies the exact password and rejects another policy-valid password', async () => {
    const representation = await hashPassword(temporaryPassword)

    await expect(
      verifyPassword(temporaryPassword, representation),
    ).resolves.toBe(true)
    await expect(
      verifyPassword('temporary-passw0rd', representation),
    ).resolves.toBe(false)
  })

  it('strictly rejects malformed, non-canonical, or unsupported representations', async () => {
    const valid = await hashPassword(temporaryPassword)
    const [algorithm, version, parameters, salt, key] = valid.split('$')
    const malformed = [
      '',
      ` ${valid}`,
      `${valid}\n`,
      `${valid}$extra`,
      [algorithm, 'v=2', parameters, salt, key].join('$'),
      [algorithm, version, parameters!.replace('16384', '32768'), salt, key].join(
        '$',
      ),
      [algorithm, version, parameters!.replace('16384', '016384'), salt, key].join(
        '$',
      ),
      [algorithm, version, 'r=8,N=16384,p=1,dkLen=32', salt, key].join('$'),
      [algorithm, version, parameters, `${salt}=`, key].join('$'),
      [algorithm, version, parameters, salt!.slice(1), key].join('$'),
      [algorithm, version, parameters, salt, `${key}=`].join('$'),
      [algorithm, version, parameters, salt, key!.slice(1)].join('$'),
      [algorithm, version, parameters, salt, `${key!.slice(0, -1)}!`].join('$'),
    ]

    await expect(
      Promise.all(
        malformed.map((representation) =>
          verifyPassword(temporaryPassword, representation),
        ),
      ),
    ).resolves.toEqual(malformed.map(() => false))
  })

  it('does not normalize canonically equivalent Unicode strings', async () => {
    const decomposed = 'e\u0301'.repeat(15)
    const composed = '\u00e9'.repeat(15)
    expect(decomposed.normalize('NFC')).toBe(composed)
    expect(() => validatePassword(decomposed)).not.toThrow()
    expect(() => validatePassword(composed)).not.toThrow()

    const representation = await hashPassword(decomposed)
    await expect(verifyPassword(decomposed, representation)).resolves.toBe(true)
    await expect(verifyPassword(composed, representation)).resolves.toBe(false)
  })
})
