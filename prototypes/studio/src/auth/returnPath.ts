import { browserStudioPath, browserStudioPathname } from '../studioUrl.js'

const DEFAULT_RETURN_PATH = '/projects'
const LOCAL_URL_BASE = 'https://free.local'
const AUTH_PATHS: Partial<Record<string, true>> = {
  '/login': true,
  '/change-password': true,
}

/** Accept only an origin-relative browser path; absolute and scheme-relative URLs fail closed. */
export function validateLocalReturnPath(candidate: string | null): string | null {
  let decodedCandidate: string | null = null
  try {
    decodedCandidate = candidate === null ? null : decodeURI(candidate)
  } catch {
    return null
  }
  const containsControlCharacter =
    decodedCandidate !== null &&
    Array.from(decodedCandidate).some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  if (
    candidate === null ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    decodedCandidate?.includes('\\') ||
    containsControlCharacter
  )
    return null

  try {
    const parsed = new URL(candidate, LOCAL_URL_BASE)
    if (parsed.origin !== LOCAL_URL_BASE) return null
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return null
  }
}

/** Resolve the server's protected-navigation return target or preserve a local deep link. */
export function currentReturnPath(): string {
  const pathname = browserStudioPathname()
  const candidate = AUTH_PATHS[pathname]
    ? new URLSearchParams(location.search).get('returnTo')
    : `${pathname}${location.search}${location.hash}`
  const validated = validateLocalReturnPath(candidate)
  if (validated === null) return DEFAULT_RETURN_PATH

  // `returnTo` is always an internal path. A deployment-prefixed value would
  // otherwise apply the base path twice after authentication.
  const studioBasePath = browserStudioPath('/').replace(/\/$/, '') || '/'
  if (
    studioBasePath !== '/' &&
    (validated === studioBasePath || validated.startsWith(`${studioBasePath}/`))
  )
    return DEFAULT_RETURN_PATH

  return validated
}
