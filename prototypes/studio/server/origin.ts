import { ApiError } from '../api/_http.js'

const SAFE_METHODS: Readonly<Record<string, true>> = {
  GET: true,
  HEAD: true,
  OPTIONS: true,
}

export function canonicalStudioOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (cause) {
    throw new Error('The Studio origin must be a canonical HTTP or HTTPS origin.', {
      cause,
    })
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

export function enforceCanonicalOrigin(
  request: Request,
  studioOrigin: string,
): void {
  if (SAFE_METHODS[request.method.toUpperCase()]) return
  if (request.headers.get('origin') !== studioOrigin)
    throw new ApiError(
      403,
      'origin_rejected',
      'Request origin is not allowed.',
    )
}
