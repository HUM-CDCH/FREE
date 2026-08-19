## 1. Account and Database Foundation

- [ ] 1.1 Replace the unused `User` contract with UUID `ResearcherAccount` fields for normalized email, versioned password hash, mandatory change, disablement, session version, and timestamps.
- [ ] 1.2 Add the required indexed `ProjectContext.researcherAccountId` relationship with restricted account deletion and regenerate Prisma contract artifacts.
- [ ] 1.3 Rebuild the application migration history as one clean empty-database baseline containing no accounts, sample projects, nullable ownership transition, or legacy compatibility path.
- [ ] 1.4 Remove production seed behavior and update database setup scripts so a fresh deployment replays authored migrations and remains empty.
- [ ] 1.5 Implement and unit-test canonical case-insensitive email normalization plus Researcher Account create, lookup, password-update, and disable persistence operations.

## 2. Passwords and Operator Account CLI

- [ ] 2.1 Implement and test the bounded, versioned Node `scrypt` password representation with random salts, explicit costs, strict parsing, and constant-time verification.
- [ ] 2.2 Implement an account CLI that reads passwords without argv exposure and creates an account with a mandatory temporary-password change.
- [ ] 2.3 Add CLI reset-password and disable operations that increment `sessionVersion`, and test duplicate, missing-account, and failure exit behavior.
- [ ] 2.4 Wire root and Studio package scripts for running the account CLI against the selected database without creating default credentials.

## 3. Researcher-Scoped Project Persistence

- [ ] 3.1 Introduce separate researcher-scoped and internal-worker ProjectStore interfaces so HTTP code cannot obtain global claim, lease, or reference operations.
- [ ] 3.2 Scope Project Context create, list, detail, rename, and delete queries to the bound Researcher Account and preserve not-found behavior across owners.
- [ ] 3.3 Scope Source Document ingestion, reopen, delete, canonical representation, download, and direct artifact lookup through the owning Project Context.
- [ ] 3.4 Scope Extraction Schema, Schema Revision, suggestion, and schema-editing persistence operations through the owning Project Context.
- [ ] 3.5 Scope Extraction, Extraction Result, review, retry, Batch Extraction, and Batch Schema Suggestion reads and mutations through the owning Project Context.
- [ ] 3.6 Keep package reference and cleanup logic deployment-wide internally while requiring an authorized database relationship before returning an artifact descriptor or stream.
- [ ] 3.7 Rewire job pumps and lease-based execution to the internal worker interface and prove request handlers cannot call system-scoped methods.
- [ ] 3.8 Update ProjectStore fixtures, DTOs, tests, and active lifecycle integrations to create explicit account-owned Project Contexts without compatibility overloads.

## 4. Production Studio Host

- [ ] 4.1 Add direct Hono Node dependencies and extract the existing API route grammar into one eager production-safe handler registry and dispatcher.
- [ ] 4.2 Build the Hono application composition root with JSON API 404/405 behavior, route-specific body limits, shallow health, static assets, and authenticated SPA fallback.
- [ ] 4.3 Make Vite development middleware call the same Hono application and move dispatcher behavior tests out of Vite-only configuration.
- [ ] 4.4 Add separate Vite client and Node-server builds, production static cache policy, and a single-process server entrypoint with graceful shutdown.
- [ ] 4.5 Validate required `STUDIO_ORIGIN` and `FREE_SESSION_SECRET` configuration before the production server listens, allowing only explicit loopback development exceptions.

## 5. Authentication Boundary

- [ ] 5.1 Implement signed cookie encode/verify/renew/clear behavior with account ID, `sessionVersion`, 12-hour idle expiry, 7-day absolute expiry, and required cookie attributes.
- [ ] 5.2 Implement exact canonical-origin enforcement for unsafe methods and a bounded pruned in-memory login limiter keyed by normalized email and client address.
- [ ] 5.3 Implement generic-failure login with dummy password verification, session inspection, authenticated logout, and temporary-password change endpoints.
- [ ] 5.4 Implement authentication middleware that reloads the account on every request, rejects disabled/version-mismatched sessions, and limits temporary accounts to password change/session/logout.
- [ ] 5.5 Apply the deny-by-default route boundary so only login/session establishment, required static assets, and shallow Studio health are public; keep Parsing Service browser-cookie-free.
- [ ] 5.6 Construct the researcher-scoped ProjectStore from authenticated middleware context for every project/data/model request handler.
- [ ] 5.7 Remove the production LLM inspector route and verify unknown API paths never fall through to SPA HTML.

## 6. Authenticated Studio Experience

- [ ] 6.1 Add session state, login, mandatory-password-change, normal password-change, and logout UI with validated local return paths.
- [ ] 6.2 Gate `ProjectNavigationProvider` and all Project Context loading until authentication and mandatory-password state resolve.
- [ ] 6.3 Add a shared same-origin API fetch wrapper that turns HTTP 401 into an authentication transition and migrate scattered Studio API clients to it.
- [ ] 6.4 Add focused frontend tests for login failures, temporary-password gating, logout, expired sessions, protected deep links, and stale cross-account route identifiers.

## 7. Shared Model Configuration

- [ ] 7.1 Require an authenticated Researcher Account for model configuration, credential-state, and provider-probe APIs while preserving write-only credential values.
- [ ] 7.2 Serialize complete model-configuration PUT operations in the single Studio process and test atomic last-committed-document behavior for overlapping researchers.
- [ ] 7.3 Keep the provider-configuration UI available to every authenticated researcher and update domain documentation to describe Model Connections and Capability Routes as deployment-wide shared settings.

## 8. Container and Private Gateway

- [ ] 8.1 Replace the Studio container's Vite development-server command with the built production Node host and migration-replay startup.
- [ ] 8.2 Add Caddy as the only host-published Compose service, proxy to Studio over the private network, and remove direct Studio, database, and Parsing Service host exposure.
- [ ] 8.3 Mount institution/VPN-supplied certificate and key files read-only with no ACME, internal-CA, self-signed, or plain-HTTP fallback.
- [ ] 8.4 Document clean-volume initialization, required origin/session/certificate settings, first-account CLI use, shared model setup, certificate validation and forced reload, and explicit old-data loss.
- [ ] 8.5 Update `CONTEXT.md` with the resolved Researcher Account ownership language while retaining Project Context as the research aggregate and avoiding “user workspace.”

## 9. Isolation and Deployment Verification

- [ ] 9.1 Verify the clean baseline starts with zero accounts/projects and rejects Project Context creation without a valid owner.
- [ ] 9.2 Add two-account API coverage proving account A cannot list, read, mutate, execute, review, retry, reopen, or stream any identifier rooted in account B.
- [ ] 9.3 Add cross-account physical-package tests proving authorized identical-content access and reference-safe cleanup without metadata disclosure.
- [ ] 9.4 Add production-host integration tests for cookie tampering/expiry/renewal/revocation, disabled accounts, generic login errors, throttling, Origin rejection, public health, API 401, redirects, and static fallback.
- [ ] 9.5 Run database unit/integration suites, Studio tests and lint, production client/server build, and all affected active-change lifecycle tests.
- [ ] 9.6 Validate Compose and Caddy configuration, start fresh volumes, create two accounts through CLI, and smoke-test HTTPS login, password change, shared model configuration, project isolation, logout, and internal service non-exposure.
