Each numbered section is a delivery layer and must leave the product working end to end. In particular, the required Project Context owner, scoped request wiring, clean migration baseline, and owner-aware fixtures in section 3 land as one cutover; do not land a required foreign key while request creation is still unscoped.

## 1. Account and Password Foundation

- [ ] 1.1 Replace the unused `User` contract with UUID `ResearcherAccount` fields for normalized email, versioned password hash, mandatory change, disablement, session version, and timestamps without yet changing Project Context creation.
- [ ] 1.2 Implement and unit-test canonical case-insensitive email normalization plus Researcher Account create, lookup, password-update, and disable persistence operations.
- [ ] 1.3 Implement and test the versioned Node `scrypt` representation with random salts, explicit costs, strict parsing, constant-time verification, and exact 15–128 Unicode-scalar validation without normalization.
- [ ] 1.4 Implement an account CLI that reads passwords without argv exposure and creates an account with a mandatory temporary-password change.
- [ ] 1.5 Add CLI reset-password and disable operations that increment `sessionVersion`, and test duplicate, missing-account, invalid-password, and failure exit behavior.
- [ ] 1.6 Wire root and Studio package scripts for running the account CLI against the selected database without creating default credentials.

## 2. First Working Authentication Slice

- [ ] 2.1 Add direct Hono Node dependencies and extract the existing API route grammar into one eager production-safe handler registry and dispatcher.
- [ ] 2.2 Build the Hono application composition root and make Vite development middleware call it so development and production share authentication, dispatch, and route ordering.
- [ ] 2.3 Implement signed cookie encode, verify, renew, and clear behavior with account ID, `sessionVersion`, 12-hour idle expiry, 7-day absolute expiry, and required cookie attributes.
- [ ] 2.4 Implement exact canonical-origin enforcement for unsafe methods and a bounded pruned login limiter keyed by normalized email and the trusted client address.
- [ ] 2.5 Implement generic-failure login with dummy password verification, session inspection, authenticated logout, and mandatory temporary-password change endpoints.
- [ ] 2.6 Implement authentication middleware that reloads the account on every request, rejects disabled or version-mismatched sessions, and limits mandatory-change accounts to password change, session inspection, and logout.
- [ ] 2.7 Apply the deny-by-default route boundary so only login/session establishment, required static assets, and shallow Studio health are public; keep Parsing Service browser-cookie-free.
- [ ] 2.8 Add session state, login, mandatory-password-change, and logout UI with validated local return paths, and gate `ProjectNavigationProvider` until authentication state resolves.
- [ ] 2.9 Add focused integration tests proving login, forced password change, logout, expiry, protected deep links, API 401 behavior, and the existing single-researcher project flow work together before proceeding to ownership cutover.

## 3. End-to-End Researcher Ownership Cutover

- [ ] 3.1 Introduce separate researcher-scoped and internal-worker ProjectStore interfaces so HTTP code cannot obtain global claim, lease, or reference operations.
- [ ] 3.2 Scope Project Context create, list, detail, rename, and delete queries to the bound Researcher Account and preserve not-found behavior across owners.
- [ ] 3.3 Scope Source Document ingestion, annotations, reopen, delete, canonical representation, download, and direct artifact lookup through the owning Project Context.
- [ ] 3.4 Scope Extraction Schema, Schema Revision, suggestion, and schema-editing persistence operations through the owning Project Context.
- [ ] 3.5 Scope Extraction, Extraction Result, review, retry, Batch Extraction, and Batch Schema Suggestion reads and mutations through the owning Project Context.
- [ ] 3.6 Keep package reference and cleanup logic deployment-wide internally while requiring an authorized database relationship before returning an artifact descriptor or stream.
- [ ] 3.7 Rewire job pumps and lease-based execution to the internal worker interface and prove request handlers cannot call system-scoped methods.
- [ ] 3.8 In the same cutover, add the required indexed `ProjectContext.researcherAccountId` relationship with restricted account deletion, regenerate Prisma artifacts, and construct the researcher-scoped store from authenticated middleware for every request-facing project operation.
- [ ] 3.9 Rebuild migration history as one clean empty-database baseline with no accounts, projects, nullable ownership transition, sample data, seed behavior, or compatibility path; fresh setup replays authored migrations.
- [ ] 3.10 Update ProjectStore fixtures, DTOs, and lifecycle integrations to create explicit account-owned Project Contexts without compatibility overloads.
- [ ] 3.11 Add two-account API coverage proving account A cannot list, read, annotate, mutate, execute, review, retry, reopen, or stream any identifier rooted in account B, including mixed-owner identifier combinations.
- [ ] 3.12 Add cross-account physical-package tests proving authorized identical-content access and reference-safe cleanup without metadata disclosure.

## 4. Production Studio Host

- [ ] 4.1 Complete JSON API 404/405 behavior, route-specific and general body limits, shallow health, static assets, and authenticated SPA fallback in the shared Hono application.
- [ ] 4.2 Add separate Vite client and Node-server builds, production static cache policy, and a single-process server entrypoint with graceful shutdown.
- [ ] 4.3 Validate canonical HTTPS `STUDIO_ORIGIN`, a decoded `FREE_SESSION_SECRET` of at least 32 bytes, and the hosted proxy contract before listening, allowing only explicit loopback development exceptions.
- [ ] 4.4 Remove the production LLM inspector route and verify unknown API paths never fall through to SPA HTML.

## 5. Authenticated Studio Experience

- [ ] 5.1 Gate all Project Context loading until authentication and mandatory-password state resolve, including stale cross-account route identifiers.
- [ ] 5.2 Add a shared same-origin API fetch wrapper that turns HTTP 401 into an authentication transition and migrate scattered Studio API clients to it.
- [ ] 5.3 Add focused frontend tests for login failures, mandatory-password gating, logout, expired sessions, protected deep links, and stale cross-account route identifiers.

## 6. Shared Model Configuration

- [ ] 6.1 Require an authenticated Researcher Account without a mandatory password change for model configuration, credential-state, and provider-probe APIs while preserving write-only credential values.
- [ ] 6.2 Serialize complete model-configuration PUT operations in the single Studio process and test atomic last-committed-document behavior for overlapping researchers.
- [ ] 6.3 Keep the provider-configuration UI available to every fully authenticated researcher and update domain documentation to describe Model Connections and Capability Routes as deployment-wide shared settings.
- [ ] 6.4 Test that unauthenticated and mandatory-change accounts cannot read configuration, inspect credential state, or contact a provider through probe operations.

## 7. Container and Private Gateway

- [ ] 7.1 Replace the Studio container's Vite development-server command with the built production Node host and migration-replay startup.
- [ ] 7.2 Add Caddy as the only host-published Compose service; place Caddy and Studio alone on a dedicated proxy network and keep Studio, database, and Parsing Service host ports closed.
- [ ] 7.3 Configure Caddy to discard inbound `X-FREE-Client-Address` and set it from the direct client socket; make hosted Studio require that proxy contract and test spoofed headers plus independent client buckets.
- [ ] 7.4 Mount institution/VPN-supplied certificate and key files read-only with no ACME, internal-CA, self-signed, or plain-HTTP fallback.
- [ ] 7.5 Document clean-volume initialization, required origin/session/proxy/certificate settings, first-account CLI use, shared model setup, certificate validation and forced reload, and explicit old-data loss.
- [ ] 7.6 Update `CONTEXT.md` with the resolved Researcher Account ownership language while retaining Project Context as the research aggregate and avoiding “user workspace.”

## 8. Isolation and Deployment Verification

- [ ] 8.1 Verify the clean baseline starts with zero accounts and projects and rejects Project Context creation without a valid owner.
- [ ] 8.2 Add production-host integration tests for cookie tampering, expiry, renewal, revocation, disabled accounts, generic login errors, throttling, Origin rejection, public health, API 401, redirects, and static fallback.
- [ ] 8.3 Run database unit/integration suites, Studio tests and lint, production client/server build, and all affected active-change lifecycle tests.
- [ ] 8.4 Validate Compose and Caddy configuration, start fresh volumes, create two accounts through CLI, and smoke-test HTTPS login, password change, shared model configuration, project and annotation isolation, logout, proxy-header spoof resistance, and internal service non-exposure.
