import { browserStudioPath } from '../studioUrl.js'

const authenticationEvents = new EventTarget()
const authenticationRequired = 'authentication-required'

/** Subscribe the application-owned authentication state to protected-request expiry. */
export function subscribeToAuthenticationRequired(
  listener: () => void,
): () => void {
  authenticationEvents.addEventListener(authenticationRequired, listener)
  return () =>
    authenticationEvents.removeEventListener(authenticationRequired, listener)
}

/**
 * Report a protected resource that answered as unauthenticated outside
 * `authenticatedFetch` — a code-split route module, whose failed import the
 * browser reports without a status.
 */
export function reportAuthenticationRequired(): void {
  authenticationEvents.dispatchEvent(new Event(authenticationRequired))
}

/**
 * The sole browser transport for protected Studio resources. A 401 is returned
 * unchanged so endpoint-specific error handling remains intact, after the
 * authentication state has been told to unmount the protected application.
 */
export async function authenticatedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const scopedInput =
    typeof input === 'string' && input.startsWith('/') && !input.startsWith('//')
      ? browserStudioPath(input)
      : input
  const response = await fetch(scopedInput, {
    ...init,
    credentials: 'same-origin',
  })
  if (response.status === 401) reportAuthenticationRequired()
  return response
}
