# FREE

FREE lets an authenticated humanities researcher turn source documents into
structured, evidence-grounded extraction results and review them.

## Start

```bash
pnpm dev          # local:      Docker Compose + containerized nginx + mock OIDC
pnpm production   # production: Docker Compose behind the host-managed nginx
```

Both use the same base `compose.yaml`; the launcher adds the local
`compose.override.yaml` or production `compose.prod.yaml` and prepares the
host-only prerequisites. Local serves https://localhost:8443/free/.

## Product contract

FREE's normative product and safety contract is:

1. **Authenticated ownership.** Every Project Context, source document,
   schema, extraction, evidence link, and review decision belongs to an
   authenticated Researcher Account. Reads and writes are scoped to that
   researcher. Static assets, health endpoints, and the OIDC
   login/callback/signed-out endpoints may be public.
2. **Real authentication paths.** Local development uses an isolated mock OIDC
   provider through the same authorization-code, session, and ownership path
   used with Microsoft Entra. Production uses a single-tenant Entra
   registration; the local mock cannot be enabled there.
3. **Schema-guided extraction.** A researcher creates a Project Context,
   ingests PDFs, defines and approves an extraction schema, and runs the
   canonical extraction path over the Project Context's source documents.
   Schema suggestion feeds this path; it is not a competing extraction mode.
4. **Evidence and review.** Every populated extraction value is paired with
   locatable source evidence or visibly marked ungrounded. Complete
   accept/reject/edit review decisions are validated and stored; partial or
   structurally invalid review cannot silently become authoritative.
5. **Durable, versioned state.** Project Contexts, source documents and their
   representation revisions, schema and prompt revisions, extractions, and
   review decisions survive ordinary restarts. An extraction remains pinned to
   the source-representation and schema revisions it used, so newer revisions
   can make it stale without rewriting its history.
6. **Project lifecycle.** A researcher can create, list, rename, and
   permanently delete a Project Context. Deletion removes its owned database
   graph and removes filesystem artifacts only when no remaining Project
   Context references them.
7. **Model-provider surface.** The shared configuration supports Ollama,
   OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible
   providers, with explicit Extraction and Interaction routes. Stored
   credentials are write-only; provider configuration is deployment-wide and
   is not seeded at startup.
   Output formatting is automatic: selecting a connection and model is sufficient,
   including for existing saved routes. FREE uses the adapter's output support and
   falls back to prompt-only generation only after an explicit unsupported-format
   response, remembering that endpoint/model/route for the server session. Returned
   results are still validated. OpenAI-compatible requests include the JSON schema
   when supplied. Output formatting has no route override; previously saved output
   overrides are ignored and removed on the next save. Raw NuExtract keeps its own
   protocol.
8. **Safe startup.** Authored forward migrations finish before Studio becomes
   ready, both for a fresh database and an already-migrated one. Normal startup
   never resets the database or seeds an account, Project Context, provider,
   route, or credential.
9. **Proxy parity.** Production keeps its host-managed nginx; local uses
   containerized nginx. Both render the same version-controlled proxy fragment
   for `/free` routing, forwarded headers, auth callbacks, security headers,
   upload limits, and timeouts.
10. **Secrets and destructive limits.** Secrets enter through environment or
    the OS credential store, never committed files. Forward migration replay
    may target the configured deployment database. Reset is limited to
    `postgres` on loopback port 5432 database `free`, or the Dev Container's
    `db` host only with `FREE_DEVCONTAINER=1`. Disposable PostgreSQL checks are
    limited to `postgres` on loopback port 5432 databases named
    `free_test_*`. Production is never reset.

Out of scope: backward compatibility with historical API shapes, competing
deployment paths, and speculative extensibility.

## Safety boundaries

- Production nginx is host-managed — never containerized. The rendered
  fragment for it comes from the same template local nginx consumes.
- `packages/db` enforces the reset and disposable-test target restrictions
  before opening an administrative connection.
- Session cookies are signed; API writes are origin-checked; uploads are
  validated (`application/pdf`, magic bytes, 50 MiB cap).

## Verification

The commands deliberately separate fast checks from infrastructure-backed and
mutating checks:

| Command | Scope and infrastructure |
| --- | --- |
| `pnpm test` | Fast unit/static checks only; no live stack, PostgreSQL, browser, or model |
| `pnpm test:safety` | Safety/configuration checks; no running FREE stack, but Docker is required for Compose rendering and a throwaway nginx config check; no database mutation |
| `pnpm test:postgres` | PostgreSQL integration checks against caller-provisioned, migrated, disposable loopback `free_test_*` databases; they mutate those databases |
| `pnpm test:e2e` | Playwright browser tests; creates and removes its own Docker PostgreSQL and mock-OIDC stack, migrates it, and starts Studio locally |
| `pnpm test:all` | All deterministic tiers: typecheck, unit, safety, caller-provisioned PostgreSQL integration, and E2E |
| `pnpm test:ci` | CI-only aggregate; verifies the fixed disposable CI targets, migrates them, and runs `test:all` |
| `pnpm test:live-model` | Real Ollama and Docling smoke checks; requires the configured Ollama model and may download Docling models |
| `pnpm test:system` | Mutating black-box contract check against the default local Compose stack and a reachable Ollama model; may start and restart the stack, changes its development database/model configuration, and leaves the stack running |
| `pnpm typecheck` | TypeScript checks only; no services or data mutation |

`test:live-model` and `test:system` remain deliberately outside `test:all`
and `test:ci`: they depend on a live model or mutate the default development
stack. GitHub's Linux `verify` job runs `test:ci`, including the POSIX-only
session-secret permission assertion.

Detailed prerequisites, environment variables, and database target rules are
in the [local development runbook](docs/operations/local-development.md).

## Quickstart

With Node.js 24, pnpm 10.9, Docker Desktop (Compose v2.40.0+), and `mkcert`
(`mkcert -install` once):

```bash
pnpm install
```

```bash
pnpm dev
```

Then open **https://localhost:8443/free** and sign in through the local mock
OIDC identity provider. `pnpm dev` generates the mkcert certificate when missing
and runs `docker compose up --build --watch`; migrations replay in the Studio
container before its dev server starts, and source changes sync live. The
first run builds the Parsing Service image and downloads its models, which
takes several minutes.

Variants:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | This device only (nginx on `127.0.0.1:8443`) |
| `pnpm dev:wifi` | Also reachable from the private Wi-Fi subnet (phone testing) |
| `pnpm dev:wifi:revoke` | Remove the Windows firewall rule again |
| `pnpm dev -- --entra` | Local Compose against a configured real Entra tenant |

Inside the repository Dev Container (no Docker socket), `pnpm dev` starts
Studio and the Parsing Service directly, using sibling PostgreSQL and sibling
mock OIDC services; the browser reaches mock OIDC on loopback port 8444 and
Studio at **http://localhost:5173/free**.

Detailed host, Dev Container, Entra, Wi-Fi, verification, and database
instructions:
[docs/operations/local-development.md](docs/operations/local-development.md).

## Deployment

Production is the same container stack behind the host-managed nginx:

```bash
node scripts/free.mjs production
```

This validates `.env`, renders the shared nginx behavior for the host nginx
into `.nginx/free-studio-locations.conf`, and starts the Compose stack
detached, waiting for health (migrations replay before Studio becomes
healthy). Prerequisites, `.env`, the host nginx include, proxy trust, cutover,
and certificate rotation:
[docs/operations/deployment.md](docs/operations/deployment.md). Entra
registration and rotation:
[docs/operations/entra-authentication.md](docs/operations/entra-authentication.md).

## More

See [CONTEXT.md](CONTEXT.md) for domain language and [docs/](docs/) for current
decisions and parsing contracts.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how we work together.
