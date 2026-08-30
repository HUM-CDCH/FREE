# Local development

The host development topology mirrors production: Compose runs PostgreSQL, the
Parsing Service, Studio, and an nginx TLS entry point, with
`STUDIO_BASE_PATH=/free` over HTTPS. Host development differs from production
only through `compose.override.yaml` (loaded automatically): Studio
and the Parsing Service run their reload-capable development servers with live
source sync, sign-in goes through a local mock OIDC identity provider, the
certificates come from `mkcert`, and nginx runs as a container (production
uses the deployment machine's host-managed nginx) — both render the same
shared `docker/nginx/free-studio-locations.inc.template`, so the
application-facing proxy behavior is identical. The repository Dev Container
is the supported exception: because it deliberately has no Docker socket, the
same launcher runs its services directly on loopback HTTP as described below.

## Prerequisites

- Node.js 24 and pnpm 10.9 (`pnpm install` at the root also syncs Python
  services through `uv`).
- Docker Desktop with Docker Compose v2.40.0 or later (Compose Watch,
  optional profile dependencies, `!reset`, and `gw_priority` are used). The
  launcher checks this before starting the host stack.
- `mkcert`, with its root CA installed once: `mkcert -install`.

The default mock-OIDC profile needs no `.env`. The real-Entra profile reads the
four `FREE_ENTRA_*` values described below. `DATABASE_URL` is also read by
host-run database tooling.

## Start

```bash
pnpm dev
```

The launcher generates `.certs/studio.crt`/`.certs/studio.key` with `mkcert`
when missing, then runs `docker compose --profile mock-oidc up --build --watch`.
On the first run, the Parsing Service image build and its Docling model
download take several
minutes; later runs reuse the image and the named model cache.

Open **https://localhost:8443/free**. Signing in runs the OIDC authorization
code flow against the local `mock-oidc` service (see below); the local
Researcher Account is created on first sign-in. Migrations replay
automatically in the Studio container entrypoint before the dev server
starts.

Source changes under `prototypes/studio`, `prototypes/parsing_service`,
`packages/db`, `packages/studio-configuration`, `packages/extraction`, and
`packages/extraction-result-export` sync live into the relevant container.
Changes to the database schema, Prisma Next generator configuration, or
migrations rebuild Studio so contract generation and migration replay run
again; dependency manifest or Dockerfile changes also rebuild the image (see
the watch rules in `compose.override.yaml`).

Stop with Ctrl+C. Data lives in named Docker volumes and survives restarts; to
recreate the disposable development database run `pnpm db:reset`, and to drop
every volume run `docker compose down --volumes`.

## Development identity

The default Compose stack uses the `mock-oidc` service
(`ghcr.io/navikt/mock-oauth2-server`, published on `127.0.0.1:8444`) but still
runs the real authorization-code and session path: PKCE, a certificate client
assertion signed with a throwaway key, code redemption, the
`https://localhost:8443/free/auth/callback` callback, and the
`https://localhost:8443/free/auth/signed-out` end-session redirect. The mock
accepts the development credential and signs in silently with the pinned
development Researcher claims in `compose.override.yaml`.

The Dev Container also uses OIDC rather than a development identity shortcut.
Its direct Studio process reaches the sibling mock at
`http://mock-oidc:8080/dev`, while the browser reaches the same issuer through
the sibling service's loopback publish at `http://localhost:8444/dev`.

## Wi-Fi profile (test from a phone)

```bash
pnpm dev:wifi
```

This selects the machine's private Wi-Fi IPv4 address (or use
`--host=<private-ip>`), regenerates the certificate to cover it, binds nginx
and the mock OIDC service on `0.0.0.0` (ports 8443 and 8444 — the phone must
reach both for sign-in), and — on Windows — asks for administrator approval
for one narrow inbound firewall rule (TCP 8443 and 8444, Private profile,
local subnet only). Revoke that rule at any time:

```bash
pnpm dev:wifi:revoke
```

For the phone to trust the certificate, install the mkcert root CA from the
path the launcher prints. Pass `--firewall=off` if firewall policy is managed
elsewhere.

## Real Entra in development

Development uses the local mock by default. To verify the real tenant, put the
four `FREE_ENTRA_*` values in `.env`, register the exact
`https://localhost:8443/free/auth/callback` and
`https://localhost:8443/free/auth/signed-out` URIs, and let the launcher
validate the values, certificate, and Compose profile:

```bash
pnpm dev -- --entra
```

See the [Entra authentication runbook](entra-authentication.md). In the host
Compose topologies the base path and TLS behavior are identical, so the
redirect URIs differ from production only by host. The direct Dev Container
path uses its documented loopback HTTP callback instead.

## Dev Container

Inside the repository Dev Container (no Docker socket), `pnpm dev` waits for
the sibling PostgreSQL service, replays authored migrations, verifies the live
schema, and starts Studio and the Parsing Service directly from the workspace.
Studio serves **http://localhost:5173/free** over plain HTTP. Authentication
uses the sibling mock OIDC service, whose browser endpoint is forwarded on
loopback port **8444**. The base path remains `/free`; only TLS and nginx are
absent.

FREE-managed provider credentials use the Dev Container user's GNOME Keyring.
A rebuild creates a fresh keyring, so enter managed credentials again after
rebuilding.

## Database operations

- `pnpm --filter db db:init` replays authored forward migrations against
  `DATABASE_URL`. It does not reset or seed data and may deliberately target a
  deployment database.
- `pnpm db:reset` drops and recreates the configured database, then replays
  migrations. It is destructive and is accepted only for PostgreSQL user
  `postgres`, explicit port `5432`, database `free`, and a loopback host. The
  only non-loopback exception is host `db` when `FREE_DEVCONTAINER=1` is
  explicit.
- Disposable PostgreSQL integration targets must use user `postgres`, explicit
  port `5432`, a loopback host, and a database named `free_test_*`. The
  Dev Container host `db` is not accepted for these checks.
- Production startup runs only `pnpm --filter db db:init`; production is never
  reset.

## Verification

`pnpm test` is the fast unit/static aggregate. It does not require a running
FREE stack, PostgreSQL, a browser, or a live model. Run the other checks
deliberately according to their infrastructure and mutation boundaries:

| Command | Requirements and effects |
| --- | --- |
| `pnpm test:safety` | Requires pnpm, Git, and a working Docker engine. It checks destructive-target rejection, deployment/Compose configuration, Dev Container wiring, secrets policy, and nginx rendering without a running FREE stack. It uses temporary files and a throwaway nginx container but does not mutate a database. |
| `pnpm test:postgres` | Requires caller-created and migrated disposable databases. Set `PROJECT_STORE_POSTGRES_URL` and `EXTRACTION_TEST_DATABASE_URL` to separate fresh targets such as `postgresql://postgres:postgres@localhost:5432/free_test_cascade` and `postgresql://postgres:postgres@localhost:5432/free_test_extraction`. The checks write and delete integration fixtures; a failed run may leave data, so do not reuse that database as if it were fresh. |
| `pnpm test:e2e` | Requires Docker and Playwright's browser. By default it removes any prior `free-studio-e2e` test stack, creates isolated PostgreSQL and interactive mock-OIDC containers, migrates the test database, starts Studio on a test loopback port, and removes the stack and volumes afterward. Browser sign-in runs through that mock OIDC service; the default development stack is not used. |
| `pnpm test:all` | Runs typecheck, unit, safety, PostgreSQL integration, and E2E sequentially. The caller must provide the Docker/browser prerequisites and two fresh, migrated PostgreSQL targets required by `test:postgres`. |
| `pnpm test:ci` | Requires `CI=true` and the fixed CI URLs `free_test_project_store` and `free_test_extraction` on PostgreSQL at `127.0.0.1:5432`. It requires `DATABASE_URL` to equal `EXTRACTION_TEST_DATABASE_URL`, migrates both targets, then runs `test:all`. |
| `pnpm test:live-model` | Requires Ollama at `FREE_LIVE_OLLAMA_URL` (default `http://127.0.0.1:11434`) with `FREE_LIVE_OLLAMA_MODEL` (default `qwen3.8:latest`). It also runs the real Docling conversion smoke check, which may download models into the local cache. |
| `pnpm test:system` | Requires Docker, `mkcert`, the default local Compose topology, and an Ollama endpoint reachable from its containers (`FREE_TEST_OLLAMA_BASE_URL`, default `http://host.docker.internal:11434`; model `FREE_TEST_OLLAMA_MODEL`, default `qwen3.8:latest`). It starts the stack if needed, creates an authenticated account and research workflow, replaces shared model configuration, restarts the stack to prove durability, deletes its Project Context, and leaves the stack running. Use only against disposable local development data. |
| `pnpm typecheck` | Runs the workspace TypeScript checks without services or data mutation. |

`test:live-model` and `test:system` are intentionally excluded from the two
aggregates because they require an external model or mutate the default local
stack. The GitHub `verify` workflow runs `test:ci` on Linux, so the POSIX
session-secret permission check is part of the required deterministic gate.

## Host-run tooling

Host-run database checks and scripts reach the development PostgreSQL publish
through `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/free`.
The development overlay publishes the `db` service on `127.0.0.1:5432`, and
`pnpm --filter db db:start` starts just that service. The Parsing Service stays
published on `127.0.0.1:8055`.

Studio is not published directly by the host Compose topology; nginx is its
only browser entry point.
