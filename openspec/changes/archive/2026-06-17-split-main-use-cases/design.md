## Context

`prototypes/mine/backend/main.py` is ~708 lines holding four unrelated concerns: app/config bootstrap (`Settings`, `lifespan`, `app`, CORS), shared streaming plumbing (`JsonLineEvent`, `JSONLResponse`, `jsonl_response`, `jsonl_delta_events`, `catch_model_errors`, `call_model_stream`, `ThinkSplitter`), shared utilities (`pages_to_jpeg`, `make_image_content`, the JSON repair/parse helpers, `resolve_temperature`), and four endpoint use cases (`/chat`, `/extract`, `/markdown`, `/generate-template`), each with its own `*_events` generator. The sibling `model_providers/` package already shows the target pattern: a package of focused submodules with a re-exporting `__init__.py`.

Two constraints shape the design:

1. **The runtime entry point is `main:app`** — `uv run fastapi dev main.py` must keep resolving `app` from `main`.
2. **The tests mock by patching module attributes.** `patch.object(main, "call_model_stream", ...)` (chat, extract) and `patch.object(main, "generate_template_events", ...)` (generate-template) only affect code that resolves those names *on the patched module*. `test_extract` also reassigns `main.settings`. When the code moves, the patch target must move with it — Python rebinds a name in one module's namespace, not everywhere the function is referenced.

The change is purely structural: no endpoint contract, streaming format, or configuration variable changes.

## Goals / Non-Goals

**Goals:**
- One module per endpoint under `use_cases/`, each owning its router, handler, `*_events` generator, and endpoint-local helpers.
- A `shared/` package of focused, composable submodules for cross-cutting code, with each helper defined exactly once.
- Configuration isolated in `config.py`.
- `main.py` reduced to app wiring (app, CORS, `lifespan`, `include_router`) plus a small public re-export block.
- A clean dependency direction: `use_cases → {shared, config, model_providers}`; `shared → {config, model_providers}`; `main → {use_cases, shared, config}`. No cycles.
- Streaming and the reasoning splitter isolated as standalone modules so a full-app e2e test can stub the model boundary, request buffered `application/json`, and assert the final result without depending on streaming or thinking.
- Minimal, mechanical test edits: retarget the 9 `patch.object` calls (and add the corresponding module imports). No assertion changes.

**Non-Goals:**
- No change to any endpoint's request params, response shape, status codes, JSONL contract, or `NUEXTRACT3_*` config.
- No change to the `model_providers/` package.
- No new persistence, endpoints, or dependencies.
- Not rewriting the tests' assertions or adding new tests (a full-app e2e test is enabled by the structure but is out of scope for this change).

## Decisions

### Target layout

```
prototypes/mine/backend/
  main.py                 # app, CORS, lifespan, include_router; public re-exports
  config.py               # Settings, settings
  shared/
    __init__.py           # re-export the shared public API
    streaming.py          # JsonLineEvent, JSONLResponse, JSONL_HEADERS,
                          #   STREAM_RESPONSES, catch_model_errors,
                          #   jsonl_response, jsonl_delta_events
    model_stream.py       # bind_provider, get_model_provider, call_model_stream
    think_splitter.py     # ThinkSplitter
    pdf.py                # pages_to_jpeg, make_image_content
    parsing.py            # resolve_temperature, strip_code_fence,
                          #   pretty_json_or_text, extract_answer_block,
                          #   normalize_template, parse_result,
                          #   quote_bare_hyphenated_numbers,
                          #   parse_repaired_json_result, parse_json_object_result
  use_cases/
    __init__.py
    health.py             # GET /healthz
    chat.py               # POST /chat;  chat_events
    extract.py            # POST /extract;  extract_events
    markdown.py           # POST /markdown;  markdown_events
    generate_template.py  # POST /generate-template;  generate_template_events
                          #   + TEMPLATE_GUIDANCE, ANNOTATION_MODES,
                          #     TemplateAnnotation, parse_annotations, template_guidance
  model_providers/        # unchanged
```

**Why a package of submodules over one `shared.py`:** mirrors `model_providers/`, and the e2e goal needs `streaming` and `think_splitter` to be independently importable/patchable so a full-app test can exclude them.

### Each use case owns its router and is the patch target

Each use-case module exposes an `APIRouter`; `main.py` calls `app.include_router(...)` for each. The handler and its `*_events` generator live together in the module, and the generator imports `call_model_stream` from `shared.model_stream` **into its own namespace** and calls the local name. The route handler likewise calls its own module-level `generate_template_events`.

Consequence (the key design point): the test mocks move from `main` to the owning use-case module — `patch.object(use_cases.chat, "call_model_stream", ...)`, `patch.object(use_cases.extract, "call_model_stream", ...)`, `patch.object(use_cases.generate_template, "generate_template_events", ...)`. This is the natural target after the split and keeps the import graph acyclic (use cases never import `main`).

**Alternative considered — keep tests byte-for-byte:** would require use-case modules to resolve the boundary through `main` (deferred `import main`), creating a `main ↔ use_cases` cycle and defeating the clean boundary. Rejected per the agreed test-edit policy.

### `main.py` re-exports the plain-access public surface

`main.py` does `from config import Settings, settings`, `from shared.streaming import JsonLineEvent`, `from shared.pdf import pages_to_jpeg`, `from shared.parsing import parse_json_object_result`, and `from use_cases.chat import chat_events` / `from use_cases.extract import extract_events`. This keeps `main.settings`, `main.Settings`, `main.JsonLineEvent`, `main.pages_to_jpeg`, `main.parse_json_object_result`, `main.chat_events`, `main.extract_events` resolving for the tests' plain attribute reads (and `main.app` for the runtime), so only the `patch.object` lines change.

`test_extract` reassigns `main.settings` then starts the app; `lifespan` reads `settings` from `main`'s namespace, so the reassigned value drives provider creation as before. (The provider is unused in tests because `call_model_stream` is patched, but it must still construct cleanly.)

**Why re-exports rather than retargeting every `main.X`:** keeps the test diff to just the unavoidable patch targets, and a short, explicit re-export block documents the module's public API without bloating it.

### Provider access without a `main` import

`call_model_stream` currently reads `app.state.provider`. To keep `shared` free of any `main`/`app` import, `shared/model_stream.py` holds a module-level provider bound at startup: `bind_provider(provider)` / `get_model_provider()`. `main.lifespan` builds the `httpx.AsyncClient` and provider from `settings`, stores the provider on `app.state.provider` (unchanged) **and** calls `model_stream.bind_provider(provider)`. `call_model_stream` reads it via `get_model_provider()`.

**Alternatives considered:** (a) a FastAPI `Depends` injecting `request.app.state.provider` — rejected because the `*_events` generators are called directly in tests without a request/provider argument, so their signatures must stay as-is; (b) a `contextvars` holder — more machinery than needed for a single process-wide provider.

### `pages_to_jpeg` and `settings`

`pages_to_jpeg` reads `config.settings.pdf_dpi`. The one test that reassigns `main.settings` around a `pages_to_jpeg` call uses the default DPI (64), so reading `config.settings` yields identical behavior. No signature change.

## Risks / Trade-offs

- **A patch target is missed during the test edit** → the test would exercise the real (unbound-provider) path and fail loudly at the model call. Mitigation: retarget all 9 sites in one pass and run the suite; the failure mode is an obvious error, not a silent pass.
- **Import cycle introduced by accident** (e.g. a `shared` module importing a use case, or a use case importing `main`) → `ImportError` at startup. Mitigation: enforce the one-way dependency direction above; `main` is the only importer of `use_cases`.
- **`main` re-export drift** — if a future symbol the tests read isn't re-exported, attribute access breaks. Mitigation: the re-export block is small and explicit; the suite catches omissions immediately.
- **Provider binding ordering** — `call_model_stream` must not run before `lifespan` binds the provider. In practice requests only arrive after startup; `get_model_provider()` raises a clear error if called unbound. Tests patch `call_model_stream`, so they never hit the unbound path.

## Migration Plan

1. Add `config.py`; move `Settings`/`settings` there; re-export from `main`.
2. Add `shared/` submodules; move the cross-cutting helpers; add `shared/__init__.py` re-exports.
3. Add `use_cases/` modules; move each handler + its `*_events` generator + endpoint-local helpers; expose an `APIRouter` per module.
4. Reduce `main.py` to app/CORS/`lifespan`/`include_router` + the public re-export block; `lifespan` binds the provider into `shared.model_stream`.
5. Retarget the 9 `patch.object` calls (and add module imports) in the 3 endpoint test files.
6. Run the full test suite and start the dev server to confirm parity.

Rollback is a single revert of the refactor commit; no data or config migration is involved.
