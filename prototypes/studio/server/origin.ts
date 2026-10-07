import { ApiError } from '../api/_http.js'

const SAFE_METHODS: Readonly<Record<string, true>> = {
  GET: true,
  HEAD: true,
  OPTIONS: true,
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
