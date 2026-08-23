import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  createResearcherProjectStore,
  type ResearcherAccountStore,
  type ResearcherProjectStore,
} from 'db'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ApiError,
  apiErrorResponse,
  parseJsonRequest,
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
  LoginThrottledError,
  sessionView,
  type AuthenticatedState,
  type PasswordOperations,
} from './auth.js'
import {
  createLoginLimiter,
  normalizeClientAddress,
  type LoginLimiter,
} from './login-limiter.js'
import {
  canonicalStudioOrigin,
  enforceCanonicalOrigin,
} from './origin.js'
import { createSessionManager } from './session.js'
import { createSessionGate } from './sessionGate.js'
import {
  canonicalStudioBasePath,
  studioPath,
  stripStudioBasePath,
} from '../shared/studioBasePath.js'

export const VITE_CLIENT_FALLBACK_HEADER = 'x-free-vite-client-fallback'
export const GENERAL_API_REQUEST_LIMIT = 1024 * 1024

const AUTH_METHOD: Readonly<Record<string, string>> = {
  login: 'POST',
  session: 'GET',
  password: 'POST',
  logout: 'POST',
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
  '/src/ui/Button.tsx': true,
  '/src/studioUrl.ts': true,
  '/shared/studioBasePath.ts': true,
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
  accountStore?: ResearcherAccountStore
  limiter?: LoginLimiter
  passwords?: PasswordOperations
  dummyPasswordHash?: string
  now?: () => number
  apiDispatcher?: ApiDispatcher
  researcherProjectStore?: (
    researcherAccountId: string,
  ) => ResearcherProjectStore
  clientHandler?: ClientHandler
  viteDevelopmentAssets?: boolean
  clientAddress?: (bindings: StudioBindings) => string
  requestPeer?: (bindings: StudioBindings) => void
}

type LoginBody = { email: string; password: string }
type PasswordBody = { currentPassword: string; newPassword: string }

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'invalid_request', 'The request body is invalid.')
  return value as Record<string, unknown>
}

function exactStringBody<T extends object>(
  value: unknown,
  fields: readonly (keyof T & string)[],
): T {
  const body = jsonObject(value)
  const keys = Object.keys(body)
  if (
    keys.length !== fields.length ||
    fields.some((field) => typeof body[field] !== 'string') ||
    keys.some((key) => !fields.includes(key as keyof T & string))
  )
    throw new ApiError(400, 'invalid_request', 'The request body is invalid.')
  return body as T
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

function passwordChangeRequired(cookie?: string): Response {
  const response = noStoreResponse(
    apiErrorResponse(
      new ApiError(
        403,
        'password_change_required',
        'Password change is required.',
      ),
    ),
  )
  return cookie ? withCookie(response, cookie) : response
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
  const response = noStoreResponse(apiErrorResponse(error))
  if (error instanceof LoginThrottledError)
    response.headers.set('Retry-After', String(error.retryAfterSeconds))
  return response
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

function clientAddressFromBindings(bindings: StudioBindings): string {
  return normalizeClientAddress(
    bindings.clientAddress ?? bindings.incoming?.socket.remoteAddress,
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
  const limiter = options.limiter ?? createLoginLimiter({ now: options.now })
  const backend = await createAuthenticationBackend({
    store: options.accountStore,
    sessions,
    limiter,
    passwords: options.passwords,
    dummyPasswordHash: options.dummyPasswordHash,
  })
  const allowViteDevelopmentAssets = options.viteDevelopmentAssets ?? false
  const dispatcher =
    options.apiDispatcher ??
    (allowViteDevelopmentAssets
      ? dispatchDevelopmentApiRequest
      : dispatchApiRequest)
  const researcherProjectStore =
    options.researcherProjectStore ?? createResearcherProjectStore
  const clientHandler = options.clientHandler ?? defaultClientHandler
  const resolveClientAddress = options.clientAddress ?? clientAddressFromBindings
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
      return decision.reason === 'unauthenticated'
        ? authenticationRequired(decision.setCookie)
        : passwordChangeRequired(decision.setCookie)

    context.set('authentication', decision.authentication)
    await next()
    if (decision.setCookie)
      context.res = withCookie(context.res, decision.setCookie)
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

  app.post('/api/auth/login', async (context) => {
    const body = exactStringBody<LoginBody>(
      await parseJsonRequest(context.req.raw),
      ['email', 'password'],
    )
    const result = await backend.login(
      body.email,
      body.password,
      resolveClientAddress(context.env),
    )
    const state: AuthenticatedState = {
      authenticated: true,
      account: result.account,
      renewalCookie: result.sessionCookie,
    }
    return withCookie(
      noStoreResponse(Response.json(sessionView(state))),
      result.sessionCookie,
    )
  })

  app.get('/api/auth/session', async (context) => {
    const inspected = await gate.session(context.req.raw)
    const response = noStoreResponse(Response.json(inspected.view))
    return inspected.setCookie
      ? withCookie(response, inspected.setCookie)
      : response
  })

  app.post('/api/auth/password', async (context) => {
    const body = exactStringBody<PasswordBody>(
      await parseJsonRequest(context.req.raw),
      ['currentPassword', 'newPassword'],
    )
    const state = context.get('authentication')
    await backend.changePassword(
      state.account,
      body.currentPassword,
      body.newPassword,
    )
    return withCookie(
      noStoreResponse(new Response(null, { status: 204 })),
      sessions.clear(),
    )
  })

  app.post('/api/auth/logout', () =>
    withCookie(
      noStoreResponse(new Response(null, { status: 204 })),
      sessions.clear(),
    ),
  )

  app.get('/api/healthz', () => healthResponse())

  app.all('/api/auth/:operation', (context) => {
    const operation = context.req.param('operation')
    const allow = AUTH_METHOD[operation]
    return allow
      ? methodNotAllowed(allow)
      : apiErrorResponse(new ApiError(404, 'not_found', 'API route not found.'))
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
    if (
      publicAsset(request, allowViteDevelopmentAssets) ||
      url.pathname === '/login'
    )
      return clientHandler(request)
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return apiErrorResponse(new ApiError(404, 'not_found', 'Page not found.'))

    const decision = await gate.page(request)
    if (decision.verdict === 'deny') {
      const { path, returnTo } = decision.redirectTo
      return redirect(
        basePath,
        returnTo === undefined
          ? path
          : `${path}?${new URLSearchParams({ returnTo })}`,
        decision.setCookie,
      )
    }
    const response = await clientHandler(request)
    return decision.setCookie
      ? withCookie(response, decision.setCookie)
      : response
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
