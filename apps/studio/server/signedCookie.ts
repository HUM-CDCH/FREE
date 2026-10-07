import { createHmac, timingSafeEqual } from 'node:crypto'

const BASE64URL = /^[A-Za-z0-9_-]+$/

export type SingleCookie = {
  present: boolean
  value: string | null
}

function canonicalBase64Url(value: string): Buffer | null {
  if (!value || !BASE64URL.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.toString('base64url') === value ? decoded : null
  } catch {
    return null
  }
}

export function isCanonicalBase64Url(value: string): boolean {
  return canonicalBase64Url(value) !== null
}

function signature(
  encodedPayload: string,
  secret: Uint8Array,
  context: string,
): Buffer {
  return createHmac('sha256', secret)
    .update(context)
    .update('\0')
    .update(encodedPayload)
    .digest()
}

export function encodeSignedValue(
  payload: unknown,
  secret: Uint8Array,
  context: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  )
  return `${encodedPayload}.${signature(encodedPayload, secret, context).toString('base64url')}`
}

export function decodeSignedValue(
  value: string,
  secret: Uint8Array,
  context: string,
  maxLength: number,
): unknown | null {
  if (value.length > maxLength) return null
  const segments = value.split('.')
  if (segments.length !== 2) return null
  const [encodedPayload, encodedSignature] = segments
  const payload = canonicalBase64Url(encodedPayload)
  const suppliedSignature = canonicalBase64Url(encodedSignature)
  if (!payload || !suppliedSignature) return null

  const expectedSignature = signature(encodedPayload, secret, context)
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  )
    return null

  try {
    return JSON.parse(payload.toString('utf8')) as unknown
  } catch {
    return null
  }
}

export function readSingleCookie(
  request: Request,
  name: string,
): SingleCookie {
  const header = request.headers.get('cookie')
  if (!header) return { present: false, value: null }

  let found: string | undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    if (found !== undefined) return { present: true, value: null }
    found = part.slice(separator + 1).trim()
  }
  return found === undefined
    ? { present: false, value: null }
    : { present: true, value: found || null }
}
