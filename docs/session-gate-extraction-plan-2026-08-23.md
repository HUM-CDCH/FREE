# Session gate extraction — implementation plan

Date: 2026-08-23 · Status: approved, not started · Provenance: architecture review candidate #1 ("One session gate instead of three re-encoded outcomes"), revised twice under review. Supersedes all earlier plan drafts in conversation history.

Any agent may implement this plan commit-by-commit. Line references are pre-change anchors against `prototypes/studio/server/app.ts` (#CC59) and `prototypes/studio/server/auth.ts` (#61B7); re-read before editing.

## 0. Ground rules

- Three commits, in order, each independently green. Commit 1 is behavior-preserving; Commit 2 contains every intended behavior change; Commit 3 is an isolated contract test plus schema relocation. Do not mix policy changes into Commit 1.
- All work lives under `prototypes/studio/`.
- Test command from `prototypes/studio/`: `pnpm exec vitest run <path>` (full suite: `pnpm test`).
- Hono facts relied on (verified empirically): `HEAD` matches `GET` routes while middleware sees the original method string; `app.all('*')` matches every method; thrown handler errors skip middleware code after `await next()`.

## 1. Current state (what exists today)

Three call sites re-encode consequences of `backend.inspect()` (`server/auth.ts:141–170`, returns `AuthenticationState` = `{authenticated:false, clearCookie}` | `{authenticated:true, account, renewalCookie}`):

**a) authGuard middleware — `app.ts:337–368`**

```ts
const authGuard: MiddlewareHandler<StudioEnvironment> = async (context, next) => {
  const request = context.req.raw
  const pathname = new URL(request.url).pathname
  if (PUBLIC_API[`${request.method} ${pathname}`]) { await next(); return }
  const state = await backend.inspect(request)
  if (!state.authenticated)
    return authenticationRequired(state.clearCookie ? sessions.clear() : undefined)
  if (state.account.mustChangePassword && MANDATORY_CHANGE_API[pathname] !== true)
    return passwordChangeRequired()
  context.set('authentication', state)
  await next()
  if (pathname !== '/api/auth/password' && pathname !== '/api/auth/logout')
    context.res = withCookie(context.res, state.renewalCookie)
}
app.use('/api', authGuard); app.use('/api/*', authGuard)
```

Note the renewal suppression is **pathname-based and method-blind** — it also suppresses renewal on wrong-method 405s for those two paths.

**b) Session route — `app.ts:406–412`** (public, so guard skipped; inspects again)

```ts
app.get('/api/auth/session', async (context) => {
  const state = await backend.inspect(context.req.raw)
  let response = noStoreResponse(Response.json(sessionView(state)))
  if (state.authenticated) response = withCookie(response, state.renewalCookie)
  else if (state.clearCookie) response = withCookie(response, sessions.clear())
  return response
})
```

**c) Catch-all HTML path — `app.ts:458–484`** (inspects a third time)

```ts
app.all('*', async (context) => {
  const request = context.req.raw
  const url = new URL(request.url)
  if (publicAsset(request, allowViteDevelopmentAssets) || url.pathname === '/login')
    return clientHandler(request)
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return apiErrorResponse(new ApiError(404, 'not_found', 'Page not found.'))
  const state = await backend.inspect(request)
  if (!state.authenticated) {
    const returnTo = `${url.pathname}${url.search}`
    return redirect(basePath, `/login?${new URLSearchParams({ returnTo })}`,
      state.clearCookie ? sessions.clear() : undefined)
  }
  if (state.account.mustChangePassword && url.pathname !== '/change-password')
    return redirect(basePath, '/change-password', state.renewalCookie)
  return withCookie(await clientHandler(request), state.renewalCookie)
})
```

Policy tables and deny responders, all module-private to app.ts today (no external consumers):

| Symbol | Lines | Fate |
|---|---|---|
| `PUBLIC_API` (`GET /api/healthz`, `GET /api/auth/session`, `POST /api/auth/login`) | 49–53 | moves into gate |
| `MANDATORY_CHANGE_API` (`/api/auth/session`, `/api/auth/password`, `/api/auth/logout`) | 60–64 | moves into gate |
| `authenticationRequired(clearCookie?)` → 401 JSON no-store | 195–206 | stays in app.ts (decoration) |
| `passwordChangeRequired()` → 403 JSON no-store | 208–218 | stays in app.ts |
| `redirect(basePath, location, cookie?)` → 302 | 266–279 | stays in app.ts |
| `AUTH_METHOD` (login POST, session GET, password POST, logout POST → 405 handler at 440–446) | 54–59 | stays (routing) |

Other fixed context: `withCookie` (175–183), `noStoreResponse` (185–193), `sessionView(state)` exported from `auth.ts:114–124`, protected dispatch reads `context.get('authentication')` at `app.ts:448–456`, origin middleware at 331–335 runs before the guard, body-limit middleware after it (auth precedes body admission, pinned by existing test).

## 2. Target design

New file `prototypes/studio/server/sessionGate.ts`. Hono-free and Response-free (Fetch `Request` in; semantic decisions plus serialized Set-Cookie strings out). It is deliberately **not** claimed "transport-neutral" — it is Hono-neutral / Response-neutral. It imports only from `./auth` (types) — never `./app`, never `../api/_http`.

```ts
import type { AuthenticatedState, AuthenticationBackend, SessionView } from './auth.js'

export type SessionGateProceed = {
  verdict: 'proceed'
  authentication: AuthenticatedState
  setCookie?: string
}

// Ratified post-review (was a single SessionGateDecision union): the split makes
// page-denial `redirectTo` REQUIRED — page denials always redirect; API denials never do.
export type SessionGateApiDecision =
  | { verdict: 'bypass' }   // public API route: no inspection, no cookies, caller MUST NOT set an authentication variable
  | SessionGateProceed
  | {
      verdict: 'deny'
      reason: 'unauthenticated' | 'passwordChangeRequired'
      setCookie?: string // clear-cookie value on unauthenticated; renewal value where the matrix says R
    }

export type SessionGatePageDecision =
  | SessionGateProceed
  | {
      verdict: 'deny'
      reason: 'unauthenticated' | 'passwordChangeRequired'
      redirectTo: { path: '/login' | '/change-password'; returnTo?: string }
      setCookie?: string // clear-cookie value on unauthenticated; renewal value where the matrix says R
    }

export function createSessionGate(deps: {
  backend: Pick<AuthenticationBackend, 'inspect'>
  clearSessionCookie(): string
 }): {
  api(request: Request): Promise<SessionGateApiDecision>
  page(request: Request): Promise<SessionGatePageDecision>
  session(request: Request): Promise<{ view: SessionView; setCookie?: string }>
}
```

Invariants the gate owns:

- Public classification is method-keyed exactly as `PUBLIC_API` today (`bypass`). Consequence preserved: `HEAD` variants of public GETs are **not** public.
- `session()` maps inspect result → `{ view, setCookie }` where `setCookie` = renewal when authenticated, else clear-cookie when `clearCookie`, else absent. Returns data; JSON serialization stays in the route.
- `proceed.setCookie` on the API surface implements the renewal-suppression rule (see §4: pathname-based in Commit 1, exact method+path pairs from Commit 2). On the page surface, `proceed.setCookie` is always the renewal value.
- Page denials always carry `redirectTo`; unauthenticated page denial sets `returnTo` from `${pathname}${search}`, password-pending page denial targets `/change-password` **without** `returnTo` (preserves current behavior).
- No method catches anything: store failure inside `inspect` throws `ApiError(503, 'authentication_unavailable')` through to `app.onError` → JSON 503 no-store, no Set-Cookie, on all three surfaces.

### app.ts rewiring (all three call sites become glue)

- Guard: `const d = await gate.api(req)` → `bypass`: `await next(); return` · `deny`: return `authenticationRequired(d.setCookie)` / `passwordChangeRequired(d.setCookie)` · `proceed`: `context.set('authentication', d.authentication)`, `await next()`, then `if (d.setCookie) context.res = withCookie(context.res, d.setCookie)`. `passwordChangeRequired()` gains an optional cookie parameter (it has none today).
- Session route: `const r = await gate.session(req)`; build `noStoreResponse(Response.json(r.view))`; append `r.setCookie` when present.
- Catch-all: keep asset/login-page bypass and non-GET 404 exactly where they are; replace the inspect block with `gate.page` → `deny`: `redirect(basePath, studioPath target (+ returnTo query), d.setCookie)` · `proceed`: `clientHandler(request)` with optional `withCookie`.
- Delete from app.ts after rewiring: `PUBLIC_API`, `MANDATORY_CHANGE_API`, and the guard's inline branches. Keep `AUTH_METHOD`, `publicAsset`, all response helpers.
- Post-condition greps: `inspect(` appears only in `server/auth.ts` and `server/sessionGate.ts`; `PUBLIC_API|MANDATORY_CHANGE_API` appear nowhere in app.ts.

## 3. Table A — API surface, current behavior (Commit 1 pins)

Legend: 401 = `authentication_required` · 403 = `password_change_required` · R = renewal appended · C = clear cookie appended · – = unreachable (bypass skips inspection). HEAD rows record status + headers only (Hono strips bodies). "stale" = cookie present but invalid/expired/disabled/version-mismatched.

| # | Request | Anon clean | Anon stale | Authenticated | Password-pending |
|---|---|---|---|---|---|
| A1 | `GET /api/healthz` | bypass → 200 | – | 200 | 200 |
| A2 | `HEAD /api/healthz` | 401 (+C) | 401+C | 200, health headers, +R | 403, no R — **⚠C2: +R** (corrected post-review: the pwd-pending denial was mis-derived as 200; the guard denies every non-escape path) |
| A3 | `POST /api/auth/login` | bypass → 200 + session cookie (handler-owned) | ← | ← | ← |
| A4 | other × `/api/auth/login` | 401 (+C) | 401+C | 405 `Allow: POST` +R | 403, no R — **⚠C2: +R** |
| A5 | `GET /api/auth/session` | 200 `{authenticated:false}`, no cookie | 200 `{false}` +C | 200 view +R | 200 view +R (UI discovery channel) |
| A6 | `HEAD /api/auth/session` | 401 (+C) | 401+C | 200, empty body, +R, **two inspections** | same, two inspections |
| A7 | other × `/api/auth/session` | 401 (+C) | 401+C | 405 `Allow: GET` +R | 405 `Allow: GET` +R (this is why `MANDATORY_CHANGE_API['session']` is live, not dead) |
| A8 | `POST /api/auth/password` | 401 (+C) | 401+C | 204 + clear (handler-owned; suppression prevents double cookie) | 204 + clear |
| A9 | other × `/api/auth/password` | 401 (+C) | 401+C | 405 `Allow: POST`, **no R** (pathname suppression) | 405, no R — **⚠C2: +R** |
| A10 | `POST /api/auth/logout` | 401 (+C) | 401+C | 204 + clear (handler-owned) | **204 + clear** — logout is already permitted while password change is pending |
| A11 | other × `/api/auth/logout` | 401 (+C) | 401+C | 405 `Allow: POST`, **no R** | 405, no R — **⚠C2: +R** |
| A12 | unknown `/api/auth/*` op, any method | 401 (+C) | 401+C | 404 route-not-found +R | 403, no R — **⚠C2: +R** |
| A13 | protected business APIs, any method (`/api/project-contexts*`, schemas, ingestion, bare `/api`) | 401 (+C) | 401+C | dispatch result +R (returned error responses included) | 403, no R — **⚠C2: +R** |

Error rows: whenever a cell involves `inspect`, store failure yields JSON 503 no-store via `onError` with **no** Set-Cookie — including the *second* of A6's two inspections.

Renewal by failure site (corrected post-review, empirically pinned): Hono resolves `onError` and **resumes middleware after `next()`**, so handler errors thrown downstream of the guard still receive the renewal append — same as returned error responses. Only failures thrown *inside the guard itself* (inspection-time 503s) abort the middleware before the append and carry no cookie.

## 4. Table B — page surface, current behavior (Commit 1 pins; unchanged by C2)

| # | Request | Anon clean | Anon stale | Authenticated | Password-pending |
|---|---|---|---|---|---|
| B1 | `GET/HEAD` assets (`/assets/*`, public files, Vite dev assets) | clientHandler; no inspect; no cookies | ← | ← | ← |
| B2 | any method × `/login` (checked before the non-GET 404!) | clientHandler; zero session involvement — even `POST /login` | ← | ← | ← |
| B3 | non-GET/HEAD × other pages | 404 JSON, pre-inspect | ← | ← | ← |
| B4 | `GET/HEAD` pages incl. deep links | 302 `/login?returnTo=<path+search>`, no cookie | 302 + clear | clientHandler +R | `/change-password`: clientHandler +R · elsewhere: 302 `/change-password` +R (**no `returnTo`**) |

Inspect-store-failure on B4 → JSON 503 (JSON body on the HTML surface — preserve verbatim).

## 5. Commit 2 policy specification

1. Escape set stays path-only and includes logout (already does — do not "add" it).
2. **Renewal on all `password_change_required` denials**: flips A2 (pwd-pending cell), A4, A12, A13 to 403 +R. Implementation: `deny.passwordChangeRequired` on the API surface carries the renewal value.
3. **Suppression narrowed to handler-owned pairs**: from `pathname !== '/api/auth/password' && pathname !== '/api/auth/logout'` to `!(method === 'POST' && (pathname === '/api/auth/password' || pathname === '/api/auth/logout'))`. Flips A9 and A11 to 405 +R **for authenticated and password-pending alike**; A8/A10 remain handler-owned 204 + clear.
4. Inspection-time failures (503s) continue to carry no renewal. Handler-thrown errors DO renew: Hono resumes middleware after `onError`, so the post-`next()` append still runs.

Post-C2 invariant: every response produced while a valid session exists carries renewal, except the two owned pairs (`POST /api/auth/password`, `POST /api/auth/logout`), unauthenticated denials (clear instead), inspection-time failures thrown inside the guard, and bypass routes.

## 6. Commits

### Commit 1 — characterization + extraction (zero intended behavior deltas)

Tasks, in order:

1. Create `prototypes/studio/server/sessionGate.test.ts` driving the new gate directly with a stub backend (`inspect` vi.fn) over the full Table A/B grid: every cell above, every ⚠C2 marker asserted at its **current** value. Include:
   - 503 propagation on session, protected-API, and page representatives (see fixture prerequisites below).
   - A6 asserting `findById`-equivalent called exactly twice, plus a variant where the first inspection succeeds and the second throws → decision path surfaces the throw.
   - Failure-site renewal pins: returned-error responses renew; handler-thrown errors renew (middleware resumes after `onError`); inspection-time 503s do not.
   - Cross-surface agreement checks: exactly one Set-Cookie per outcome; clear iff `clearCookie`.
2. Add app-level characterization pins to `server/app.test.ts` for cells nothing exercises end-to-end today (A2, A6, A9/A11-no-R, A4/A12/A13-403-no-R, B2-POST, B4-no-returnTo, the three 503 rows). These will be flipped in place in Commit 2.
3. Implement `server/sessionGate.ts` per §2 with Commit-1 rules: pathname-based suppression; API pwd-denials carry no cookie; page pwd-denials carry renewal.
4. Rewire guard, session route, catch-all (§2). Delete moved tables/branches. Update imports.
5. Run the suite.

Acceptance:
- Full studio suite green (`pnpm test` in `prototypes/studio`) with **no intentional expectation changes** beyond newly added pins.
- Greps per §2 post-conditions pass.
- Diff review shows no rule changes, only relocation.

Fixture prerequisites (so tests can't silently exercise the wrong path):
- 503 cases require a **cryptographically valid issued session cookie** (via the session manager's issue/serialize or a real login) whose account lookup rejects (mocked store). Clean-anonymous inspection never touches the store and cannot produce 503.
- Password-pending fixtures: account row with `mustChangePassword: true`, valid issued cookie.
- Stale-cookie cases: tamper the signature, or bump `sessionVersion`, or disable the account — each lands in the same observable cell; pick one and say which in the test name.

### Commit 2 — policy changes (behavior-changing; say so in the commit message)

1. In the gate: apply §5 items 2–3.
2. Flip the affected pins **in place** (both gate-grid expectations and the app-level characterization added in C1): A4, A12, A13 (+R); A9, A11 (+R, both authenticated columns too). Nothing else moves.
3. Run full suite.

Acceptance: green; diff contains exactly the two gate-rule changes and flipped expectations; commit message explicitly lists the behavior changes. The overall work is **not** behavior-neutral — the split exists precisely so this commit is auditable alone.

### Commit 3 — client/server session-view contract test (isolated)

1. Move the zod schemas (`anonymousSessionSchema`, `authenticatedSessionSchema`, `authSessionSchema`) from `src/auth/authApi.ts:4–22` to a new `prototypes/studio/shared/authSession.contract.ts` (repo pattern: `shared/schemaRevision.contract.ts`). Export schemas and inferred types there; `authApi.ts` imports them and keeps exporting the same type names it exports today (re-export) so component files don't change.
2. New `shared/authSession.contract.test.ts`: parse **real outputs of `server/auth.ts` `sessionView(state)`** — `{authenticated:false}` and `{authenticated:true, account:{id,email,mustChangePassword}}` with `mustChangePassword` both true and false — against the shared schema. Add one negative control asserting `.strict()` rejects an object with an extra account field (pins addition-detection, which is the drift direction strict mode exists for).

Acceptance: green standalone; no other suite affected; UI files untouched.

## 7. Explicitly out of scope (do not fold in)

- De-duplicating A6's double inspection (e.g. adding `HEAD /api/auth/*` mirrors to public classification): would flip anonymous HEAD cells 401→200-view and drop A2's authenticated R. Characterized as-is; needs its own signed-off policy change.
- `HEAD /api/healthz` anonymous 401 quirk (A2).
- Any "Sign out broken while password change pending" claim: withdrawn — logout already permitted (A10). If observed failing, diagnose separately.
- Body-limit ordering, origin enforcement, basePath/publicApp wrapper, login/logout/password handlers, client `authenticatedFetch`.
