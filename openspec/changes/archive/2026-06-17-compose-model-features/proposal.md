## Why

The primary goal is **testability**: a researcher's extraction and schema-suggestion runs must be exercisable as a deterministic, buffered call (assert a returned value, drive it from `/docs`) *and* as a streaming call where that matters — **both versions tested easily from one shared core**. The `split-main-use-cases` refactor left two things in the way. `shared/parsing.py` mixes pure text/JSON helpers with domain logic (the temperature policy `resolve_temperature`, and the NuExtract JSON-repair family), and streaming is hardwired into every use case — `ThinkSplitter` can only be driven through `streaming.jsonl_delta_events`, and `/extract` / `/generate-template` masquerade as streaming endpoints whose only consumer wants a single result. Making these concerns **injectable collaborators composed per use case** is what lets the buffered and streaming versions be tested cheaply and kept consistent.

## What Changes

- Introduce a single uniform `ModelCall` composition root over the model-call spine (`call_model_stream` → reasoning split → result parse), exposing two modes on **every** composed handler:
  - `collect()` — buffered: runs the spine and returns a value (the deterministic test / `/docs` seam).
  - `stream()` — streaming: yields `(think, output)` deltas.
  Production wires each endpoint to the mode it ships; tests can drive either, so both versions are testable and provably consistent.
- Compose the spine from injectable collaborators: a temperature policy, an optional reasoning splitter (`ThinkSplitter`), and a result parser. `ModelCall` is **stateless per request** (a per-request streamer holds the splitter).
- Separate pure parsing from domain logic: move the temperature rule into a `TemperaturePolicy` collaborator and the JSON-repair / structured-result family into result-parser strategies; `parsing.py` keeps only domain-agnostic helpers.
- Decouple `ThinkSplitter` from streaming: `streaming.py` no longer imports it and `model_call.py` imports no JSONL/transport types; reasoning-splitting runs over a fully buffered response too.
- **BREAKING** — `/extract`, `/generate-template`, and `/markdown` become non-streaming, returning a single plain JSON object (`200 application/json`). `/markdown` becomes a **single multi-page model call** (per the NuExtract3 model card) returning `{ markdown, pages }`, replacing the per-page `pages: string[]` stream. `/chat` is the only streaming endpoint.
- Model-side failures on the buffered endpoints map to **HTTP 502** (`detail` distinguishes an unreachable model from unparseable output, carrying `raw`); client-input validation stays **HTTP 400**.
- Frontend (`api.ts`, `App.tsx`, `useExtraction.ts`, `SchemaPanel` / results view): `requestExtraction` / `requestTemplate` become plain `fetch` + `response.json()`; the live build-up display is replaced by a working indicator plus the final `raw`; `jsonlStream.ts`'s `page_done` / `onPageDone` machinery and its tests are removed; `MarkdownDone` becomes `{ markdown, pages }`.
- Tests: retarget moved symbols; rewrite the now-buffered endpoints' assertions; add unit tests for the collaborators and a **consistency test** (same model output ⇒ `collect()` equals the accumulation of `stream()`).
- No change to extracted values, reasoning extraction, page counts, or `NUEXTRACT3_*` config — `/markdown`'s output shape is the one intended exception.

## Capabilities

### New Capabilities
- `model-call-composition`: how a use case composes the model-call spine from injectable collaborators (temperature policy, reasoning splitter, result parser) via a uniform `ModelCall` exposing buffered (`collect`) and streaming (`stream`) modes so both versions are independently testable; the separation of pure parsing from domain logic; and the per-endpoint response contract — `/extract`, `/generate-template`, `/markdown` non-streaming plain JSON, `/chat` streaming.

### Modified Capabilities
<!-- None. chat-endpoint is unchanged (/chat keeps streaming + buffered-JSON). /extract, /generate-template, /markdown have no existing main spec. -->

## Impact

- **Backend (`prototypes/mine/backend/`):** new `shared/` modules — `temperature.py`, `json_repair.py`, `result_parsers.py`, `model_call.py`; `parsing.py` slims to pure helpers; `streaming.py` becomes transport-only (no `ThinkSplitter`); `model_call.py` imports no transport types. `use_cases/extract.py`, `generate_template.py`, `markdown.py` return a plain `JSONResponse`; `chat.py` streams. `main.py` / `shared/__init__.py` re-exports updated.
- **HTTP (BREAKING):** three endpoints drop JSON Lines and advertise only `application/json`; `/markdown` output shape changes to `{ markdown, pages }`. `/chat` unchanged.
- **Frontend (`pdf-render/src/`):** non-streaming `requestExtraction` / `requestTemplate`; working-indicator UX in `App.tsx` / `useExtraction.ts`; `jsonlStream.ts` loses `page_done` support; `MarkdownDone` shape changes.
- **Tests:** buffered-endpoint assertions rewritten; OpenAPI-advertise test split (chat vs the rest); collaborator unit tests + the buffered/streaming consistency test added. No change to `model_providers/`.
- **Out of scope — tracked as follow-ups:** verify Ollama accepts the `image_url:{url}` base64 object shape (adapt in `OllamaProvider` if not) + add an image-content test; reconcile the `CLAUDE.md` ↔ `config.py` default-provider drift; the `template` → Schema Suggestion rename.
- **Dependencies:** none added or removed.
