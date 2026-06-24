## 1. Configuration module

- [x] 1.1 Create `config.py` and move `Settings` (with its `normalize_provider` validator) and the `settings = Settings()` instance into it.
- [x] 1.2 Confirm `config.py` has no FastAPI/app imports (it must be importable by `shared` and `use_cases` without cycles).

## 2. Shared package

- [x] 2.1 Create `shared/` package with an `__init__.py` that re-exports the shared public API.
- [x] 2.2 Create `shared/streaming.py`: move `JSONL_HEADERS`, `JsonLineEvent`, `JSONLResponse`, `STREAM_RESPONSES`, `catch_model_errors`, `jsonl_response`, and `jsonl_delta_events`.
- [x] 2.3 Create `shared/think_splitter.py`: move the `ThinkSplitter` class verbatim.
- [x] 2.4 Create `shared/model_stream.py`: move `call_model_stream`; replace the `app.state`-based `get_model_provider` with a module-level provider plus `bind_provider(provider)` / `get_model_provider()` (raising a clear error if unbound). Import `ChatContent`/`ModelProvider` from `model_providers`.
- [x] 2.5 Create `shared/pdf.py`: move `pages_to_jpeg` and `make_image_content`; have `pages_to_jpeg` read `config.settings.pdf_dpi`.
- [x] 2.6 Create `shared/parsing.py`: move `resolve_temperature`, `strip_code_fence`, `pretty_json_or_text`, `extract_answer_block`, `normalize_template`, `parse_result`, `quote_bare_hyphenated_numbers`, `parse_repaired_json_result`, and `parse_json_object_result`.
- [x] 2.7 Wire `jsonl_delta_events` to import `ThinkSplitter` from `shared.think_splitter` (no duplicate definitions across shared modules).

## 3. Use-case modules

- [x] 3.1 Create `use_cases/` package with `__init__.py`.
- [x] 3.2 Create `use_cases/health.py`: an `APIRouter` exposing `GET /healthz`.
- [x] 3.3 Create `use_cases/chat.py`: move `chat_events` and the `/chat` handler onto an `APIRouter`; import `call_model_stream` from `shared.model_stream` into this module's namespace and have `chat_events` call the local name.
- [x] 3.4 Create `use_cases/extract.py`: move `extract_events` and the `/extract` handler onto an `APIRouter`; import `call_model_stream` locally (same pattern as chat). Reuse `shared.pdf` and `shared.parsing` helpers.
- [x] 3.5 Create `use_cases/markdown.py`: move `markdown_events` and the `/markdown` handler onto an `APIRouter`.
- [x] 3.6 Create `use_cases/generate_template.py`: move `generate_template_events`, the `/generate-template` handler, and the endpoint-local helpers (`TEMPLATE_GUIDANCE`, `ANNOTATION_MODES`, `TemplateAnnotation`, `TEMPLATE_ANNOTATIONS`, `parse_annotations`, `template_guidance`) onto an `APIRouter`. The handler must call its own module-level `generate_template_events`.
- [x] 3.7 Verify no `use_cases/*` module imports another `use_cases/*` module or `main`.

## 4. Thin entry point

- [x] 4.1 Reduce `main.py` to: build the `FastAPI` app, add the CORS middleware, define `lifespan`, and `app.include_router(...)` for health, chat, extract, markdown, and generate_template.
- [x] 4.2 In `lifespan`, build the `httpx.AsyncClient` and provider from `settings`, store the provider on `app.state.provider` (unchanged) and call `shared.model_stream.bind_provider(provider)`.
- [x] 4.3 Add the public re-export block to `main.py`: `Settings`, `settings` (from `config`); `JsonLineEvent` (from `shared.streaming`); `pages_to_jpeg` (from `shared.pdf`); `parse_json_object_result` (from `shared.parsing`); `chat_events` (from `use_cases.chat`); `extract_events` (from `use_cases.extract`).
- [x] 4.4 Confirm `main.py` defines no route handlers, no `*_events` generators, and no parsing/PDF/streaming helpers.

## 5. Update tests (minimal, mechanical)

- [x] 5.1 `tests/test_chat_endpoint.py`: add `from use_cases import chat`; retarget the 3 `patch.object(main, "call_model_stream", ...)` calls to `patch.object(chat, "call_model_stream", ...)`. Leave all assertions unchanged.
- [x] 5.2 `tests/test_extract_endpoint.py`: add `from use_cases import extract`; retarget the 5 `patch.object(main, "call_model_stream", ...)` calls to `patch.object(extract, "call_model_stream", ...)`. Leave `main.settings`, `main.Settings`, `main.pages_to_jpeg`, `main.parse_json_object_result`, and assertions unchanged.
- [x] 5.3 `tests/test_generate_template_endpoint.py`: add `from use_cases import generate_template`; retarget `patch.object(main, "generate_template_events", ...)` to `patch.object(generate_template, "generate_template_events", ...)`.
- [x] 5.4 Confirm `tests/test_model_config.py` and `tests/test_model_providers.py` need no edits (they read `main.Settings` / `main.settings`, which remain re-exported).

## 6. Verify parity

- [x] 6.1 Run the full test suite and confirm every test passes with no assertion changes. (pytest is not installed; ran `uv run python -m unittest discover -s tests` — 32 passed, OK.)
- [x] 6.2 Confirm the app boots and `/healthz` responds. (Booted via `TestClient(main.app)`, which runs `lifespan`; `/healthz` → 200 `{"status":"ok"}`.)
- [x] 6.3 Smoke-test a streaming endpoint with `Accept: application/json` to confirm the buffered response is identical to before. (`POST /chat` with model stubbed → 200 `application/json`, buffered `[delta, done]` array as before.)
- [x] 6.4 Grep the new modules to confirm the one-way dependency direction holds (no `import main` in `shared`/`use_cases`; no cross-`use_cases` imports) and no shared helper is defined twice.
