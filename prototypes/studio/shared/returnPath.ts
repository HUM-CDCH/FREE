import { CANONICAL_UUID_PATTERN } from 'studio-configuration'

const LOCAL_URL_BASE = 'https://free.local'
const PROJECT_PATH = new RegExp(
  `^/projects(?:/${CANONICAL_UUID_PATTERN}(?:/.*)?)?$`,
  'i',
)

export const DEFAULT_RETURN_PATH = '/projects'

/** Accept only an origin-relative path in Studio's protected route namespace. */
export function validateLocalReturnPath(candidate: string | null): string | null {
  if (candidate === null) return null
  let decodedCandidate: string
  try {
    decodedCandidate = decodeURI(candidate)
  } catch {
    return null
  }
  const containsControlCharacter = Array.from(decodedCandidate).some(
    (character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    },
  )
  if (
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    decodedCandidate.includes('\\') ||
    containsControlCharacter
  )
    return null

  try {
    const parsed = new URL(candidate, LOCAL_URL_BASE)
    if (parsed.origin !== LOCAL_URL_BASE || !PROJECT_PATH.test(parsed.pathname))
      return null
    const normalizedPath = `${parsed.pathname}${parsed.search}${parsed.hash}`
    return normalizedPath.startsWith('//') ? null : normalizedPath
  } catch {
    return null
  }
}
