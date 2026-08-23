# FREE agent guidance

- Do not preserve backward compatibility. Remove obsolete paths instead of
  adding compatibility layers, fallbacks, or migrations.

- Choose the simplest implementation that fully meets the current
  requirements. Avoid speculative abstractions, configuration, and
  indirection.

- Grow the system in layers. Start from the smallest version that works
  end to end, and add each new capability on top of a product that already
  works. Never trade a working product for unfinished complexity.

- Keep components modular and concerns clearly separated.

- Prefer established, well-maintained libraries when they reduce overall
  complexity or improve reliability. Do not reimplement common
  functionality without a clear reason.

- Lean on the dependencies already in the project before writing your own
  implementation or adding packages. Do not assume a library lacks a
  capability without checking its documentation and types.

- Make architectural decisions for the long term. Do not accept a stopgap
  that only works for now and is meant to be replaced later.

## Read only when relevant

- `CONTEXT.md`: product terminology and domain behavior.
- `CLAUDE.md`: repository architecture and operational details.
- `prototypes/studio/CLAUDE.md`: Studio-specific architecture.
- `openspec/changes/archive/2026-06-17-select-nuextract-control-channel/`:
  evidence behind NuExtract raw-prompt behavior.

Do not preload those files for unrelated work.

## Project shape

- `prototypes/parsing_service`: FastAPI, Python 3.13+, `uv`.
- `prototypes/studio`: React/Vite, `pnpm`.
- `packages/db`: PostgreSQL 17 schema and project store.

Run workspace commands from the repository root:

```bash
pnpm install
pnpm dev
pnpm test
pnpm build
```

Backend commands must use the selected `uv` environment:

```bash
cd prototypes/parsing_service
uv sync
uv run --no-sync python -m unittest discover -s tests
```

Frontend checks:

```bash
pnpm --filter studio test
pnpm --filter studio lint
pnpm --filter studio build
```

Database setup and destructive reset details live in `CLAUDE.md`. Never reset a
remote database or a local database not named `free`. Python workspaces expose
`install:python`; do not hardcode services in the root `postinstall`.

## NuExtract

Studio sends hand-built raw prompts to Ollama `/api/generate`. Only structured
mode has an `【instructions】` slot; template-generation and markdown guidance is
inline. Default non-thinking temperature is `0.2`. Read the archived evidence
above before changing prompt control tokens.

## CodeGraph

When `.codegraph/` exists, use `codegraph explore "<question>"` before grep or
file-by-file reading for code discovery. It returns relevant source and call
paths, including dynamic dispatch. Use `rg` for follow-up text searches.
