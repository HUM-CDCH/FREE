import { serialize, type CookieOptions } from 'hono/utils/cookie'

type AuthCookieOptions = Pick<CookieOptions, 'expires' | 'maxAge'> & {
  path: string
}

const EXPIRED = new Date(0)

/** One browser policy for every authentication and authorization cookie. */
export function serializeAuthCookie(
  name: string,
  value: string,
  options: AuthCookieOptions,
): string {
  return serialize(name, value, {
    ...options,
    httpOnly: true,
    secure: true,
    // Lax permits the top-level return from Entra while unsafe methods remain
    // protected by the canonical Origin check.
    sameSite: 'Lax',
  })
}

export function clearAuthCookie(name: string, path: string): string {
  return serializeAuthCookie(name, '', {
    path,
    expires: EXPIRED,
    maxAge: 0,
  })
}
