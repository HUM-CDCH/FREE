# AGENTS.md

Guidance for coding agents working in this repository.

## Project Shape

FREE is a document extraction and evaluation prototype for humanities researchers. Use the terminology in `CONTEXT.md` and the architecture notes in `CLAUDE.md`.

The active prototype code is under:

- `prototypes/parsing_service` - FastAPI backend, Python 3.13+, managed with `uv`
- `prototypes/studio` - React/Vite frontend, managed with `pnpm`

We use a **pnpm workspace** to orchestrate commands across the monorepo from the root directory, though each prototype remains self-contained.

## Workspace Commands

Run commands from the workspace root:

```bash
pnpm install                   # Install JS deps and run uv sync for Python services
pnpm start                     # Alias for pnpm dev
pnpm dev                       # Run backend and frontend dev servers concurrently
pnpm test                      # Run all backend and frontend tests recursively
pnpm build                     # Compile the frontend assets
```

Python services opt into root install by exposing an `install:python` script. Do not hardcode each service in the root `postinstall`; use the workspace-recursive hook.

## Local Prototype Commands

You can still run commands from the individual folders:

### Backend Commands (FastAPI + uv)

Always use `uv run` for backend Python commands so dependencies come from the project environment instead of the system Python.

```bash
cd prototypes/parsing_service
uv sync
uv run python -m unittest discover -s tests
uv run python -X utf8 -m fastapi dev main.py --host 127.0.0.1 --port 8000
uv run fastapi run main.py
```

Avoid running backend tests with bare `python -m unittest ...`; it may miss project dependencies such as `pydantic-settings` and `pypdfium2`.
Use UTF-8 mode for local FastAPI dev on Windows; the CLI emits Unicode and redirected output can fail under legacy code pages.

### Frontend Commands (React + Vite + pnpm)

```bash
cd prototypes/studio
pnpm install
pnpm dev
pnpm build
pnpm lint
```

## NuExtract Prompting

The frontend's model layer drives
NuExtract3 with **hand-built raw prompts** sent to Ollama's `/api/generate`
(`raw: true`), not `chat_template_kwargs`. The probe in
`tools/provider-control-probe-results.md` showed Ollama ignores those kwargs
(`mode`/`template`/`enable_thinking`), so the control tokens are reconstructed in
code to match `nuextract.template.jinja`. When editing prompts:

- Only `structured` mode has an `【instructions】` slot. `template-generation` and
  `markdown` carry all guidance inline in the message — lead with it.
- `enable_thinking` is valid only for `structured`/`content`; other modes always
  render the non-thinking `<think></think>` prompt.
- Default temperature is `0.2` (non-thinking, `NON_THINKING_TEMPERATURE`); leaving
  it unset lets Ollama apply ~0.8.

VS Code tasks should invoke the pnpm workspace scripts from the repository root, not duplicate `uv` or Vite command lines.
