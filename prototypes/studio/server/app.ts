import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  createResearcherProjectStore,
  type ResearcherAccountStore,
  type ResearcherProjectStore,
} from 'db'
import { createHash } from 'node:crypto'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ApiError,
  apiErrorResponse,
} from '../api/_http.js'
import { GET as healthResponse } from '../api/healthz.js'
import {
  dispatchApiRequest,
  dispatchDevelopmentApiRequest,
  isSourceDocumentIngestionPath,
  SOURCE_DOCUMENT_INGESTION_REQUEST_LIMIT,
  type ApiDispatcher,
} from './api-dispatcher.js'
import {
  createAuthenticationBackend,
  type AuthenticatedState,
} from './auth.js'
import {
  type EntraIdentityProvider,
} from './entraIdentityProvider.js'
import { createEntraTransactionManager } from './entraTransaction.js'
import {
  canonicalStudioOrigin,
  enforceCanonicalOrigin,
} from './origin.js'
import { normalizeClientAddress } from './request-address.js'
import { createSessionManager } from './session.js'
import { createSessionGate } from './sessionGate.js'
import { readSingleCookie } from './signedCookie.js'
import { timingSafeStringEqual } from './timingSafeStringEqual.js'
import {
  canonicalStudioBasePath,
  studioPath,
  stripStudioBasePath,
} from '../shared/studioBasePath.js'
import {
  DEFAULT_RETURN_PATH,
  validateLocalReturnPath,
} from '../shared/returnPath.js'

export const VITE_CLIENT_FALLBACK_HEADER = 'x-free-vite-client-fallback'
export const GENERAL_API_REQUEST_LIMIT = 1024 * 1024
const SIGNED_OUT_COOKIE_NAME = 'free_signed_out'

const AUTH_METHOD: Readonly<Record<string, string>> = {
  login: 'GET',
  callback: 'GET',
  logout: 'POST',
  'signed-out': 'GET, HEAD',
}
const PUBLIC_BUILD_ASSET_PREFIXES = ['/assets/'] as const
const VITE_DEVELOPMENT_DEPENDENCY_PREFIXES = [
  '/@vite/',
  '/node_modules/.vite/deps/',
] as const
const PUBLIC_ASSETS: Readonly<Record<string, true>> = {
  '/favicon.png': true,
  '/free-logo.png': true,
  '/--free-logo.png': true,
}
const VITE_DEVELOPMENT_ASSETS: Readonly<Record<string, true>> = {
  '/@react-refresh': true,
  '/src/main.tsx': true,
  '/src/index.css': true,
  '/src/pdf-viewer.css': true,
  '/src/developerUi.ts': true,
  '/src/llmInspector/mount.tsx': true,
  '/src/auth/AuthApplication.tsx': true,
  '/src/auth/AuthForms.tsx': true,
  '/src/auth/authApi.ts': true,
  '/src/auth/authenticatedFetch.ts': true,
  '/src/auth/returnPath.ts': true,
  '/src/auth/sessionContext.ts': true,
  '/src/auth/sessionRecovery.ts': true,
  '/src/studioUrl.ts': true,
  '/shared/studioBasePath.ts': true,
  '/shared/authSession.contract.ts': true,
  '/shared/returnPath.ts': true,
  '/src/ui/Button.tsx': true,
  '/src/ui/ModalDialog.tsx': true,
}

function viteDependencyAsset(pathname: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false
  }
  if (
    /%[0-9a-f]{2}/i.test(decoded) ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((segment) => segment === '.' || segment === '..')
  )
    return false
  if (
    VITE_DEVELOPMENT_DEPENDENCY_PREFIXES.some((prefix) =>
      decoded.startsWith(prefix),
    )
  )
    return true
  if (!decoded.startsWith('/@fs/')) return false
  return decoded.includes('/node_modules/')
}

export type StudioBindings = {
  incoming?: IncomingMessage
  outgoing?: ServerResponse
  clientAddress?: string
}
type StudioVariables = {
  authentication: AuthenticatedState
}
type StudioEnvironment = {
  Bindings: StudioBindings
  Variables: StudioVariables
}

export type StudioApp = Hono<StudioEnvironment>
export type ClientHandler = (request: Request) => Response | Promise<Response>

export type StudioAppOptions = {
  studioOrigin: string
  basePath: string
  sessionSecret: Uint8Array
  identityProvider: EntraIdentityProvider
  accountStore?: ResearcherAccountStore
  now?: () => number
  apiDispatcher?: ApiDispatcher
  researcherProjectStore?: (
    researcherAccountId: string,
  ) => ResearcherProjectStore
  clientHandler?: ClientHandler
  viteDevelopmentAssets?: boolean
  requestPeer?: (bindings: StudioBindings) => void
}

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers)
  headers.append('Set-Cookie', cookie)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function signedOutCookie(basePath: string, clear = false): string {
  const expires = clear
    ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0'
    : ''
  return `${SIGNED_OUT_COOKIE_NAME}=${clear ? '' : '1'}; Path=${basePath}${expires}; Secure; HttpOnly; SameSite=Lax`
}

function hasSignedOutCookie(request: Request): boolean {
  return readSingleCookie(request, SIGNED_OUT_COOKIE_NAME).value === '1'
}

function noStoreResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function authenticationRequired(clearCookie?: string): Response {
  const response = noStoreResponse(
    apiErrorResponse(
      new ApiError(
        401,
        'authentication_required',
        'Authentication is required.',
      ),
    ),
  )
  return clearCookie ? withCookie(response, clearCookie) : response
}

function methodNotAllowed(allow: string): Response {
  const response = apiErrorResponse(
    new ApiError(
      405,
      'method_not_allowed',
      'The requested method is not supported.',
    ),
  )
  response.headers.set('Allow', allow)
  return response
}

function authErrorResponse(error: unknown): Response {
  return noStoreResponse(apiErrorResponse(error))
}

function bodyTooLarge(): Response {
  return noStoreResponse(
    apiErrorResponse(
      new ApiError(413, 'invalid_request', 'The request body is too large.'),
    ),
  )
}

function publicAsset(
  request: Request,
  allowViteDevelopmentAssets: boolean,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const pathname = new URL(request.url).pathname
  if (
    PUBLIC_ASSETS[pathname] === true ||
    PUBLIC_BUILD_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
    return true
  return (
    allowViteDevelopmentAssets &&
    (request.headers.get('upgrade')?.toLowerCase() === 'websocket' ||
      VITE_DEVELOPMENT_ASSETS[pathname] === true ||
      viteDependencyAsset(pathname))
  )
}

function redirect(
  basePath: string,
  location: string,
  cookie?: string,
): Response {
  const response = new Response(null, {
    status: 302,
    headers: {
      Location: studioPath(basePath, location),
      'Cache-Control': 'no-store',
    },
  })
  return cookie ? withCookie(response, cookie) : response
}

function externalRedirect(location: string, cookies: readonly string[] = []) {
  let response = new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  })
  for (const cookie of cookies) response = withCookie(response, cookie)
  return response
}

const FRAGMENT_RELAY_SCRIPT = `const url = new URL(location.href)
const returnTo = url.searchParams.get('returnTo') ?? '${DEFAULT_RETURN_PATH}'
if (location.hash) url.searchParams.set('returnTo', returnTo + location.hash)
url.searchParams.set('fragmentCaptured', '1')
url.hash = ''
location.replace(url)`
const FRAGMENT_RELAY_SCRIPT_HASH = createHash('sha256')
  .update(FRAGMENT_RELAY_SCRIPT)
  .digest('base64')

function htmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function fragmentRelayPage(request: Request): Response {
  const fallback = new URL(request.url)
  fallback.searchParams.set('fragmentCaptured', '1')
  fallback.hash = ''
  const fallbackLocation = htmlAttribute(`${fallback.pathname}${fallback.search}`)
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Continuing sign-in</title><script>${FRAGMENT_RELAY_SCRIPT}</script><noscript><meta http-equiv="refresh" content="0;url=${fallbackLocation}"><p><a href="${fallbackLocation}">Continue sign-in</a></p></noscript>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          `default-src 'none'; script-src 'sha256-${FRAGMENT_RELAY_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'`,
      },
    },
  )
}

function authenticationFailurePage(
  basePath: string,
  clearTransactionCookie: string,
  status = 400,
): Response {
  const loginPath = studioPath(basePath, '/auth/login')
  return withCookie(
    new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign-in failed</title><body><main><h1>Sign-in failed</h1><p>FREE Studio could not complete Microsoft Entra sign-in.</p><p><a href="${loginPath}">Try again</a></p></main></body></html>`,
      {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
      },
    ),
    clearTransactionCookie,
  )
}

function defaultClientHandler(): Response {
  return apiErrorResponse(new ApiError(404, 'not_found', 'Page not found.'))
}

export function viteClientFallback(): Response {
  return new Response(null, {
    status: 204,
    headers: { [VITE_CLIENT_FALLBACK_HEADER]: '1' },
  })
}

export async function createStudioApp(
  options: StudioAppOptions,
): Promise<StudioApp> {
  const studioOrigin = canonicalStudioOrigin(options.studioOrigin)
  const basePath = canonicalStudioBasePath(options.basePath)
  const sessions = createSessionManager(
    options.sessionSecret,
    options.now,
    basePath,
  )
  const transactions = createEntraTransactionManager(
    options.sessionSecret,
    basePath,
    options.now,
  )
  const backend = createAuthenticationBackend({
    store: options.accountStore,
    sessions,
  })
  const identityProvider = options.identityProvider
  const callbackUri = new URL(
    studioPath(basePath, '/auth/callback'),
    studioOrigin,
  ).href
  const signedOutUri = new URL(
    studioPath(basePath, '/auth/signed-out'),
    studioOrigin,
  ).href
  const allowViteDevelopmentAssets = options.viteDevelopmentAssets ?? false
  const dispatcher =
    options.apiDispatcher ??
    (allowViteDevelopmentAssets
      ? dispatchDevelopmentApiRequest
      : dispatchApiRequest)
  const researcherProjectStore =
    options.researcherProjectStore ?? createResearcherProjectStore
  const clientHandler = options.clientHandler ?? defaultClientHandler
  const verifyRequestPeer = options.requestPeer
  const gate = createSessionGate({
    backend,
    clearSessionCookie: () => sessions.clear(),
  })
  const app = new Hono<StudioEnvironment>()

  app.onError((error) => authErrorResponse(error))

  app.use('*', async (context, next) => {
    verifyRequestPeer?.(context.env)
    enforceCanonicalOrigin(context.req.raw, studioOrigin)
    await next()
  })

  const authGuard: MiddlewareHandler<StudioEnvironment> = async (
    context,
    next,
  ) => {
    const decision = await gate.api(context.req.raw)
    if (decision.verdict === 'bypass') {
      await next()
      return
    }
    if (decision.verdict === 'deny')
      return authenticationRequired(decision.setCookie)

    context.set('authentication', decision.authentication)
    await next()
  }
  app.use('/api', authGuard)
  app.use('/api/*', authGuard)

  const generalBodyLimit: MiddlewareHandler<StudioEnvironment> = bodyLimit({
    maxSize: GENERAL_API_REQUEST_LIMIT,
    onError: bodyTooLarge,
  })
  const ingestionBodyLimit: MiddlewareHandler<StudioEnvironment> = bodyLimit({
    maxSize: SOURCE_DOCUMENT_INGESTION_REQUEST_LIMIT,
    onError: bodyTooLarge,
  })
  const apiBodyLimit: MiddlewareHandler<StudioEnvironment> = (context, next) =>
    (isSourceDocumentIngestionPath(new URL(context.req.url).pathname)
      ? ingestionBodyLimit
      : generalBodyLimit)(context, next)
  app.use('/api', apiBodyLimit)
  app.use('/api/*', apiBodyLimit)

  app.get('/api/auth/session', async (context) => {
    const inspected = await gate.session(context.req.raw)
    const response = noStoreResponse(Response.json(inspected.view))
    return inspected.setCookie
      ? withCookie(response, inspected.setCookie)
      : response
  })

  app.get('/api/healthz', () => healthResponse())

  app.all('/api/auth/:operation', (context) => {
    const operation = context.req.param('operation')
    return operation === 'session'
      ? methodNotAllowed('GET')
      : apiErrorResponse(new ApiError(404, 'not_found', 'API route not found.'))
  })

  app.get('/auth/login', async (context) => {
    if (context.req.query('fragmentCaptured') !== '1')
      return fragmentRelayPage(context.req.raw)
    const returnTo =
      validateLocalReturnPath(context.req.query('returnTo') ?? null) ??
      DEFAULT_RETURN_PATH
    const created = transactions.create(returnTo)
    try {
      const location = await identityProvider.authorizationUrl({
        redirectUri: callbackUri,
        state: created.transaction.state,
        nonce: created.transaction.nonce,
        codeChallenge: created.codeChallenge,
        testIdentity: context.req.query('testIdentity'),
      })
      return externalRedirect(location, [
        created.setCookie,
        signedOutCookie(basePath, true),
      ])
    } catch {
      return authenticationFailurePage(
        basePath,
        transactions.clear(),
        503,
      )
    }
  })

  app.get('/auth/callback', async (context) => {
    const url = new URL(context.req.url)
    const stateValues = url.searchParams.getAll('state')
    const codeValues = url.searchParams.getAll('code')
    const transaction =
      stateValues.length === 1 && codeValues.length === 1
        ? transactions.verify(context.req.raw, stateValues[0])
        : null
    if (
      !transaction ||
      codeValues[0] === '' ||
      url.searchParams.has('error')
    )
      return authenticationFailurePage(basePath, transactions.clear())

    try {
      const identity = await identityProvider.redeemAuthorizationCode({
        redirectUri: callbackUri,
        code: codeValues[0],
        codeVerifier: transaction.codeVerifier,
      })
      // FREE owns nonce validation. Token redemption alone is not authority
      // for binding this response to the initiating browser transaction.
      if (!timingSafeStringEqual(transaction.nonce, identity.nonce))
        return authenticationFailurePage(basePath, transactions.clear())
      const result = await backend.signIn(identity)
      return externalRedirect(studioPath(basePath, transaction.returnTo), [
        transactions.clear(),
        signedOutCookie(basePath, true),
        result.sessionCookie,
      ])
    } catch (error) {
      return authenticationFailurePage(
        basePath,
        transactions.clear(),
        error instanceof ApiError && error.status === 503 ? 503 : 400,
      )
    }
  })

  app.post('/auth/logout', () =>
    externalRedirect(identityProvider.logoutUrl(signedOutUri), [
      transactions.clear(),
      sessions.clear(),
      signedOutCookie(basePath),
    ]),
  )

  app.on(['GET', 'HEAD'], '/auth/signed-out', (context) =>
    clientHandler(context.req.raw),
  )

  app.all('/auth/:operation', (context) => {
    const operation = context.req.param('operation')
    const allow = AUTH_METHOD[operation]
    return allow
      ? methodNotAllowed(allow)
      : apiErrorResponse(new ApiError(404, 'not_found', 'Page not found.'))
  })

  const scopedDispatch = (context: Context<StudioEnvironment>) => {
    const state = context.get('authentication')
    return dispatcher(
      context.req.raw,
      researcherProjectStore(state.account.id),
    )
  }
  app.all('/api', scopedDispatch)
  app.all('/api/*', scopedDispatch)

  app.all('*', async (context) => {
    const request = context.req.raw
    const url = new URL(request.url)
    if (url.pathname === '/login' || url.pathname === '/change-password')
      return apiErrorResponse(new ApiError(404, 'not_found', 'Page not found.'))
    if (
      publicAsset(request, allowViteDevelopmentAssets) ||
      url.pathname === '/auth/signed-out'
    )
      return clientHandler(request)
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return apiErrorResponse(new ApiError(404, 'not_found', 'Page not found.'))

    const decision = await gate.page(request)
    if (decision.verdict === 'deny') {
      // Network Back reaches the server before the signed-out SPA can run.
      if (hasSignedOutCookie(request))
        return redirect(basePath, '/auth/signed-out#', decision.setCookie)
      const { path, returnTo } = decision.redirectTo
      return redirect(
        basePath,
        returnTo === undefined
          ? path
          : `${path}?${new URLSearchParams({ returnTo })}`,
        decision.setCookie,
      )
    }
    return clientHandler(request)
  })

  if (basePath === '/') return app

  const publicApp = new Hono<StudioEnvironment>()
  publicApp.onError((error) => authErrorResponse(error))
  publicApp.all('*', (context) => {
    const request = internalStudioRequest(context.req.raw, basePath)
    return request
      ? app.fetch(request, context.env)
      : apiErrorResponse(new ApiError(404, 'not_found', 'Page not found.'))
  })
  return publicApp
}

function internalStudioRequest(
  request: Request,
  basePath: string,
): Request | null {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return null
  const pathname = stripStudioBasePath(basePath, url.pathname)
  if (pathname === null) return null
  url.pathname = pathname

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }
  return new Request(url, init)
}

function nodeRequest(request: IncomingMessage, studioOrigin: string): Request {
  const headers = new Headers()
  for (const [key, values] of Object.entries(request.headers)) {
    if (key.startsWith(':')) continue
    for (const value of Array.isArray(values)
      ? values
      : values === undefined
        ? []
        : [values])
      headers.append(key, value)
  }

  const method = request.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request) as unknown as RequestInit['body']
    init.duplex = 'half'
  }
  return new Request(new URL(request.url ?? '/', studioOrigin), init)
}

export async function sendNodeResponse(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  outgoing.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') outgoing.setHeader(key, value)
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) outgoing.setHeader('set-cookie', cookies)
  if (!response.body) {
    outgoing.end()
    return
  }

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(response.body!)
    stream.once('error', reject)
    outgoing.once('finish', resolve)
    outgoing.once('error', reject)
    stream.pipe(outgoing)
  })
}

export async function handleStudioNodeRequest(
  app: StudioApp,
  studioOrigin: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<boolean> {
  const response = await app.fetch(nodeRequest(incoming, studioOrigin), {
    incoming,
    outgoing,
    clientAddress: normalizeClientAddress(incoming.socket.remoteAddress),
  })
  if (response.headers.get(VITE_CLIENT_FALLBACK_HEADER) === '1') return false
  await sendNodeResponse(response, outgoing)
  return true
}
