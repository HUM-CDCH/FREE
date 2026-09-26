import { STUDIO_BOOT_HEADER } from '../../shared/studioBoot.js'
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

let studioBoot: string | null = null
const resendListeners = new Set<() => void>()

/** Called when Studio no longer holds this page's keys: it restarted (a new boot ID) or answered model_key_required. */
export function subscribeToModelKeyResend(listener: () => void): () => void {
  resendListeners.add(listener)
  return () => resendListeners.delete(listener)
}

/** Listeners run inside `authenticatedFetch`, so one that throws must fail neither that request nor the others. */
function requestModelKeyResend(): void {
  for (const listener of [...resendListeners]) {
    try {
      listener()
    } catch {
      // A resend is best effort: the next new boot ID or model_key_required asks again.
    }
  }
}

/** Forgets the boot ID seen and every resend listener, so one test's module state does not reach the next. */
export function resetModelKeyResendForTesting(): void {
  studioBoot = null
  resendListeners.clear()
}

function observeModelKeyCustody(response: Response): void {
  const boot = response.headers.get(STUDIO_BOOT_HEADER)
  if (boot !== null && boot !== studioBoot) {
    const restarted = studioBoot !== null
    // Recorded before any resend starts, so the resend's own response, which carries the same ID, triggers nothing.
    studioBoot = boot
    if (restarted) requestModelKeyResend()
  }
  if (response.status === 409)
    void response
      .clone()
      .json()
      .then(
        (body: unknown) => {
          if ((body as { error?: { code?: unknown } } | null)?.error?.code === 'model_key_required')
            requestModelKeyResend()
        },
        () => undefined,
      )
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
  observeModelKeyCustody(response)
  return response
}
