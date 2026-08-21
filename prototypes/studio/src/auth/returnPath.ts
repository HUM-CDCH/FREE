import { browserStudioPathname } from '../studioUrl.js'

const DEFAULT_RETURN_PATH = '/projects'
const LOCAL_URL_BASE = 'https://free.local'
const AUTH_PATHS: Partial<Record<string, true>> = {
  '/login': true,
  '/change-password': true,
}

/** Accept only an origin-relative browser path; absolute and scheme-relative URLs fail closed. */
export function validateLocalReturnPath(candidate: string | null): string | null {
  const containsControlCharacter =
    candidate !== null &&
    Array.from(candidate).some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  if (
    candidate === null ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
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
  return validateLocalReturnPath(candidate) ?? DEFAULT_RETURN_PATH
}
