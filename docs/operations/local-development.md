# Local development

Development runs the production Compose topology, with `STUDIO_BASE_PATH=/free`
over HTTPS. It differs only through `compose.override.yaml` (loaded
automatically): Studio and the Parsing Service run their reload-capable
development servers with live source sync, sign-in goes through a local mock
OIDC identity provider, the certificates come from `mkcert`, and nginx always
runs as a container, rendering the same
`docker/nginx/free-studio-locations.inc.template` as production.

## Prerequisites

- Node.js 24, pnpm and `uv`, as in the README's
  [requirements](../../README.md#requirements). `pnpm install` at the root
  also syncs the Parsing Service's Python environment through `uv`.
  `FREE_SKIP_PYTHON=1` is CI-only: it makes `pnpm install` skip the parsing
  service's `uv sync --frozen`, because the CUDA PyTorch wheels do not fit
  GitHub's hosted runner. Leave it unset on development and deployment hosts.
- Docker Engine or Docker Desktop with Docker Compose v2.40.0 or later
  (Compose Watch, optional profile dependencies, `!reset`, and `gw_priority`
  are used). The launcher checks this before starting the host stack.
- `mkcert`, with its root CA installed once: `mkcert -install`.

The default mock-OIDC profile needs no `.env`. The real-Entra profile reads the
four `FREE_ENTRA_*` values described below. `DATABASE_URL` is also read by
host-run database tooling.

## Start

```bash
pnpm dev
```

The launcher generates `.certs/studio.crt`/`.certs/studio.key` with `mkcert`
when missing, builds the images, then stops Studio and the parsing API/worker
with a 60-second grace period. It runs
`docker compose --profile mock-oidc up --watch` after they stop, so no old
process overlaps its replacement. Failed builds
leave the running application intact; a failed migration prevents startup.
On the first run, building the Python image and, with a GPU, downloading the
models can take several minutes. The model cache is persistent.

Open **https://localhost:8443/free**. Signing in runs the OIDC authorization
code flow against the local `mock-oidc` service (see below); the local
Researcher Account is created on first sign-in. Migrations replay in the
Studio container's entrypoint before the dev server starts; the entrypoint
then creates the Parsing Service's database role, DBOS launches with the dev
server, and the worker starts once Studio is healthy and migrates its own
schema.

Browser code under `apps/studio/src` syncs live and reloads in place.
Server code — Studio's `api/`, `server/` and `shared/`, and `packages/*` —
syncs and restarts Studio, because DBOS runs inside Studio's process and
launches once per process. Parsing Service source changes restart its API and
worker. Changes to the database schema, the Prisma Next generator
configuration or migrations rebuild Studio so contract generation and
migration replay run again; dependency manifest or Dockerfile changes also
rebuild the image (see the watch rules in `compose.override.yaml`).

Running Studio on the host (`pnpm --filter studio dev`) needs PostgreSQL at
startup, because DBOS launches with the server: start it first with
`pnpm --filter db db:start`.

Stop with Ctrl+C. Data lives in named Docker volumes and survives restarts;
the parsing run volume and the source inbox are durable inputs to future
extraction. `docker compose down --volumes` destroys all of these volumes and
is never needed for ordinary restarts.

## Development identity

The default Compose stack uses the `mock-oidc` service
(`ghcr.io/navikt/mock-oauth2-server`, published on `127.0.0.1:8444`) but still
runs the real authorization-code and session path: PKCE, a certificate client
assertion signed with a throwaway key, code redemption, the
`https://localhost:8443/free/auth/callback` callback, and the
`https://localhost:8443/free/auth/signed-out` end-session redirect. The mock
accepts the development credential and signs in silently with the pinned
development Researcher claims in `compose.override.yaml`.

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
redirect URIs differ from production only by host.

## Studio client against a deployment

To work on browser code against a deployed Studio's real data, run only this
checkout's client, with HMR, through `pnpm dev:spark`. Copy the certificate
the deployment serves once over SSH (the host nginx's `ssl_certificate`, or
`FREE_TLS_CERT_PATH` with the bundled nginx); `FREE_SPARK_ORIGIN` is the
deployment's origin:

```bash
ssh <deploy-host> 'cat <deployment certificate path>' > .certs/spark.crt  # once
FREE_SPARK_ORIGIN=https://<studio-host> pnpm dev:spark
```

It opens `http://127.0.0.1:5173/free/`; the deployment must use the base path
`/free`. Vite forwards `/free/api` to the deployment; no local server,
database, DBOS executor or model runs, so nothing competes with the
deployment's work. Signing in opens a separate browser window on the
deployment's real Microsoft sign-in. Its profile, `.dev/spark-browser/`, keeps
you signed in between runs; it holds your credentials, so never share it. The
session stays in the dev server's memory and is added only to same-origin
requests; the server listens on loopback only.

- Writes are refused by default, because they would change real data: a
  save answers 403 `read_only` and the terminal names the request. Use
  `FREE_SPARK_WRITE=1 pnpm dev:spark` to allow them.
- `FREE_SPARK_ORIGIN` is required; `FREE_SPARK_CA_FILE` names
  the deployment's certificate (default `.certs/spark.crt`). Both the proxy and the sign-in
  window accept only that certificate.
- The client must stay compatible with the deployed API; API or workflow
  changes need `pnpm dev` or a deployment.
- If Playwright's Chromium is missing: `pnpm --filter studio exec playwright install chromium`.

## Model-call traces (Phoenix)

Every development deployment traces Studio's and the Parsing Service's model
calls and starts the Phoenix dashboard:

```bash
pnpm dev
```

Phoenix opens at http://localhost:6006, published on loopback only and never
behind nginx; the `phoenix-data` volume keeps its traces across restarts. The
base `compose.yaml` includes Phoenix and sets
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` for Studio and the worker. No startup flag
is required. Tracing never gates inference: spans are exported in the
background, and a stopped Phoenix only loses them.

Production uses the same collector by default; see the
[production tracing runbook](deployment.md#model-call-traces-phoenix), including
SSH access to the loopback dashboard on a remote host.

One trace follows a workflow: Studio's DBOS workflow and step spans, a
logical call per model operation (`schema-suggestion`, `schema-edit`, or an
extraction stage such as `discovery`), the provider calls under it (the AI
SDK's `chat` spans; one span per extraction call) and every HTTP request they
sent, so AI SDK retries and the prompt-only output-format fallback show as
separate attempts. Studio passes the trace to the Parsing Service with each
conversion and extraction, so kei's workflow and its extraction model calls,
Catalog chunk threads included, appear in the same trace, also after a worker
restart. A conversion shows only its workflow and steps: Surya's OCR requests
are not traced.
A workflow's recovery is a new workflow span under the same workflow ID: a
step it re-executes has model spans again, while a step it reuses from its
checkpoint has none (Studio marks it `cached`). Studio's own recovered
workflows start a new trace (find them by `operationUUID`); spans still open
when a process died are lost, so the calls it completed before appear as
separate roots in the trace list.

Prompts, raw responses and parsed outputs are not recorded unless listed:

```bash
FREE_TRACE_CAPTURE=prompts,responses,parsed pnpm dev
```

`prompts` records the model's input; `responses` records its raw reply;
`parsed` records the output interpreted by FREE. List only the content you
need, for example `FREE_TRACE_CAPTURE=prompts,responses` for LLM input and
output. Inspect the model-call spans in Phoenix at http://localhost:6006.

Request headers, and with them model keys, are never recorded. Model-call
error spans retain their status and exception type, but omit messages, stacks
and provider refusal bodies even when capture is enabled: those can quote
source text or credentials. A malformed model reply is recorded only through
explicit `responses` capture.

## Database operations

Host-run database checks and scripts reach the development PostgreSQL publish
through `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/free`.
The development overlay publishes the `db` service on `127.0.0.1:5432`, and
`pnpm --filter db db:start` starts just that service.

- `pnpm --filter db db:init` replays authored forward migrations against
  `DATABASE_URL`. It does not reset or seed data and may deliberately target a
  deployment database.
- `pnpm db:reset` drops and recreates the configured database, then replays
  migrations; restart the stack afterwards so Studio and the worker recreate
  their DBOS schemas. Run it after switching to a branch with an incompatible
  migration history. It is destructive and is accepted only for PostgreSQL
  user `postgres`, explicit port `5432`, database `free`, and a loopback host.
- Disposable PostgreSQL integration targets must use user `postgres`, explicit
  port `5432`, a loopback host, and a database named `free_test_*`.
- Startup replays `pnpm --filter db db:init` and creates the Parsing Service's
  role (`pnpm --filter db db:kei-role`); each DBOS process migrates its own
  schema at launch. None of these resets data.

The Parsing Service's API, worker and model servers are private to the
Compose network. For service commands use `docker compose exec
parsing_service …` or `docker compose exec parsing_worker …`. Direct
`docker compose` commands against the development stack need the session
secret the launcher keeps in `.dev/session-secret`:
`export FREE_SESSION_SECRET=$(cat .dev/session-secret)` first. Host-run
service tooling is available through the `parsing-service` workspace package;
see its [README](../../apps/parsing_service/README.md). Studio is not
published directly by the host Compose topology; nginx is its only browser
entry point.

## Verification

`pnpm test` is the fast unit/static aggregate. It does not require a running
FREE stack, PostgreSQL, a browser, or a live model. Run the other checks
deliberately according to their infrastructure and mutation boundaries:

| Command | Requirements and effects |
| --- | --- |
| `pnpm test:safety` | Requires pnpm, Git, and a working Docker engine. It checks destructive-target rejection, deployment/Compose configuration, secrets policy, and nginx rendering without a running FREE stack. It uses temporary files and a throwaway nginx container but does not mutate a database. |
| `pnpm test:postgres` | Requires caller-created and migrated disposable databases. Set `PROJECT_STORE_POSTGRES_URL` and `EXTRACTION_TEST_DATABASE_URL` to separate fresh targets such as `postgresql://postgres:postgres@localhost:5432/free_test_cascade` and `postgresql://postgres:postgres@localhost:5432/free_test_extraction`. `DATABASE_URL` must equal `EXTRACTION_TEST_DATABASE_URL` for Studio's DBOS tier, which creates and drops its own `dbos_t_*`/`kei_dbos_t_*` schemas. Also set `PARSING_TEST_DATABASE_URL` to an existing `postgres` loopback:5432 `free_test_parsing` database. The Parsing Service creates and drops fresh `free_test_parsing_*` databases for individual cases. The checks write and delete integration fixtures; a failed run may leave data, so do not reuse that database as if it were fresh. |
| `pnpm test:e2e` | Requires Docker and Playwright's browser. By default it removes any prior `free-studio-e2e` test stack, creates isolated PostgreSQL and interactive mock-OIDC containers, migrates the test database, starts Studio on a test loopback port, and removes the stack and volumes afterward. Browser sign-in runs through that mock OIDC service; kei is a TypeScript stand-in speaking kei's workflow contract, and the default development stack is not used. |
| `pnpm test:service` | Creates its own PostgreSQL and mock-OIDC stack and starts the real Python API and DBOS worker. Exercises native conversion recovery and reuse, durable Article/Catalog controls, retained corrections after reload and export, deletion and garbage collection. Model responses are scripted by default; the first native conversion may download Docling weights. Set both `FREE_REAL_EXTRACT_URL` and `FREE_REAL_EXTRACT_MODEL` for the separate real-provider checks. |
| `pnpm test:all` | Runs typecheck, lint, unit, safety, PostgreSQL integration, E2E, and `test:service` sequentially. The caller must provide the Docker/browser prerequisites and three fresh PostgreSQL targets (the two Studio targets must be migrated) required by `test:postgres`. |
| `pnpm test:all:node` | Runs typecheck, lint, the Node unit tiers, safety, the `db` and `extraction` PostgreSQL integration tiers, and E2E sequentially: `test:all` without the Parsing Service tiers and `test:service`, so it needs no Python environment. The caller must provide the Docker/browser prerequisites and the two fresh, migrated Studio PostgreSQL targets (`PROJECT_STORE_POSTGRES_URL` and `EXTRACTION_TEST_DATABASE_URL`). |
| `pnpm test:ci` | Requires `CI=true` and the fixed CI URLs `free_test_project_store` and `free_test_extraction` on PostgreSQL at `127.0.0.1:5432`. It also requires the fixed `free_test_parsing` URL unless `FREE_SKIP_PYTHON=1`; a parsing URL that is present is always validated. It requires `DATABASE_URL` to equal `EXTRACTION_TEST_DATABASE_URL`, migrates both Studio targets (a migration failure stops the run), then runs each step of `test:all:node` when `FREE_SKIP_PYTHON=1` (GitHub's `verify` job) and of `test:all` otherwise. A failing step does not stop the later ones; a PASS/FAIL summary follows and the command fails if any step failed. |
| `pnpm test:live-model` | Studio's check requires a vLLM server at `FREE_LIVE_VLLM_URL` (default `http://127.0.0.1:8002/v1`) serving `FREE_LIVE_VLLM_MODEL` (default `Qwen/Qwen3.8-27B-FP8`); its NuExtract case runs only when `FREE_LIVE_NUEXTRACT_URL` (and `FREE_LIVE_NUEXTRACT_MODEL`) is set. The Parsing Service's checks run the real Docling conversion, which may download models into the local cache; its real-model cases run only when `FREE_REAL_EXTRACT_URL` and `FREE_REAL_EXTRACT_MODEL` (or the `KEI_*` test URLs) are set. |
| `pnpm test:system` | Requires Docker and `mkcert` (or an existing local certificate pair). It builds an isolated Compose project with a disposable PostgreSQL volume and scripted external extraction-model responses, then checks authentication, upload, Schema Suggestion, durable Article admission/completion, saved values, whole-stack restart persistence, deletion and garbage collection over HTTPS. It does not assert producer Evidence or a correction write. It removes its own project and volume afterward; the development stack and its database are outside this test's scope. |
| `pnpm typecheck` | Runs the workspace TypeScript checks without services or data mutation. |
| `pnpm lint` | Runs ESLint over Studio without services or data mutation. |

The extraction PostgreSQL tier also runs Python-backed durable lifecycle and
process-recovery checks unless `FREE_SKIP_PYTHON=1`. They require a built
`free-parsing_worker` image (or `DURABLE_TEST_WORKER_IMAGE` naming an
equivalent image), Docker and the guarded disposable PostgreSQL target. The
Node-only CI tier skips these two checks; full-host verification must run them.

`test:live-model` and `test:system` are intentionally excluded from the three
aggregates (`test:all`, `test:all:node`, and `test:ci`) because the former needs
an external model and the latter builds and restarts a full Docker stack. The
GitHub `verify` workflow runs `test:ci` on Linux for pull requests and pushes
to `main`, so the POSIX session-secret permission check is part of the required
deterministic gate.
