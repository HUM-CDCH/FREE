# FREE

Document Extraction & Evaluation — shared team repo.

## Dev Container

Open the repository in a Dev Container to get Python 3.13, Node.js 24, pnpm
10.9, `uv`, and PostgreSQL 17. Dependencies are installed automatically when
the container is first created. Then initialize the database once and start
the application:

```bash
pnpm --filter db db:init
pnpm start
```

The Studio and Parsing Service ports are forwarded automatically. The database
is stored in a named Docker volume and is available to the workspace through
the preconfigured `DATABASE_URL`.

FREE-managed provider credentials use the Dev Container user's GNOME Keyring.
A Dev Container rebuild creates a fresh operating-system keyring, so enter any
managed credentials again after rebuilding.

## Run the whole stack in Docker

`compose.yaml` builds and runs all three services together: PostgreSQL 17, the
simple Docling Parsing Service, and Studio.

```bash
docker compose up --build
```

Studio then answers on <http://localhost:5173> and the Parsing Service on
<http://localhost:8000>. The Studio container applies the database migrations
for the current branch on every start, so no separate `db:init` is needed. To
open the example Source Documents, seed once the stack is healthy:

```bash
docker compose exec studio pnpm db:seed
```

For live Studio source updates from the host, opt in to the development
override and Compose Watch:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build --watch
```

The override syncs Studio's `api`, `src`, `shared`, and `public` directories,
plus the local database and export package sources used by Studio. It does not
bind-mount the repository, `node_modules`, or generated Prisma runtime files,
so Linux dependencies and generated artifacts stay inside the image. Changes
to dependencies, Docker configuration, or the database contract still require
rebuilding the Studio image. It also starts Vite with
`VITE_SHOW_DEVELOPER_UI=true` so developer tooling is visible.

Four named volumes hold the state that must outlive a container: the PostgreSQL
data directory, the Parsing Service task cache, its Docling model cache, and
Studio's `FREE Studio` data and config directories (canonical ingestion
packages, `model-config.json`, and the container keyring). Removing a volume
discards that state, so re-enter FREE-managed credentials after
`docker compose down --volumes`.

The Parsing Service follows Docling's NVIDIA container baseline and requires an
NVIDIA driver plus the NVIDIA container runtime. Compose exposes every GPU to
the container and selects `DOCLING_DEVICE=cuda`. Expect the first `--build` to
take a long time and a lot of disk: the service's `uv.lock` resolves the CUDA
build of torch, so the image carries the whole `nvidia-*` wheel set. The first
start then downloads the Docling layout and table models into the model-cache
volume, which takes several more minutes; its health check allows for that.
Later builds and starts reuse both caches.

Every published port binds to host loopback only. Studio's API has no
authentication, so this is a local run, not a hosted deployment.

## Run the prototype on the host

FREE keeps its research state in PostgreSQL 17. Start the database, then set its
connection string. Do this once, from the repository root:

```bash
docker compose up -d db
cp packages/db/.env.example packages/db/.env
pnpm install
pnpm --filter db db:init
```

Then start both servers:

```bash
pnpm start
```

`pnpm install` installs the workspace JavaScript dependencies, emits the database contract, and runs `uv sync` for Python services that expose `install:python`. `pnpm start` verifies that PostgreSQL matches the current branch before running the FastAPI parsing service on `http://127.0.0.1:8000` and the Vite studio on `http://localhost:5173`.

### Temporary LAN access

For a short session on a trusted private network, run `pnpm predev`, then start
the services in separate terminals:

```bash
pnpm --filter parsing-service dev
pnpm --filter studio dev --host 0.0.0.0
```

Allow inbound TCP port `5173` through the laptop firewall, then open
`http://<laptop-lan-ip>:5173` on the other device. Keep port `8000` private.

> **Warning:** Studio's API has no authentication. Anyone who can reach port
> `5173` can access project and model operations. Never use this on public Wi-Fi,
> expose it through router port forwarding, or treat it as a hosted deployment.

If a branch switch makes the disposable development database incompatible, reset it explicitly, restart the servers, then seed it again:

```bash
pnpm db:reset  # permanently deletes the local `free` database
pnpm start
pnpm db:seed   # run in a second terminal after the Parsing Service starts
```

`db:reset` refuses remote URLs and database names other than the local `free` default.

To open the example Source Documents, run `pnpm db:seed` in a second terminal while both servers run. The seed sends each example PDF to the parsing service.

See [CONTEXT.md](CONTEXT.md) for domain language and [docs/](docs/) for current
decisions and parsing contracts.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how we work together.
