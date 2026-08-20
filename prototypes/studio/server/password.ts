import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export const PASSWORD_MIN_SCALARS = 15
export const PASSWORD_MAX_SCALARS = 128

const SCRYPT_VERSION = 'v=1'
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const SCRYPT_SALT_BYTES = 16
const SCRYPT_KEY_BYTES = 32
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024
const SCRYPT_PARAMETERS = `N=${SCRYPT_COST},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELIZATION},dkLen=${SCRYPT_KEY_BYTES}`
const BASE64URL = /^[A-Za-z0-9_-]+$/

export class PasswordPolicyError extends Error {
  readonly code = 'invalid_password'

  constructor() {
    super(
      `Password must contain ${PASSWORD_MIN_SCALARS} through ${PASSWORD_MAX_SCALARS} Unicode scalar values.`,
    )
    this.name = 'PasswordPolicyError'
  }
}

/** Validate the exact string. In particular, this performs no Unicode normalization. */
export function validatePassword(password: string): void {
  if (typeof password !== 'string') throw new PasswordPolicyError()

  let scalarCount = 0
  for (const scalar of password) {
    const codePoint = scalar.codePointAt(0)!
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new PasswordPolicyError()
    }
    scalarCount += 1
    if (scalarCount > PASSWORD_MAX_SCALARS) throw new PasswordPolicyError()
  }

  if (scalarCount < PASSWORD_MIN_SCALARS) throw new PasswordPolicyError()
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, key) => {
        if (error) reject(error)
        else resolve(key)
      },
    )
  })
}

function decodeCanonicalBase64Url(value: string, bytes: number): Buffer | undefined {
  if (value.length !== Math.ceil((bytes * 4) / 3) || !BASE64URL.test(value)) {
    return undefined
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) return undefined
  return decoded
}

function parsePasswordHash(
  representation: string,
): { salt: Buffer; key: Buffer } | undefined {
  if (typeof representation !== 'string') return undefined
  const parts = representation.split('$')
  if (
    parts.length !== 5 ||
    parts[0] !== 'scrypt' ||
    parts[1] !== SCRYPT_VERSION ||
    parts[2] !== SCRYPT_PARAMETERS
  ) {
    return undefined
  }

  const salt = decodeCanonicalBase64Url(parts[3]!, SCRYPT_SALT_BYTES)
  const key = decodeCanonicalBase64Url(parts[4]!, SCRYPT_KEY_BYTES)
  return salt && key ? { salt, key } : undefined
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password)
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const key = await deriveKey(password, salt)
  return `scrypt$${SCRYPT_VERSION}$${SCRYPT_PARAMETERS}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(
  password: string,
  representation: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(representation)
  if (!parsed) return false

  try {
    validatePassword(password)
  } catch (error) {
    if (error instanceof PasswordPolicyError) return false
    throw error
  }

  const candidate = await deriveKey(password, parsed.salt)
  return timingSafeEqual(candidate, parsed.key)
}
