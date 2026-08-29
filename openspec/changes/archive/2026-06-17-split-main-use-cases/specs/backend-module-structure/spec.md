## ADDED Requirements

### Requirement: Each endpoint is an isolated use-case module

The backend SHALL expose a `use_cases/` package in which every HTTP endpoint lives in its own module, and each module SHALL own its route handler, its streaming event-generator, and any helpers used only by that endpoint. A use-case module MUST NOT import another use-case module.

#### Scenario: Endpoints are split one-per-module

- **WHEN** the backend package is inspected
- **THEN** `use_cases/health.py`, `use_cases/chat.py`, `use_cases/extract.py`, `use_cases/markdown.py`, and `use_cases/generate_template.py` each exist
- **AND** each module defining a route exposes a FastAPI `APIRouter`
- **AND** the `chat`, `extract`, `markdown`, and `generate_template` modules each contain their respective `*_events` generator

#### Scenario: Use cases do not depend on each other

- **WHEN** a use-case module's imports are examined
- **THEN** it imports only from `shared`, `config`, `model_providers`, and third-party packages
- **AND** it does not import from any other `use_cases.*` module

### Requirement: Shared code is centralized without duplication

Cross-cutting code reused by more than one use case SHALL live in a `shared/` package, and each piece of shared logic SHALL be defined exactly once. Configuration SHALL live in a dedicated `config` module.

#### Scenario: Shared plumbing is centralized

- **WHEN** the backend package is inspected
- **THEN** the JSONL streaming helpers (`JsonLineEvent`, `JSONLResponse`, `STREAM_RESPONSES`, `JSONL_HEADERS`, `catch_model_errors`, `jsonl_response`, `jsonl_delta_events`), the model-stream bridge (`call_model_stream`), the `ThinkSplitter`, the PDF/image helpers (`pages_to_jpeg`, `make_image_content`), and the JSON/text helpers (`resolve_temperature`, `strip_code_fence`, `pretty_json_or_text`, `extract_answer_block`, `normalize_template`, `parse_result`, `quote_bare_hyphenated_numbers`, `parse_repaired_json_result`, `parse_json_object_result`) are each defined in the `shared` package
- **AND** `Settings` and the `settings` instance are defined in a `config` module

#### Scenario: No shared symbol is defined twice

- **WHEN** the same shared helper is needed by multiple use cases
- **THEN** every use case imports it from `shared` (or `config`)
- **AND** no use-case module redefines a copy of that helper

### Requirement: `main.py` is a thin entry point

`main.py` SHALL only build the `FastAPI` application, configure middleware and `lifespan`, and register the use-case routers. It MUST NOT define endpoint handlers, event-generators, or shared utilities directly.

#### Scenario: main.py wires the app from modules

- **WHEN** `main.py` is read
- **THEN** it creates the `FastAPI` app, adds the CORS middleware, defines `lifespan`, and registers each use-case router (e.g. via `app.include_router(...)`)
- **AND** it contains no route-handler bodies, no `*_events` generators, and no parsing/PDF/streaming helper definitions

### Requirement: The runtime entry point stays stable

The refactor SHALL keep `main` resolvable as the application entry point so running the server requires no command or configuration change.

#### Scenario: Runtime entry point resolves the app

- **WHEN** `uv run fastapi dev main.py` (or `fastapi run main.py`) starts
- **THEN** `app` is importable from `main` and the server starts as before

### Requirement: Tests change only by retargeting moved symbols

When code moves out of `main`, the test suite SHALL be updated only by retargeting imports and `patch.object` targets to the symbols' new module locations. Behavioral assertions (expected events, results, status codes) MUST NOT change, and after the edits the full suite MUST pass.

#### Scenario: Patch targets follow the moved code

- **WHEN** a mocked boundary such as `call_model_stream` or `generate_template_events` is relocated to a use-case or shared module
- **THEN** the corresponding `patch.object(main, ...)` is retargeted to the module that now defines and calls it (e.g. `patch.object(use_cases.chat, "call_model_stream")`)
- **AND** the test's WHEN/THEN assertions are byte-for-byte unchanged

#### Scenario: Suite passes after retargeting

- **WHEN** `uv run python -m pytest` (or the project's test command) runs after the refactor
- **THEN** every test in `tests/` passes
- **AND** no test's expected output values were altered

### Requirement: Streaming and reasoning are substitutable for full-app tests

Streaming/JSONL emission and the reasoning ("thinking") splitter SHALL live in isolated modules so a full-app end-to-end test can exercise every endpoint while substituting or excluding those concerns and asserting on the buffered (`application/json`) result.

#### Scenario: Full-app test excludes streaming and thinking

- **WHEN** an end-to-end test drives the real `app` with the model boundary stubbed and requests buffered `application/json`
- **THEN** it can assert the final extraction/template/chat result without depending on per-delta streaming output or on reasoning-channel splitting
- **AND** the streaming helpers and the `ThinkSplitter` are importable and patchable as standalone modules independent of the use-case handlers

### Requirement: Endpoint behavior is preserved

The refactor SHALL NOT change any endpoint's request parameters, response shape, streaming/JSONL contract, status codes, or configuration variables.

#### Scenario: External contracts are unchanged

- **WHEN** any of `/healthz`, `/chat`, `/extract`, `/markdown`, or `/generate-template` is called after the refactor
- **THEN** it accepts the same inputs and produces the same JSON Lines (and buffered `application/json`) output as before the refactor
- **AND** the `NUEXTRACT3_*` configuration variables and their defaults are unchanged
