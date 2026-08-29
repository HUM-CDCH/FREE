const BASE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/

export const CANONICAL_UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

export const CANONICAL_UUID = new RegExp(`^${CANONICAL_UUID_PATTERN}$`)

export const SHARED_STUDIO_CONFIGURATION_FIELDS = Object.freeze([
  'STUDIO_ORIGIN',
  'STUDIO_BASE_PATH',
  'FREE_SESSION_SECRET',
  'FREE_ENTRA_TENANT_ID',
  'FREE_ENTRA_CLIENT_ID',
  'FREE_ENTRA_CLIENT_CERT_THUMBPRINT',
  'FREE_ENTRA_CLIENT_CERT_PATH',
])

/**
 * @typedef {(typeof SHARED_STUDIO_CONFIGURATION_FIELDS)[number]} SharedStudioConfigurationField
 * @typedef {'required' | 'invalid'} StudioConfigurationIssueCode
 * @typedef {{ field: SharedStudioConfigurationField, code: StudioConfigurationIssueCode, message: string }} StudioConfigurationIssue
 * @typedef {{
 *   STUDIO_ORIGIN?: string,
 *   STUDIO_BASE_PATH?: string,
 *   FREE_SESSION_SECRET?: Uint8Array,
 *   FREE_ENTRA_TENANT_ID?: string,
 *   FREE_ENTRA_CLIENT_ID?: string,
 *   FREE_ENTRA_CLIENT_CERT_THUMBPRINT?: string,
 *   FREE_ENTRA_CLIENT_CERT_PATH?: string,
 * }} SharedStudioConfigurationValues
 */

export function canonicalStudioOrigin(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch (cause) {
    throw new Error(
      'The Studio origin must be a canonical HTTP or HTTPS origin.',
      { cause },
    )
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== value ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error('The Studio origin must be a canonical HTTP or HTTPS origin.')
  return value
}

export function canonicalStudioBasePath(value) {
  if (value === '/') return value
  if (
    !value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('%') ||
    value.includes('?') ||
    value.includes('#')
  )
    throw new Error('The Studio base path is not canonical.')

  const segments = value.slice(1).split('/')
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !BASE_PATH_SEGMENT.test(segment),
    )
  )
    throw new Error('The Studio base path is not canonical.')
  return value
}

export function normalizeCanonicalUuid(value) {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase()
  return CANONICAL_UUID.test(normalized) ? normalized : null
}

export function canonicalEntraCertificateThumbprint(value) {
  const normalized = value.replaceAll(':', '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(normalized))
    throw new Error(
      'FREE_ENTRA_CLIENT_CERT_THUMBPRINT must be a SHA-256 certificate thumbprint.',
    )
  return normalized
}

export function decodeCanonicalSessionSecret(value) {
  let decoded
  try {
    decoded = globalThis.atob(value)
  } catch {
    return null
  }
  if (globalThis.btoa(decoded) !== value) return null
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

/**
 * Decode the canonical base64 representation of a Studio session secret and
 * enforce the shared minimum strength policy.
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
export function canonicalStudioSessionSecret(value) {
  const decoded = decodeCanonicalSessionSecret(value)
  if (decoded === null)
    throw new Error('FREE_SESSION_SECRET must be canonical base64.')
  if (decoded.byteLength < 32)
    throw new Error('FREE_SESSION_SECRET must decode to at least 32 bytes.')
  return decoded
}

/**
 * Validate the syntax shared by every production Studio entry point. The
 * caller owns deployment policy, side effects, and error adaptation.
 *
 * @param {Record<string, string | undefined>} environment
 * @returns {{ values: SharedStudioConfigurationValues, issues: StudioConfigurationIssue[] }}
 */
export function validateSharedStudioConfiguration(environment) {
  /** @type {SharedStudioConfigurationValues} */
  const values = {}
  /** @type {StudioConfigurationIssue[]} */
  const issues = []

  /** @param {SharedStudioConfigurationField} field */
  const required = (field) => {
    const value = environment[field]
    if (value === undefined || value === '') {
      issues.push({
        field,
        code: 'required',
        message: `${field} is required.`,
      })
      return null
    }
    return value
  }

  const origin = required('STUDIO_ORIGIN')
  if (origin !== null) {
    try {
      values.STUDIO_ORIGIN = canonicalStudioOrigin(origin)
    } catch {
      issues.push({
        field: 'STUDIO_ORIGIN',
        code: 'invalid',
        message: 'STUDIO_ORIGIN must be a canonical HTTP or HTTPS origin.',
      })
    }
  }

  const basePath = required('STUDIO_BASE_PATH')
  if (basePath !== null) {
    try {
      values.STUDIO_BASE_PATH = canonicalStudioBasePath(basePath)
    } catch {
      issues.push({
        field: 'STUDIO_BASE_PATH',
        code: 'invalid',
        message:
          'STUDIO_BASE_PATH must be / or one canonical absolute path without a trailing slash.',
      })
    }
  }

  const sessionSecret = required('FREE_SESSION_SECRET')
  if (sessionSecret !== null) {
    try {
      values.FREE_SESSION_SECRET = canonicalStudioSessionSecret(sessionSecret)
    } catch (error) {
      issues.push({
        field: 'FREE_SESSION_SECRET',
        code: 'invalid',
        message:
          error instanceof Error
            ? error.message
            : 'FREE_SESSION_SECRET is invalid.',
      })
    }
  }

  for (const field of [
    'FREE_ENTRA_TENANT_ID',
    'FREE_ENTRA_CLIENT_ID',
  ]) {
    const uuid = required(field)
    if (uuid === null) continue
    const normalized = normalizeCanonicalUuid(uuid)
    if (normalized === null)
      issues.push({
        field,
        code: 'invalid',
        message: `${field} must be a UUID.`,
      })
    else values[field] = normalized
  }

  const thumbprint = required('FREE_ENTRA_CLIENT_CERT_THUMBPRINT')
  if (thumbprint !== null) {
    try {
      values.FREE_ENTRA_CLIENT_CERT_THUMBPRINT =
        canonicalEntraCertificateThumbprint(thumbprint)
    } catch {
      issues.push({
        field: 'FREE_ENTRA_CLIENT_CERT_THUMBPRINT',
        code: 'invalid',
        message:
          'FREE_ENTRA_CLIENT_CERT_THUMBPRINT must be a SHA-256 certificate thumbprint.',
      })
    }
  }

  const certificatePath = required('FREE_ENTRA_CLIENT_CERT_PATH')
  if (certificatePath !== null)
    values.FREE_ENTRA_CLIENT_CERT_PATH = certificatePath

  return { values, issues }
}
