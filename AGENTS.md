# AGENTS.md

Guidance for coding agents working in this repository.

## Project Shape

FREE is a document extraction and evaluation prototype for humanities researchers. Use the terminology in `CONTEXT.md` and the architecture notes in `CLAUDE.md`.

The active prototype code is under:

- `prototypes/parsing_service` - FastAPI backend, Python 3.14+, managed with `uv`
- `prototypes/mine/pdf-render` - React/Vite frontend, managed with `pnpm`

There is no shared monorepo toolchain; run commands from the relevant prototype directory.

## Backend Commands

Always use `uv run` for backend Python commands so dependencies come from the project environment instead of the system Python.

```bash
cd prototypes/mine/backend
uv run python -m unittest discover -s tests
uv run fastapi dev main.py
uv run fastapi run main.py
```

Avoid running backend tests with bare `python -m unittest ...`; it may miss project dependencies such as `pydantic-settings` and `pypdfium2`.

## Frontend Commands

Use `pnpm` from the frontend directory.

```bash
cd prototypes/mine/pdf-render
pnpm install
pnpm dev
pnpm build
pnpm lint
```
