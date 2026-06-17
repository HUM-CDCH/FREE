## Why

`main.py` has grown to ~708 lines that mix four unrelated concerns: app/config bootstrap, shared streaming infrastructure, shared parsing/PDF utilities, and four independent endpoint use cases (`/chat`, `/extract`, `/markdown`, `/generate-template`). Adding or changing one endpoint means scrolling past everything else, and there is no module boundary that tells a reader (or an AI agent) where a use case ends and shared plumbing begins. The `model_providers/` package already demonstrates the package pattern we want; the rest of the backend should follow it.

## What Changes

- Split `main.py` into per-use-case modules and shared modules, mirroring the existing `model_providers/` package layout.
- Introduce a `use_cases/` package with one module per endpoint, each exposing a FastAPI `APIRouter`:
  - `health` (`/healthz`), `chat` (`/chat`), `extract` (`/extract`), `markdown` (`/markdown`), `generate_template` (`/generate-template`).
  - Each module owns its endpoint handler **and** its event-generator (`chat_events`, `extract_events`, `markdown_events`, `generate_template_events`) plus any endpoint-local helpers (e.g. annotation parsing for `/generate-template`).
- Introduce a `shared/` package for cross-cutting code reused by more than one use case:
  - streaming/JSONL plumbing (`JsonLineEvent`, `JSONLResponse`, `STREAM_RESPONSES`, `JSONL_HEADERS`, `catch_model_errors`, `jsonl_response`, `jsonl_delta_events`),
  - the model-stream bridge (`call_model_stream` and provider access),
  - the `ThinkSplitter` reasoning router,
  - PDF/image helpers (`pages_to_jpeg`, `make_image_content`),
  - JSON parsing/repair and text helpers (`resolve_temperature`, `strip_code_fence`, `pretty_json_or_text`, `extract_answer_block`, `normalize_template`, `parse_result`, `quote_bare_hyphenated_numbers`, `parse_repaired_json_result`, `parse_json_object_result`).
- Extract configuration (`Settings`, `settings`) into a `config` module.
- Reduce `main.py` to a thin entry point: build the `FastAPI` app, configure CORS, define `lifespan`, register the use-case routers, and keep `main.app` resolvable so `uv run fastapi dev main.py` keeps working unchanged.
- Keep module boundaries clean enough to **e2e-test the full app while excluding the streaming and reasoning ("thinking") concerns** — i.e. streaming/JSONL emission and the `ThinkSplitter` live in isolated, substitutable modules so a full-app test can stub them and assert on the buffered result.
- Update the test suite with **minimal, mechanical edits only**: retarget the `patch.object(main, ...)` mocks to the new module locations (the patched boundary moves with the code). No behavioral assertion changes.
- No endpoint behavior, request/response shape, streaming contract, or configuration variable changes. This is a structural refactor only.

## Capabilities

### New Capabilities
- `backend-module-structure`: Defines how the backend source is organized — use-case modules vs. shared modules vs. a thin entry point — and the invariants that keep the refactor behavior-preserving (stable public import surface, no duplicated shared logic, endpoint registration via routers).

### Modified Capabilities
<!-- None. Endpoint behavior is unchanged; chat-endpoint spec requirements still hold verbatim. -->

## Impact

- **Code:** `prototypes/mine/backend/main.py` is split into new `config.py`, `shared/` package, and `use_cases/` package. No changes to the `model_providers/` package.
- **Runtime entry point (must stay stable):** `uv run fastapi dev main.py` / `uv run fastapi run main.py` must continue to resolve `app` from `main`.
- **Tests:** The 5 test files under `prototypes/mine/backend/tests/` get minimal mechanical edits — `import` lines and `patch.object(...)` targets are retargeted to the new module locations (e.g. `patch.object(use_cases.chat, "call_model_stream")`, `main.parse_json_object_result` → `shared.parsing.parse_json_object_result`). All behavioral assertions stay identical.
- **Dependencies:** None added or removed.
