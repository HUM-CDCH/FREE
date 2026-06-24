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

## NuExtract Prompting

The frontend's model layer (`prototypes/mine/pdf-render/api/_model.ts`) drives
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
