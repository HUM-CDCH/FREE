# AGENTS.md

Guidance for coding agents working in this repository.

## Project Shape

FREE is a document extraction and evaluation prototype for humanities researchers. Use the terminology in `CONTEXT.md` and the architecture notes in `CLAUDE.md`.

The active prototype code is under:

- `prototypes/parsing_service` - FastAPI backend, Python 3.14+, managed with `uv`
- `prototypes/studio` - React/Vite frontend, managed with `pnpm`

We use a **pnpm workspace** to orchestrate commands across the monorepo from the root directory, though each prototype remains self-contained.

## Workspace Commands

Run commands from the workspace root:

```bash
pnpm install                   # Install dependencies across all packages
pnpm dev                       # Run backend and frontend dev servers concurrently
pnpm test                      # Run all backend and frontend tests recursively
pnpm build                     # Compile the frontend assets
```

## Local Prototype Commands

You can still run commands from the individual folders:

### Backend Commands (FastAPI + uv)

Always use `uv run` for backend Python commands so dependencies come from the project environment instead of the system Python.

```bash
cd prototypes/parsing_service
uv run python -m unittest discover -s tests
uv run fastapi dev main.py
uv run fastapi run main.py
```

Avoid running backend tests with bare `python -m unittest ...`; it may miss project dependencies such as `pydantic-settings` and `pypdfium2`.

### Frontend Commands (React + Vite + pnpm)

```bash
cd prototypes/studio
pnpm install
pnpm dev
pnpm build
pnpm lint
```
