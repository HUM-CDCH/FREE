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

## Start the Prototype

FREE keeps its research state in PostgreSQL 17. Start the database, then set its
connection string. Do this once, from the repository root:

```bash
docker compose -f packages/db/docker-compose.yml up -d
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
