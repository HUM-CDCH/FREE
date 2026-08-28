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
- Docker Desktop with Docker Compose v2.33.1 or later (Compose Watch,
  `!override`, and `gw_priority` are used). The launcher checks this before
  starting the host stack.
- `mkcert`, with its root CA installed once: `mkcert -install`.

No `.env` is required for development. If one exists, only `DATABASE_URL`
matters to host-run tooling (see below).

## Start

```bash
pnpm dev
```

The launcher generates `.certs/studio.crt`/`.certs/studio.key` with `mkcert`
when missing, then runs `docker compose up --build --watch`. On the first run
the Parsing Service image build and its Docling model download take several
minutes; later runs reuse the image and the named model cache.

Open **https://localhost:8443/free**. Signing in runs the OIDC authorization
code flow against the local `mock-oidc` service (see below); the local
Researcher Account is created on first sign-in. Migrations replay
automatically in the Studio container entrypoint before the dev server
starts.

Source changes under `prototypes/studio`, `prototypes/parsing_service`,
`packages/db`, `packages/extraction`, and `packages/extraction-result-export`
sync live into the relevant container; dependency manifest or Dockerfile
changes rebuild the image (see the watch rules in `compose.override.yaml`).

Stop with Ctrl+C. Data lives in named Docker volumes and survives restarts; to
recreate the disposable development database run `pnpm db:reset`, and to drop
every volume run `docker compose down --volumes`.

## Development identity

Sign-in in the Compose stack is a real OIDC authorization code flow. The
`mock-oidc` service (`ghcr.io/navikt/mock-oauth2-server`, published on
`127.0.0.1:8444`) stands in for the Microsoft Entra tenant, and Studio drives
it through the same MSAL client code as production: PKCE, the certificate
client assertion (signed with a throwaway key generated at boot — the mock
accepts any client credential), code redemption on
`https://localhost:8443/free/auth/callback`, and the end-session redirect back
to `https://localhost:8443/free/auth/signed-out`. The mock signs in silently
(no login page) with the pinned claims in `compose.override.yaml`, which
mirror the fake identity's development constants, so mock and fake sign-ins
resolve to the same Researcher Account.

Outside Compose — the Dev Container and a host-run
`pnpm --filter studio dev` — `FREE_ENTRA_MOCK_ISSUER` is unset and sign-in
falls back to the fake development identity provider. While the Compose stack
runs, a host-run dev server can opt into its mock with
`FREE_ENTRA_MOCK_ISSUER=http://localhost:8444/dev` (browser and server then
share the one published issuer URL).

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

Development identity uses the local mock by default. To verify the real
tenant, put the four `FREE_ENTRA_*` values in `.env`, register the exact
`https://localhost:8443/free/auth/callback` and
`https://localhost:8443/free/auth/signed-out` URIs, and start with the Entra
overlay:

```bash
docker compose -f compose.yaml -f compose.override.yaml -f compose.entra.yaml up --build --watch
```

See the [Entra authentication runbook](entra-authentication.md). In the host
Compose topologies the base path and TLS behavior are identical, so the
redirect URIs differ from production only by host. The direct Dev Container
path uses its documented loopback HTTP callback instead.

## Dev Container

Inside the repository Dev Container (no Docker socket), `pnpm dev` keeps the
direct process path: it waits for the sibling PostgreSQL service, applies
authored migrations, verifies the live schema, and starts Studio and the
Parsing Service on **http://localhost:5173/free** over plain HTTP. The base
path is still `/free`; only TLS and nginx are absent there.

FREE-managed provider credentials use the Dev Container user's GNOME Keyring.
A rebuild creates a fresh keyring, so enter managed credentials again after
rebuilding.

## Host-run tooling

Tests and scripts that run on the host (Vitest, Playwright, Prisma scripts,
`pnpm --filter studio dev`) reach PostgreSQL through
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/free`; the
development overlay publishes the db service on `127.0.0.1:5432`, and
`pnpm --filter db db:start` starts just that service. The Parsing Service stays
published on `127.0.0.1:8055`.

The Studio container's port is not published on the host, so a host-run
`pnpm --filter studio dev` on 5173 can coexist with the Compose stack; only one
process at a time can own the published `127.0.0.1:8055` Parsing Service port.
