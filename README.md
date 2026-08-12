# FREE

Document Extraction & Evaluation — shared team repo.

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
