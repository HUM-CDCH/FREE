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
uv sync --extra ocr-cpu  # use ocr-gpu instead on CUDA hosts
uv run --no-sync python -m unittest discover -s tests
uv run --no-sync python -X utf8 -m fastapi dev main.py --host 127.0.0.1 --port 8000
uv run --no-sync fastapi run main.py
```

Use `uv run --no-sync` after selecting an OCR profile so normal dev/test commands do not replace a GPU environment with the CPU extra. Avoid running backend tests with bare `python -m unittest ...`; it may miss project dependencies such as `pydantic-settings` and `pypdfium2`.
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
(`raw: true`), not `chat_template_kwargs`. Historical control-channel evidence in
`openspec/changes/archive/2026-06-17-select-nuextract-control-channel/` showed Ollama ignores those kwargs
(`mode`/`template`/`enable_thinking`), so the control tokens are reconstructed in
code to match `nuextract.template.jinja`. When editing prompts:

- Only `structured` mode has an `【instructions】` slot. `template-generation` and
  `markdown` carry all guidance inline in the message — lead with it.
- `enable_thinking` is valid only for `structured`/`content`; other modes always
  render the non-thinking `<think></think>` prompt.
- Default temperature is `0.2` (non-thinking, `NON_THINKING_TEMPERATURE`); leaving
  it unset lets Ollama apply ~0.8.

VS Code tasks should invoke the pnpm workspace scripts from the repository root, not duplicate `uv` or Vite command lines.

## Agent skills

### Issue tracker

Issues are tracked as local markdown under `.scratch/<feature>/`. See
`docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels without overrides. See
`docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See
`docs/agents/domain.md`.


# Engineering Instructions

## Bounded execution

Optimize for the requested outcome, architectural coherence, and the smallest
complete solution. Diff size is not a goal; a correct change may touch much of
the repository.

Start with user-routed and directly relevant files. Expand when necessary to
understand dependencies, update affected call sites, complete migrations, or
verify correctness. Avoid repeated searches, speculative investigation, and
unrelated review.

Make reasonable assumptions for low-risk, reversible decisions. Investigate or
ask when ambiguity affects security, persistent data, destructive operations,
external systems, or the requested outcome materially.

## Action boundaries

Match actions to the request:

- For answers, reviews, diagnoses, or plans: inspect the relevant material and
  report the result. Do not modify code unless asked.
- For changes, builds, or fixes: make the requested in-scope local changes and
  run relevant non-destructive validation without asking first.
- Ask before destructive actions, external writes, production operations,
  purchases, or a material expansion of scope.

Creating or editing migrations is part of local implementation. Applying them
to shared, staging, or production systems requires explicit authorization.

## Prefer structural fixes

Do not optimize for a minimal diff when the existing design is the source of
the problem. Optimize for the smallest coherent end state.

When the requested outcome exposes broken abstractions, duplicated concepts,
invalid boundaries, accumulated compatibility layers, or misleading names,
restructure the affected system as broadly as necessary. This may include:

- Deleting or replacing APIs
- Changing schemas and data models
- Rewriting affected call sites
- Renaming concepts across the repository
- Moving responsibilities between modules
- Replacing implementations
- Adding or rewriting migrations
- Removing obsolete abstractions and dead code

Prefer one complete architectural correction over another local patch that
preserves the underlying problem.

Large changes are allowed when they are causally required by the requested
outcome. Judge scope by conceptual impact, not file count or diff size.

Do not use architectural cleanup as permission to rewrite unrelated systems.
If a broader redesign would be valuable but is not required for the current
outcome, leave it unchanged and mention it separately when material.

## Backwards compatibility

Do not preserve backwards compatibility by default.

If the clean solution requires a breaking change, make it within the requested
scope. Update all affected in-repository consumers, schemas, migrations, tests,
fixtures, and documentation so the repository finishes in a coherent state.

Do not add compatibility wrappers, aliases, deprecated paths, dual schemas,
fallback behavior, or parallel old and new implementations unless they are
explicitly required.

Report breaking changes plainly.

## Existing and adjacent issues

Do not assume existing issues are acceptable.

Fix issues that are within scope or block completion. Perform adjacent cleanup
when it is directly caused by the change or required for correctness, migration
completeness, conceptual consistency, or removal of newly dead code.

Leave unrelated issues unchanged. Mention them only when they are material to
the result or likely to affect the user’s next decision.

## Code size and clarity

Treat every additional line as maintenance cost.

Minimize net-new code. Prefer deletion, consolidation, and simplification when
they satisfy the same requirements. Do not introduce abstractions, extension
points, configuration options, or general-purpose infrastructure without a
current requirement.

Comments and doc comments should explain non-obvious intent, constraints,
tradeoffs, or reasoning—the why behind the code. Do not restate what the code
already makes clear. Leave obvious code uncommented.

## Completeness and validation

Complete the whole requested outcome, including all applicable:

- Implementation
- Call-site updates
- Schema and data migrations
- Tests
- Documentation
- Generated artifacts
- Cleanup caused by the change
- Verification

Use the smallest relevant validation set that provides confidence. Start with
targeted checks and broaden them when the risk, architectural reach, or shared
surface of the change warrants it.

Do not leave the repository in a knowingly transitional state unless the user
explicitly requests staged work. Do not leave dead paths, temporary adapters,
unused exports, stale tests, or documentation describing the replaced design.

If validation cannot be completed, state exactly what was not verified and why.

## Finish the whole ask, then stop

Completeness is measured against the requested outcome, not against everything
that could be improved nearby.

Once the requested outcome is complete, coherent, and verified, stop. Do not
continue adding robustness, options, abstractions, polish, or unrelated cleanup
that was not required.

Judge the work by the resulting system, not by the volume of code written. A
large rewrite can be the correct change, and deleting code is often the win.