# FREE

Document Extraction & Evaluation — shared team repo.

There is one topology, orchestrated by Compose: PostgreSQL, the Parsing
Service, Studio, and an nginx TLS entry point, always serving
`STUDIO_BASE_PATH=/free` over HTTPS. Development and production differ only by
overlay (`compose.override.yaml`, loaded automatically, adds the development
nginx container and mock sign-in; `compose.prod.yaml` is the production delta
behind the host-managed nginx), and both are started by the one launcher,
`node scripts/free.mjs <local|production>`.

## Quickstart

With Node.js 24, pnpm 10.9, Docker Desktop (Compose v2.24+), and `mkcert`
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
| `docker compose -f compose.yaml -f compose.override.yaml -f compose.entra.yaml up --build --watch` | Development against the real Entra tenant |

Inside the repository Dev Container (no Docker socket), `pnpm dev` starts the
services directly instead and serves **http://localhost:5173/free**.

Details, including host-run tooling and the Wi-Fi profile:
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
