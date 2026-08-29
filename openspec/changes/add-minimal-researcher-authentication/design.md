## Context

See `proposal.md` for motivation. Studio currently runs browser API handlers through Vite development middleware, mounts the project application immediately, and calls a global ProjectStore whose public methods do not carry an authenticated principal. The PostgreSQL contract contains an unused integer-keyed `User`, while `ProjectContext` has no owner. Source artifacts are deployment-wide and content-addressed, and background job pumps legitimately scan durable work across all Project Contexts.

The private deployment will run on one LAN or VPN, terminate HTTPS at Caddy with a certificate supplied by the actual VPN or institution, and run one Studio application process. Existing PostgreSQL and artifact data may be discarded. Model Connections, Capability Routes, and credential storage remain deployment-wide shared state.

Several active changes also touch ProjectStore and project descendants. This change must make authenticated ownership the outer boundary without confusing it with existing aggregate-level terms such as schema, occurrence, package, or lease ownership.

## Goals / Non-Goals

**Goals:**

- Establish one production Studio request boundary for authentication, authorization, API dispatch, and SPA serving.
- Keep Researcher Account lifecycle and session revocation small enough for a known private group.
- Make account ownership mandatory and difficult for request handlers to omit.
- Preserve global physical artifacts and trusted cross-account worker scheduling without exposing global data access to HTTP code.
- Produce a deterministic empty database and deployment bootstrap path.

**Non-Goals:**

- Public registration, emailed invitations, self-service recovery, administrator UI, roles, MFA, OIDC, account sharing, team workspaces, or Project Context collaboration.
- Per-researcher Model Connections, credentials, Capability Routes, or model quotas.
- Persistent individual sessions, remembered devices, per-device revocation, durable brute-force counters, or multiple Studio replicas.
- Migrating existing Project Contexts, accounts, artifacts, or migration history into the authenticated deployment.
- Authenticating Parsing Service task APIs with browser cookies.

## Decisions

### Use a Hono Node host around the existing Web handlers

Add `hono` and `@hono/node-server` as direct Studio runtime dependencies. A new Studio server composition root will own middleware and route order, invoke existing method-named API exports with Web `Request` objects, serve the built client assets, and return `index.html` only for authenticated non-API application navigation.

Extract the current route grammar into one production-safe dispatcher backed by an eager Vite module registry. Both Vite development middleware and the production host will call the same Hono application, preventing authentication or route drift. Unknown `/api` paths remain JSON 404/405 responses and never fall through to SPA HTML. Preserve route-specific ingestion limits and introduce a small general body limit at this host boundary.

Build the React client and a Node server bundle separately with Vite; this is server bundling, not React server rendering. Static resolution is rooted from the built server location rather than the process working directory. Hashed assets are immutable, while `index.html` is not cached.

Alternatives considered:

- Keep Vite's development server in production: rejected because the repository explicitly treats it as a local prototype and it has no durable authentication or production static boundary.
- Use native `node:http`: rejected because safe static serving, routing, body limits, cookies, and origin middleware would become local infrastructure code.
- Add Express or Fastify: rejected because their request/response conventions require more adaptation around the existing Web-standard handlers.

### Replace the unused User with a minimal Researcher Account

The database contract will replace `User` with `ResearcherAccount`:

- UUID `id`
- case-insensitive unique normalized `email`
- versioned `passwordHash`
- `mustChangePassword`
- nullable `disabledAt`
- integer `sessionVersion`
- creation and update timestamps

`ProjectContext` will have a required indexed `researcherAccountId` foreign key with deletion restricted. Account deletion is not an application operation; disablement preserves research data. There is no Workspace or membership table, and descendants do not duplicate the account ID.

Alternatives considered:

- Adapt the unused integer-keyed `User`: rejected because it has no runtime use or compatible ownership/authentication contract.
- Add `UserProjectContext`: rejected because it models many-to-many membership that the product explicitly does not support.
- Copy the account ID to every descendant: rejected because it creates multiple ownership truths and harder consistency rules.

### Bind request-facing data access to one account

Construct a researcher-scoped ProjectStore/capability with one `researcherAccountId` rather than passing an optional owner argument to individual methods. All request-facing project, child, review, reopen, batch, retry, result, and artifact queries prove ownership through the root Project Context. Cross-owner identifiers preserve the existing missing/not-found shapes.

Create a separate narrow internal worker capability for global claim/lease/execution and reference checks. HTTP handlers cannot obtain that interface. A worker's durable claimed operation and lease bound its subsequent access. Physical artifact packages remain shared, but descriptors and streams require an account-scoped database relationship; cleanup keeps a package while any reference remains.

Alternatives considered:

- Check ownership after an unscoped lookup: rejected because a missed check becomes a direct-object-reference vulnerability.
- Leave the full global ProjectStore injectable everywhere: rejected because type-level availability makes accidental HTTP use likely.

### Use local scrypt passwords and CLI lifecycle operations

Use Node's built-in `crypto.scrypt` with a random salt and a versioned self-describing encoding containing explicit cost parameters. Bound accepted password size, use constant-time comparison, and verify invalid/disabled logins against a valid dummy representation to reduce account-enumeration timing. The initial policy accepts 15–128 Unicode scalar values without Unicode normalization, composition, or periodic-rotation rules.

Build CLI commands for `create`, `reset-password`, and `disable` on the same account store and hashing module used by Studio. Passwords are read interactively or from standard input, never command-line arguments. Create/reset sets `mustChangePassword` and increments `sessionVersion`; disable sets `disabledAt` and increments it. No account is created by migration, seed, default password, or environment variable.

Alternatives considered:

- Argon2 dependency: omitted to keep the minimal deployment on Node built-ins; scrypt remains a memory-hard password derivation function.
- Invitation/reset tokens and account UI: omitted because deployment operators can provision the small known group through an existing trusted channel.

### Use stateless signed cookies with global account revocation

Require `FREE_SESSION_SECRET` as canonical base64 that decodes to at least 32 random bytes and require a configured canonical HTTPS `STUDIO_ORIGIN`. Reject malformed, non-canonical, or undersized secrets before listening. Sign a versioned cookie payload with HMAC-SHA-256. The payload contains only account ID, captured `sessionVersion`, original issue time, and expiry; it is signed but not encrypted. Every request loads the current account and rejects disabled or version-mismatched sessions.

Use `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`. Authenticated activity may renew the 12-hour idle expiry without moving the original issue time beyond the 7-day absolute expiry. Secret replacement logs out every account. Logout clears that browser cookie; reset and disable increment `sessionVersion` to revoke all cookies for that account.

Accounts with `mustChangePassword` may reach only session inspection, password change, and logout. Password change verifies the current password, stores the replacement, clears the flag, increments the version, clears the temporary cookie, and requires a new normal login.

Alternatives considered:

- Database session rows: omitted because individual device tracking and revocation are not required; one account version gives the needed reset/disable boundary.
- Unsigned identity cookies or a proxy identity header: rejected because neither supplies an application-owned integrity and revocation boundary.

### Enforce origin, login throttling, and deny-by-default routing centrally

Unsafe methods require an exact `Origin` match to `STUDIO_ORIGIN`; the trusted origin is never derived from `Host` or forwarded headers. SameSite remains defense in depth. A bounded pruned in-memory limiter tracks failures by normalized email and client address before expensive password work, returns a generic retry response, and clears on restart.

In the hosted topology, Caddy and Studio share a dedicated proxy network containing no other service. Caddy discards any inbound `X-Real-IP` value and sets that header from its direct client socket. Studio accepts the header only in hosted mode on that dedicated boundary and fails startup if the proxy contract is not enabled; explicit loopback development uses the direct socket address instead. This keeps per-client throttling useful without trusting browser-supplied forwarding headers.

Public Studio routes are limited to login/session establishment, required static assets, and shallow `GET /api/healthz`. Protected APIs return JSON 401. Protected document navigation redirects to login with a validated local return path. The frontend resolves session state before mounting `ProjectNavigationProvider`, and a shared authenticated-fetch wrapper converts later 401 responses into a login transition. Production omits the LLM inspector.

The Parsing Service remains private on the Compose network and is called server-to-server; Studio does not forward browser session cookies to it.

### Keep model configuration shared and serialize writes

Every authenticated researcher retains the existing provider-configuration UI and can view credential presence, probe connections, and replace the deployment-wide Model Connections and Capability Routes. Credential values remain write-only and stored through the existing credential-store boundary.

The one Studio process serializes full-document configuration writes. Each write remains atomic; the later completed document wins without merging fields. This is the smallest consistent behavior when multiple trusted researchers can open the same shared editor.

### Rebaseline the database and bootstrap a new deployment

Because existing data may be discarded, replace obsolete migration histories with one final baseline from an empty database. The baseline directly creates `ResearcherAccount`, required Project Context ownership, and the rest of the final contract; it contains no nullable transition, reserved owner, backfill, sample data, or compatibility edge. Remove the obsolete seed path or separate any developer fixtures from production setup.

Hosted startup will replay authored migrations instead of using `db:update`. The first Researcher Account is created explicitly through the CLI before login. Existing database and artifact volumes are backed up if desired and then recreated; they are not read by the new deployment.

### Put Caddy at the only host-facing network boundary

Caddy is the only service that publishes a host port. Studio joins a dedicated Caddy–Studio proxy network and a separate internal application network; PostgreSQL and Parsing Service join only internal networks and publish no host port. Caddy loads an institution/VPN-supplied certificate and private key from a read-only mount and proxies to Studio over the dedicated network. There is no public ACME flow, internal certificate authority, self-signed fallback, or plain-HTTP authentication path.

The infrastructure operator owns renewal. Replacing PEM files is followed by validation and a forced Caddy reload; FREE documents but does not automate that institutional process. Studio runs one Node application process because the login limiter and some existing job coordination are process-local.

## Risks / Trade-offs

- [Every authenticated researcher can alter shared model routes and credentials] → Limit deployment membership to the known trusted group and keep credential values write-only; add roles only if a real operational need appears.
- [A stolen signed cookie remains valid until expiry or account-wide revocation] → Use Secure/HttpOnly/Strict cookies, exact-origin writes, short idle renewal, and `sessionVersion` reset/disable revocation.
- [In-memory throttling resets on restart and cannot coordinate replicas] → Declare and enforce a single Studio process for this deployment.
- [Shared content-addressed packages can reveal data if a child-ID endpoint bypasses ownership] → Require researcher-scoped store APIs and explicit cross-account tests for every direct-ID route.
- [Active changes alter the same ProjectStore and migration surfaces] → Land or rebase against their final aggregate APIs, remove unscoped call sites rather than maintaining overloads, and run their lifecycle suites after each ownership layer.
- [A missing or mismatched canonical origin/certificate makes login unusable] → Validate required runtime configuration before listening and provide a deployment smoke check through Caddy.
- [Discarding old volumes is irreversible] → Stop services and take optional database/artifact backups before recreating volumes; never point the new baseline at a database that must be preserved.
- [The current OS keyring integration may require helper processes in the container] → “One process” applies to the Studio Node application replica; retain the established credential-store runtime until model credential architecture is changed separately.

## Migration Plan

1. Stop the current local stack and optionally back up PostgreSQL and Studio artifact/config volumes.
2. Land the final Prisma contract and single clean migration baseline; remove obsolete migration and production seed paths.
3. Build the production Studio client/server image and Caddy gateway configuration.
4. Recreate the intended deployment volumes and run authored migrations against the empty database.
5. Run the account CLI to create the first Researcher Account and temporary password.
6. Mount the institution/VPN certificate pair, configure `STUDIO_ORIGIN` and `FREE_SESSION_SECRET`, and start the single-replica stack.
7. Log in through Caddy, change the temporary password, configure shared Model Connections, and validate Project Context isolation with two test accounts.

Rollback requires stopping the new stack and restoring the previous image plus its backed-up database/artifact/config volumes. There is no mixed-version or in-place data rollback path.
