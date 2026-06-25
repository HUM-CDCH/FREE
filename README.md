# FREE

Document Extraction & Evaluation — shared team repo.

## Start the Prototype

From the repository root:

```bash
pnpm install
pnpm start
```

`pnpm install` installs workspace JavaScript dependencies and runs `uv sync` for Python services that expose `install:python`. `pnpm start` runs the FastAPI parsing service on `http://127.0.0.1:8000` and the Vite studio on `http://localhost:5173`.

See [docs/](docs/) for vision, architecture, user workflows, and evaluation notes.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how we work together.
