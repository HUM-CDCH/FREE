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
 * The sole browser transport for protected Studio resources. A 401 is returned
 * unchanged so endpoint-specific error handling remains intact, after the
 * authentication state has been told to unmount the protected application.
 */
export async function authenticatedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    credentials: 'same-origin',
  })
  if (response.status === 401)
    authenticationEvents.dispatchEvent(new Event(authenticationRequired))
  return response
}
